import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AuthRequest } from '../../types';
import { writeLog } from '../logs/log.service';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import {
  getCRMModules,
  getCRMRecords,
  getCRMRecordById,
  updateCRMRecord,
  deleteCRMRecordLocal,
  createCRMRecordLocal,
} from './crm-record.service';
import { Connector } from '../connectors/connector.model';
import {
  pushCRMRecordUpdate,
  pushCRMRecordDelete,
  pushCRMRecordCreate,
} from '../connectors/connector.service';
import { searchMeili } from '../../services/meilisearch.service';
import { CRMRecord } from './crm-record.model';
import { Customer } from '../customers/customer.model';
import { NativeRecord } from '../native-crm/native-record.model';

function actor(req: AuthRequest) {
  return { userId: req.user?.userId, userEmail: req.user?.email, userRole: req.user?.role };
}

/** GET /crm/modules?channels=zoho,hubspot */
export async function listModules(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantId!;
    // Only return modules from currently active connectors
    const activeConnectors = await Connector.find({ tenantId, isActive: true }).select('type').lean();
    const activeChannels = activeConnectors.map((c) => c.type);
    const channelFilter = req.query.channels
      ? (req.query.channels as string).split(',').filter((ch) => activeChannels.includes(ch as typeof activeChannels[number]))
      : activeChannels;
    const data = await getCRMModules(tenantId, channelFilter.length > 0 ? channelFilter : ['__none__']);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/** GET /crm/:channel/:module?page=1&limit=100&search=xyz */
export async function listRecords(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantId!;
    const { channel, module } = req.params;
    const page   = parseInt(req.query.page   as string) || 1;
    const limit  = parseInt(req.query.limit  as string) || 100;
    const search = (req.query.search as string) || undefined;
    const result = await getCRMRecords(tenantId, channel, module, page, limit, search);
    res.json({ success: true, message: 'Success', ...result });
  } catch (err) {
    next(err);
  }
}

/** GET /crm/:channel/:module/:id */
export async function getRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const record = await getCRMRecordById(req.tenantId!, req.params.id);
    if (!record) { sendError(res, 'Record not found', 404); return; }
    sendSuccess(res, record);
  } catch (err) { next(err); }
}

/** PUT /crm/:channel/:module/:id  body: { changedData, displayName? } */
export async function updateRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { changedData, displayName } = req.body as {
      changedData: Record<string, unknown>;
      displayName?: string;
    };
    const record = await updateCRMRecord(req.tenantId!, req.params.id, changedData || {}, displayName);
    if (!record) { sendError(res, 'Record not found', 404); return; }
    sendSuccess(res, record, 'Record updated');
    writeLog({
      tenantId: req.tenantId!, service: 'backend', level: 'info',
      event:    'crm.record.manual_update',
      message:  `CRM record "${record.displayName}" updated manually [${record.channel}/${record.module}]`,
      metadata: {
        recordId: String(record._id), channel: record.channel, module: record.module,
        externalId: record.externalId, changedFields: Object.keys(changedData || {}),
        ...actor(req),
      },
    });
    pushCRMRecordUpdate(req.tenantId!, {
      externalId:  record.externalId,
      channel:     record.channel,
      module:      record.module,
      displayName: record.displayName,
      changedData: changedData || {},
    });
  } catch (err) { next(err); }
}

/** DELETE /crm/:channel/:module/:id */
export async function deleteRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const record = await deleteCRMRecordLocal(req.tenantId!, req.params.id);
    if (!record) { sendError(res, 'Record not found', 404); return; }
    sendSuccess(res, null, 'Record deleted');
    writeLog({
      tenantId: req.tenantId!, service: 'backend', level: 'warn',
      event:    'crm.record.manual_delete',
      message:  `CRM record "${record.displayName}" deleted [${record.channel}/${record.module}]`,
      metadata: {
        recordId: String(record._id), channel: record.channel, module: record.module,
        externalId: record.externalId, ...actor(req),
      },
    });
    pushCRMRecordDelete(req.tenantId!, {
      externalId: record.externalId,
      channel:    record.channel,
      module:     record.module,
      changedData: {},
    });
  } catch (err) { next(err); }
}

/** POST /crm/:channel/:module  body: { data, displayName } */
export async function createRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, displayName } = req.body as {
      data: Record<string, unknown>;
      displayName: string;
    };
    const { channel, module } = req.params;

    let externalId = await pushCRMRecordCreate(req.tenantId!, {
      externalId:  '',
      channel, module,
      displayName: displayName || '',
      changedData: data || {},
    });
    if (!externalId) externalId = `local_${Date.now()}`;

    const record = await createCRMRecordLocal(req.tenantId!, channel, module, externalId, displayName || '', data || {});
    sendCreated(res, record, 'Record created');
    writeLog({
      tenantId: req.tenantId!, service: 'backend', level: 'info',
      event:    'crm.record.manual_create',
      message:  `CRM record "${displayName || externalId}" created [${channel}/${module}]`,
      metadata: { channel, module, externalId, ...actor(req) },
    });
  } catch (err) { next(err); }
}

/** GET /crm/search?q=john+butt&limit=8
 *
 * Universal search: Customer model (Contacts/Leads) + CRMRecord (all modules).
 * Contacts/Leads always searched via MongoDB so they're never missed.
 * CRMRecord uses Meilisearch when available, MongoDB aggregation as fallback.
 */
export async function searchRecords(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantId!;
    const q     = (req.query.q as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string || '8', 10), 20);

    if (!q || q.length < 2) {
      sendSuccess(res, { results: [], query: q, total: 0 }, 'No query');
      return;
    }

    const tid  = new mongoose.Types.ObjectId(tenantId);
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const qRe  = { $regex: safe, $options: 'i' };

    // Resolve active connector channels once — used to filter all search paths
    const activeConnectors = await Connector.find({ tenantId, isActive: true }).select('type').lean();
    const activeChannels = activeConnectors.map((c) => c.type as string);
    // Always include organic/native channels that have no connector
    const ALWAYS_INCLUDE = ['native', 'web'];

    type HitRecord = {
      id: string; tenantId: string; channel: string; module: string;
      displayName: string; isSecondary: boolean; data: Record<string, string>;
    };

    // ── 1. Search Customer model — only from active connector channels ──
    const channelFilter = activeChannels.length > 0
      ? { $in: [...activeChannels, ...ALWAYS_INCLUDE, null] }
      : { $in: [...ALWAYS_INCLUDE, null] };

    const customers = await Customer.find({
      tenantId: tid,
      channel: channelFilter,
      $or: [{ name: qRe }, { email: qRe }, { phone: qRe }, { company: qRe }, { address: qRe }],
    }).select('name email phone company address leadSource channel recordType customFields').limit(limit).lean();

    const customerHits: HitRecord[] = customers.map((c) => ({
      id:          String(c._id),
      tenantId,
      channel:     (c.channel as string) || 'web',
      module:      c.recordType === 'lead' ? 'Leads' : 'Contacts',
      displayName: c.name,
      isSecondary: false,
      data: {
        ...(c.email      ? { Email:      c.email }      : {}),
        ...(c.phone      ? { Phone:      c.phone }      : {}),
        ...(c.company    ? { Company:    c.company }    : {}),
        ...(c.address    ? { Address:    c.address }    : {}),
        ...(c.leadSource ? { LeadSource: c.leadSource } : {}),
        ...(c.customFields as Record<string, string> || {}),
      },
    }));

    // ── 2. Search CRMRecord via Meilisearch (or MongoDB fallback) ──
    //    Pass activeChannels so Meilisearch filters out disconnected connector data
    let crmHits: HitRecord[] = [];

    const meiliHits = await searchMeili(tenantId, q, limit, activeChannels);
    if (meiliHits !== null) {
      crmHits = meiliHits.map((h) => ({
        id: h.id, tenantId, channel: h.channel, module: h.module,
        displayName: h.displayName, isSecondary: h.isSecondary, data: h.data,
      }));
    } else {
      const SECONDARY = /note|task|call|log|history|activity|event|feed|inbox|audit|trail|macro|webform|campaign/i;
      const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const words = q.split(/\s+/).map(esc).filter((w) => w.length >= 2);
      const perWord = words.map((w) => ({
        $or: [{ displayName: { $regex: w, $options: 'i' } }, { '_dataArr.v': { $regex: w, $options: 'i' } }],
      }));
      const match = perWord.length === 1 ? perWord[0] : { $and: perWord };

      // MongoDB fallback also filters by active channels
      const baseMatch: Record<string, unknown> = { tenantId: tid };
      if (activeChannels.length > 0) {
        baseMatch.channel = { $in: [...activeChannels, ...ALWAYS_INCLUDE] };
      }

      const records = await CRMRecord.aggregate([
        { $match: baseMatch },
        { $addFields: { _dataArr: { $objectToArray: '$data' } } },
        { $match: match },
        { $addFields: { isSecondary: { $cond: [{ $regexMatch: { input: '$module', regex: SECONDARY } }, true, false] } } },
        { $sort: { isSecondary: 1 } },
        { $project: { channel: 1, module: 1, displayName: 1, data: 1, isSecondary: 1 } },
        { $limit: limit },
      ]);

      crmHits = records.map((r) => ({
        id: String(r._id), tenantId, channel: r.channel, module: r.module,
        displayName: r.displayName, isSecondary: r.isSecondary,
        data: Object.fromEntries(Object.entries(r.data as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
      }));
    }

    // ── 3. Search Native CRM records ─────────────────────────────────────────
    const nativeRecords = await NativeRecord.find({
      tenantId: tid,
      displayName: { $regex: safe, $options: 'i' },
    }).limit(limit).lean();

    const nativeHits: HitRecord[] = nativeRecords.map((r) => ({
      id:          String(r._id),
      tenantId,
      channel:     'native',
      module:      r.module,
      displayName: r.displayName,
      isSecondary: false,
      data:        Object.fromEntries(
        Object.entries((r.fields as Record<string, unknown>) || {}).map(([k, v]) => [k, String(v ?? '')])
      ),
    }));

    // ── 4. Merge: customers first, then CRM records, native CRM — deduplicate ──
    const seen = new Set<string>();
    const all = [...customerHits, ...crmHits, ...nativeHits].filter((r) => {
      const key = `${r.channel}|${r.module}|${r.displayName.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);

    sendSuccess(res, { results: all, query: q, total: all.length }, 'Search results');
  } catch (err) {
    next(err);
  }
}
