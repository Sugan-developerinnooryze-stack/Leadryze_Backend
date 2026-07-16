import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Tenant } from '../tenants/tenant.model';
import { Connector } from '../connectors/connector.model';
import { Customer } from '../customers/customer.model';
import { CRMRecord } from '../crm/crm-record.model';
import { searchMeili, indexCRMRecords, isMeiliSearchEnabled } from '../../services/meilisearch.service';
import { Template } from '../templates/template.model';
import { QnAPair } from '../bot/qna.model';
import { ChatSession } from '../bot/chat-session.model';
import { AIAction } from '../bot/ai-action.model';
import { sendSuccess, sendError } from '../../utils/response';
import { config } from '../../config';
import { writeLog } from '../logs/log.service';
import { logSecurityEvent } from '../logs/security-event.model';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { Activity } from '../activities/activity.model';
import { AutomationRun } from '../automation/automation-run.model';

const router = Router();

/* ── Service-to-service auth ─────────────────────────────────────── */
function requireServiceKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-internal-key'];
  if (!key || key !== config.ai.internalServiceKey) {
    sendError(res, 'Unauthorized internal service call', 401);
    return;
  }
  next();
}

router.use(requireServiceKey);

/**
 * GET /api/internal/tenant-context/:tenantId
 *
 * Returns everything the AI needs to build rich per-tenant context:
 *   - Tenant branding + AI config (systemPrompt, agentName, language)
 *   - Active connectors (type + sync status)
 *   - CRM module summary grouped by channel
 *   - 20 most recent customers (pipeline snapshot)
 *   - Active message templates
 */
router.get('/tenant-context/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;

    if (!mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Invalid tenantId', 400);
      return;
    }

    const tid = new mongoose.Types.ObjectId(tenantId);

    const [tenant, connectors, recentCustomers, templates, crmModules, customerCounts, qnaPairs] = await Promise.all([
      Tenant.findById(tid).select('name slug plan settings branding aiConfig'),

      Connector.find({ tenantId: tid, isActive: true })
        .select('type name isActive lastSyncAt syncStatus'),

      Customer.find({ tenantId: tid })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('name email phone status channel recordType tags intent lastContactedAt createdAt'),

      Template.find({ tenantId: tid, isActive: true })
        .select('name type category subject body variables')
        .limit(20),

      CRMRecord.aggregate([
        { $match: { tenantId: tid } },
        { $group: { _id: { channel: '$channel', module: '$module' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Customer collection (contacts + leads) grouped by channel and recordType
      // These are stored separately from CRMRecord but the AI needs their real counts
      Customer.aggregate([
        { $match: { tenantId: tid } },
        { $group: {
          _id: { channel: '$channel', recordType: '$recordType' },
          count: { $sum: 1 },
        }},
      ]),

      QnAPair.find({ tenantId: tid, isActive: true })
        .select('question answer category')
        .limit(100),
    ]);

    if (!tenant) {
      sendError(res, 'Tenant not found', 404);
      return;
    }

    // Build CRM module map — ONLY from active connector channels
    // Orphaned records from disconnected connectors are excluded here
    const activeChannelSet = new Set(connectors.map((c) => c.type as string));
    const crmModuleMap: Record<string, Array<{ module: string; count: number }>> = {};
    for (const row of crmModules) {
      const ch = row._id.channel as string;
      if (!activeChannelSet.has(ch)) continue; // skip disconnected connector data
      if (!crmModuleMap[ch]) crmModuleMap[ch] = [];
      crmModuleMap[ch].push({ module: row._id.module as string, count: row.count as number });
    }

    // Merge Customer collection counts (Contacts + Leads) into the module map.
    // CRM connectors (HubSpot/Salesforce/Zoho) sync contacts to the Customer collection,
    // not CRMRecord — so without this, the AI would show stale/wrong contact counts.
    for (const row of customerCounts) {
      const ch  = (row._id.channel as string) || 'web';
      const mod = (row._id.recordType as string) === 'lead' ? 'Leads' : 'Contacts';
      const cnt = row.count as number;
      if (!crmModuleMap[ch]) crmModuleMap[ch] = [];
      const existing = crmModuleMap[ch].find((m) => m.module === mod);
      if (!existing) {
        crmModuleMap[ch].push({ module: mod, count: cnt });
      } else {
        // Use the higher count — Customer collection is always the authoritative source
        existing.count = Math.max(existing.count, cnt);
      }
    }

    // Inline records removed — AI now uses /crm-search for dynamic per-query lookup.
    // This keeps the tenant-context response small (~5KB vs 89KB) and avoids
    // injecting wrong-connector data into every prompt.
    const inlineRecords: Record<string, never[]> = {};

    sendSuccess(res, {
      tenant: {
        id: tenant._id,
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        settings: tenant.settings,
        branding: tenant.branding,
        aiConfig: tenant.aiConfig,
      },
      connectors: connectors.map((c) => ({
        type: c.type,
        name: c.name,
        isActive: c.isActive,
        lastSyncAt: c.lastSyncAt,
        syncStatus: c.syncStatus,
      })),
      recentCustomers: recentCustomers.map((c) => ({
        name: c.name,
        email: c.email,
        phone: c.phone,
        status: c.status,
        channel: c.channel,
        recordType: c.recordType,
        tags: c.tags,
        intent: c.intent,
        lastContactedAt: c.lastContactedAt,
        daysAgo: c.lastContactedAt
          ? Math.floor((Date.now() - new Date(c.lastContactedAt as Date).getTime()) / 86400000)
          : null,
      })),
      crmModules: crmModuleMap,
      inlineRecords,
      templates: templates.map((t) => ({
        name: t.name,
        type: t.type,
        category: t.category,
        subject: t.subject,
        body: t.body,
        variables: t.variables,
      })),
      qnaPairs: qnaPairs.map((q) => ({
        question: q.question,
        answer: q.answer,
        category: q.category,
      })),
    }, 'Tenant context fetched');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/internal/crm-records/:tenantId/:channel/:module
 *
 * Returns up to 50 CRM records for a specific connector+module combination.
 * Used by AI to answer queries like "show me our top accounts from Salesforce".
 */
// Modules that live in the Customer collection, not CRMRecord
const CUSTOMER_MODULES = new Set(['contacts', 'leads', 'contact', 'lead']);

router.get('/crm-records/:tenantId/:channel/:module', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, channel, module: mod } = req.params;

    if (!mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Invalid tenantId', 400);
      return;
    }

    const tid   = new mongoose.Types.ObjectId(tenantId);
    const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
    const search = req.query.search as string | undefined;

    // Contacts and Leads are stored in the Customer collection (not CRMRecord).
    // CRM connectors (HubSpot, Salesforce, Zoho) and external DBs that sync contacts
    // all write to Customer model. Query it directly so AI gets the real data.
    if (CUSTOMER_MODULES.has(mod.toLowerCase())) {
      const isLead = mod.toLowerCase() === 'lead' || mod.toLowerCase() === 'leads';
      const custQuery: Record<string, unknown> = { tenantId: tid };

      // Match the connector channel — "hubspot", "salesforce", "zoho", "mysql", etc.
      // channel "all" means search across all connectors
      if (channel !== 'all') custQuery.channel = channel;

      // Filter by record type
      custQuery.recordType = isLead ? 'lead' : { $ne: 'lead' };

      if (search) {
        const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        custQuery.$or = [
          { name: { $regex: safe, $options: 'i' } },
          { email: { $regex: safe, $options: 'i' } },
          { company: { $regex: safe, $options: 'i' } },
        ];
      }

      const customers = await Customer.find(custQuery)
        .select('name email phone company address status leadSource channel recordType customFields')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      const records = customers.map((c) => ({
        externalId:  String(c._id),
        displayName: c.name,
        data: {
          ...(c.email      ? { Email:       c.email }      : {}),
          ...(c.phone      ? { Phone:       c.phone }      : {}),
          ...(c.company    ? { Company:     c.company }    : {}),
          ...(c.status     ? { Status:      c.status }     : {}),
          ...(c.address    ? { Address:     c.address }    : {}),
          ...(c.leadSource ? { Lead_Source: c.leadSource } : {}),
          ...((c.customFields as Record<string, unknown>) || {}),
        },
        syncedAt: c._id.getTimestamp(),
      }));

      sendSuccess(res, records, 'Customer records fetched');
      return;
    }

    // Default: query CRMRecord (Companies, Deals, Products, Tasks, and all external DB tables)
    const query: Record<string, unknown> = { tenantId: tid, channel, module: mod };
    if (search) {
      query.displayName = { $regex: search, $options: 'i' };
    }

    const records = await CRMRecord.find(query)
      .select('externalId displayName data syncedAt')
      .sort({ syncedAt: -1 })
      .limit(limit);

    sendSuccess(res, records, 'CRM records fetched');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/internal/crm-search/:tenantId?q=2gb+ram&limit=5
 *
 * Cross-module, cross-channel search. Searches Customer model (Contacts/Leads)
 * via MongoDB first, then CRMRecord via Meilisearch (or MongoDB fallback).
 * Results are merged with Contacts/Leads always appearing first.
 */
router.get('/crm-search/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;
    if (!mongoose.isValidObjectId(tenantId)) { sendError(res, 'Invalid tenantId', 400); return; }
    const q     = (req.query.q as string || '').trim();
    const limit = Math.min(parseInt((req.query.limit as string) || '6', 10), 20);
    if (!q) { sendSuccess(res, [], 'No query'); return; }

    const tid  = new mongoose.Types.ObjectId(tenantId);
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const qRe  = { $regex: safe, $options: 'i' };

    // 1. Always search Customer model (Contacts + Leads) — never missed
    const customers = await Customer.find({
      tenantId: tid,
      $or: [{ name: qRe }, { email: qRe }, { phone: qRe }, { company: qRe }, { address: qRe }],
    }).select('name email phone company address leadSource channel recordType customFields').limit(limit).lean();

    const customerRecords = customers.map((c) => ({
      channel:     (c.channel as string) || 'web',
      module:      c.recordType === 'lead' ? 'Leads' : 'Contacts',
      displayName: c.name,
      data: {
        ...(c.email      ? { Email:      c.email }      : {}),
        ...(c.phone      ? { Phone:      c.phone }      : {}),
        ...(c.company    ? { Company:    c.company }    : {}),
        ...(c.address    ? { Address:    c.address }    : {}),
        ...(c.leadSource ? { LeadSource: c.leadSource } : {}),
        ...(c.customFields as Record<string, unknown> || {}),
      },
    }));

    // 2. Search CRMRecord via Meilisearch (or MongoDB fallback)
    let crmRecords: Array<{ channel: string; module: string; displayName: string; data: Record<string, unknown> }> = [];

    const meiliHits = await searchMeili(tenantId, q, limit);
    if (meiliHits !== null) {
      crmRecords = meiliHits.map((h) => ({
        channel: h.channel, module: h.module, displayName: h.displayName, data: h.data,
      }));
    } else {
      const escapeWord = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const words = q.split(/\s+/).map(escapeWord).filter(w => w.length >= 2);
      if (words.length) {
        const perWordConds = words.map((w) => ({
          $or: [
            { displayName: { $regex: w, $options: 'i' } },
            { '_dataArr.v': { $regex: w, $options: 'i' } },
          ],
        }));
        const searchMatch = perWordConds.length === 1 ? perWordConds[0] : { $and: perWordConds };
        const SECONDARY = /note|task|call|log|history|activity|event|feed|inbox|audit|trail|macro|webform|campaign/i;

        const records = await CRMRecord.aggregate([
          { $match: { tenantId: tid } },
          { $addFields: { _dataArr: { $objectToArray: '$data' } } },
          { $match: searchMatch },
          { $addFields: { _priority: { $cond: [{ $regexMatch: { input: '$module', regex: SECONDARY } }, 2, 1] } } },
          { $sort: { _priority: 1 } },
          { $project: { channel: 1, module: 1, displayName: 1, data: 1 } },
          { $limit: limit },
        ]);

        crmRecords = records.map((r) => ({
          channel: r.channel, module: r.module, displayName: r.displayName, data: r.data,
        }));
      }
    }

    // 3. Merge: customers first, then CRM records, deduplicate
    const seen = new Set<string>();
    const all = [...customerRecords, ...crmRecords].filter((r) => {
      const key = `${r.channel}|${r.module}|${r.displayName.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);

    sendSuccess(res, all, `Found ${all.length} record(s) for "${q}"`);
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/sync-status/:tenantId
 *
 * Shows exactly what data is in CRMRecord for a tenant.
 * Use this to debug why the chatbot can't find data.
 */
router.get('/sync-status/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;
    if (!mongoose.isValidObjectId(tenantId)) { sendError(res, 'Invalid tenantId', 400); return; }

    const tid = new mongoose.Types.ObjectId(tenantId);

    const [connectors, modules, sampleRecords] = await Promise.all([
      Connector.find({ tenantId: tid }).select('type name isActive syncStatus lastSyncAt syncError'),
      CRMRecord.aggregate([
        { $match: { tenantId: tid } },
        { $group: { _id: { channel: '$channel', module: '$module' }, count: { $sum: 1 }, lastSynced: { $max: '$syncedAt' } } },
        { $sort: { '_id.channel': 1, '_id.module': 1 } },
      ]),
      CRMRecord.find({ tenantId: tid }).sort({ syncedAt: -1 }).limit(3).select('channel module displayName data'),
    ]);

    const isEmpty = modules.length === 0;

    sendSuccess(res, {
      isEmpty,
      connectors: connectors.map((c) => ({
        type: c.type, name: c.name, isActive: c.isActive,
        syncStatus: c.syncStatus, lastSyncAt: c.lastSyncAt, syncError: c.syncError,
      })),
      crmModules: modules.map((m) => ({
        channel: m._id.channel, module: m._id.module, count: m.count, lastSynced: m.lastSynced,
      })),
      sampleRecords: sampleRecords.map((r) => ({
        channel: r.channel, module: r.module, displayName: r.displayName,
        sampleData: Object.fromEntries(Object.entries(r.data as Record<string, unknown>).slice(0, 5)),
      })),
      diagnosis: isEmpty
        ? 'CRMRecord is empty — connector is connected but has never been synced. Go to Connectors and click Sync.'
        : `${modules.length} module(s) synced across ${[...new Set(modules.map((m) => m._id.channel))].join(', ')}. Data is available.`,
    }, 'Sync status');
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/chat-session
 * Upserts a chat session and appends messages.
 */
router.post('/chat-session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, sessionId, role, content, metadata, visitorName, visitorEmail, visitorPhone, escalated } = req.body as {
      tenantId: string; sessionId: string; role: 'user' | 'assistant';
      content: string; metadata?: Record<string, unknown>;
      visitorName?: string; visitorEmail?: string; visitorPhone?: string; escalated?: boolean;
    };
    if (!tenantId || !sessionId || !role || !content) {
      sendError(res, 'tenantId, sessionId, role, content are required', 400);
      return;
    }
    const msg = { role, content, timestamp: new Date(), metadata };
    const setFields: Record<string, unknown> = {};
    if (visitorName)  setFields.visitorName  = visitorName;
    if (visitorEmail) setFields.visitorEmail = visitorEmail;
    if (visitorPhone) setFields.visitorPhone = visitorPhone;
    if (escalated)    setFields.escalated    = true;

    await ChatSession.findOneAndUpdate(
      { sessionId },
      {
        $push: { messages: msg },
        ...(Object.keys(setFields).length ? { $set: setFields } : {}),
        $setOnInsert: { tenantId: new mongoose.Types.ObjectId(tenantId), sessionId, channel: 'web' },
      },
      { upsert: true, new: true }
    );
    sendSuccess(res, null, 'Chat session updated');
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/security-event
 * Called by AI service to log a security event (e.g. prompt injection detected).
 */
router.post('/security-event', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event, tenantId, ip, userAgent, detail } = req.body as {
      event: string; tenantId?: string; ip?: string; userAgent?: string;
      detail?: Record<string, unknown>;
    };
    if (!event) { sendError(res, 'event is required', 400); return; }
    await logSecurityEvent(event as Parameters<typeof logSecurityEvent>[0], { tenantId, ip, userAgent, detail });
    sendSuccess(res, null, 'Security event logged');
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/logs
 * Called by AI service to persist an activity log entry in MongoDB.
 */
router.post('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, service, level, event, message, metadata, sessionId } = req.body as {
      tenantId: string; service?: string; level?: string;
      event: string; message: string;
      metadata?: Record<string, unknown>; sessionId?: string;
    };

    if (!tenantId || !event || !message) {
      sendError(res, 'tenantId, event and message are required', 400);
      return;
    }

    await writeLog({
      tenantId,
      service:   (service as 'ai' | 'backend') || 'ai',
      level:     (level   as 'info' | 'warn' | 'error' | 'debug') || 'info',
      event,
      message,
      metadata,
      sessionId,
    });

    sendSuccess(res, null, 'Log written');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/internal/send-email
 * Called by AI agent to send an email action (e.g. "send followup email to customer").
 */
router.post('/send-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { toEmail, toName, subject, body } = req.body as {
      toEmail: string; toName?: string; subject: string; body: string;
    };
    if (!toEmail || !subject || !body) {
      sendError(res, 'toEmail, subject, body are required', 400);
      return;
    }
    const messageId = await sendEmailNow({ to: toEmail, toName, subject, htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px">${body.replace(/\n/g, '<br/>')}</div>` });
    sendSuccess(res, { messageId }, 'Email sent');
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/reindex-meilisearch/:tenantId
 *
 * Bulk-indexes ALL existing CRMRecords AND Customer records into Meilisearch.
 * Run this once after starting Meilisearch for the first time, or after a reset.
 */
router.post('/reindex-meilisearch/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;
    if (!mongoose.isValidObjectId(tenantId)) { sendError(res, 'Invalid tenantId', 400); return; }
    if (!isMeiliSearchEnabled()) { sendError(res, 'Meilisearch is not configured', 503); return; }

    const tid = new mongoose.Types.ObjectId(tenantId);
    const BATCH = 200;
    let total = 0;

    // ── Index CRMRecord (Meetings, Deals, Notes, Tasks, etc.) ──
    let skip = 0;
    for (;;) {
      const batch = await CRMRecord.find({ tenantId: tid })
        .select('channel module externalId displayName data')
        .skip(skip).limit(BATCH).lean();
      if (batch.length === 0) break;
      await indexCRMRecords(batch.map((r) => ({
        tenantId,
        channel:     r.channel,
        module:      r.module,
        externalId:  r.externalId,
        displayName: r.displayName,
        data:        r.data as Record<string, unknown>,
      })));
      total += batch.length;
      skip  += BATCH;
      if (batch.length < BATCH) break;
    }

    // ── Index Customer records (Contacts + Leads) — ALL fields including customFields ──
    skip = 0;
    for (;;) {
      const batch = await Customer.find({ tenantId: tid })
        .select('name email phone company address leadSource channel recordType customFields')
        .skip(skip).limit(BATCH).lean();
      if (batch.length === 0) break;
      await indexCRMRecords(batch.map((c) => ({
        tenantId,
        channel:     (c.channel as string) || 'web',
        module:      c.recordType === 'lead' ? 'Leads' : 'Contacts',
        externalId:  String(c._id),
        displayName: c.name,
        data: {
          ...(c.email      ? { Email:      c.email }      : {}),
          ...(c.phone      ? { Phone:      c.phone }      : {}),
          ...(c.company    ? { Company:    c.company }    : {}),
          ...(c.address    ? { Address:    c.address }    : {}),
          ...(c.leadSource ? { LeadSource: c.leadSource } : {}),
          // Spread ALL Zoho/HubSpot/Salesforce CRM fields (title, twitter, skype, address, etc.)
          ...(c.customFields as Record<string, unknown> || {}),
        },
      })));
      total += batch.length;
      skip  += BATCH;
      if (batch.length < BATCH) break;
    }

    sendSuccess(res, { indexed: total }, `Re-indexed ${total} records into Meilisearch`);
  } catch (err) { next(err); }
});

/* ── GET /api/internal/activities?tenantId=&type=&limit= — AI lists activities ── */
router.get('/activities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, type, limit } = req.query as Record<string, string>;
    if (!tenantId || !mongoose.isValidObjectId(tenantId)) { sendError(res, 'Invalid tenantId', 400); return; }
    const tid   = new mongoose.Types.ObjectId(tenantId);
    const lim   = Math.min(parseInt(limit || '10', 10), 50);
    const query: Record<string, unknown> = { tenantId: tid };
    if (type) query.type = type;
    const items = await Activity.find(query).sort({ startDate: -1, createdAt: -1 }).limit(lim)
      .select('_id type title startDate endDate status linkedPerson');
    sendSuccess(res, items, 'Activities fetched');
  } catch (err) { next(err); }
});

/* ── PUT /api/internal/activity/:id — AI updates an existing activity (reschedule) ── */
router.put('/activity/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { tenantId, startDate, endDate, title, status, linkedPerson } = req.body as {
      tenantId: string; startDate?: string; endDate?: string; title?: string; status?: string;
      linkedPerson?: { displayName: string; email?: string; phone?: string; module?: string; channel?: string };
    };
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Invalid id or tenantId', 400); return;
    }
    const set: Record<string, unknown> = {};
    if (startDate)    set.startDate    = new Date(startDate);
    if (endDate)      set.endDate      = new Date(endDate);
    if (title)        set.title        = title;
    if (status)       set.status       = status;
    if (linkedPerson) set.linkedPerson = linkedPerson;
    await Activity.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), tenantId: new mongoose.Types.ObjectId(tenantId) },
      { $set: set }
    );
    sendSuccess(res, null, 'Activity updated');
  } catch (err) { next(err); }
});

/* ── POST /api/internal/create-activity — AI creates a calendar activity (meeting, task, etc.) ── */
router.post('/create-activity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, type, title, startDate, endDate, notes, linkedPerson } = req.body as {
      tenantId: string; type: string; title: string;
      startDate?: string; endDate?: string; notes?: string;
      linkedPerson?: { displayName: string; email?: string; phone?: string; module?: string; channel?: string; };
    };
    if (!tenantId || !type || !title) {
      sendError(res, 'tenantId, type, title are required', 400);
      return;
    }
    const doc = await Activity.create({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      type,
      title,
      status: 'pending',
      startDate: startDate ? new Date(startDate) : undefined,
      endDate:   endDate   ? new Date(endDate)   : undefined,
      notes,
      linkedPerson,
    });
    sendSuccess(res, { activityId: doc._id.toString() }, 'Activity created');
  } catch (err) { next(err); }
});

/* ── POST /api/internal/send-sms — AI sends an SMS via Twilio ── */
router.post('/send-sms', async (req: Request, res: Response) => {
  const { to, message } = req.body as { to: string; message: string };
  if (!to || !message) { sendError(res, 'to and message are required', 400); return; }
  const sid = await sendSmsNow({ to, body: message });
  sendSuccess(res, { success: !!sid, sid }, sid ? 'SMS sent' : 'SMS not sent — check Twilio config');
});

/* ── POST /api/internal/create-automation-run — create a new automation run tracker ── */
router.post('/create-automation-run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, sessionId, trigger, triggerType, customerName, steps } = req.body as {
      tenantId: string; sessionId: string; trigger: string;
      triggerType?: 'chat' | 'manual'; customerName?: string;
      steps?: Array<{ name: string; status?: string }>;
    };
    if (!tenantId || !sessionId || !trigger) {
      sendError(res, 'tenantId, sessionId, trigger are required', 400);
      return;
    }
    const run = await AutomationRun.create({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      sessionId,
      trigger,
      triggerType: triggerType || 'chat',
      customerName: customerName || 'Unknown',
      status: 'running',
      steps: (steps || []).map((s) => ({ name: s.name, status: s.status || 'pending' })),
    });
    sendSuccess(res, { runId: run._id.toString() }, 'Automation run created');
  } catch (err) { next(err); }
});

/* ── PUT /api/internal/automation-run/:runId/step — update a single step status ── */
router.put('/automation-run/:runId/step', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runId } = req.params;
    const { stepIndex, status, result, error, runStatus, customerEmail, customerPhone, activityId, messageContent } = req.body as {
      stepIndex: number; status: string; result?: string; error?: string;
      runStatus?: string; customerEmail?: string; customerPhone?: string; activityId?: string;
      messageContent?: { subject?: string; body?: string; text?: string; to?: string };
    };
    if (stepIndex === undefined || !status) { sendError(res, 'stepIndex and status are required', 400); return; }

    const setFields: Record<string, unknown> = {
      [`steps.${stepIndex}.status`]: status,
      [`steps.${stepIndex}.executedAt`]: new Date(),
    };
    if (result)         setFields[`steps.${stepIndex}.result`]         = result;
    if (error)          setFields[`steps.${stepIndex}.error`]          = error;
    if (messageContent) setFields[`steps.${stepIndex}.messageContent`] = messageContent;
    if (runStatus)     setFields['status']        = runStatus;
    if (customerEmail) setFields['customerEmail'] = customerEmail;
    if (customerPhone) setFields['customerPhone'] = customerPhone;
    if (activityId)    setFields['activityId']    = activityId;

    await AutomationRun.findByIdAndUpdate(runId, { $set: setFields });
    sendSuccess(res, null, 'Step updated');
  } catch (err) { next(err); }
});

/* ── POST /api/internal/seed-templates/:tenantId — create default templates if missing ── */
router.post('/seed-templates/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;
    if (!mongoose.isValidObjectId(tenantId)) { sendError(res, 'Invalid tenantId', 400); return; }
    const tid = new mongoose.Types.ObjectId(tenantId);

    const DEFAULTS: Array<{
      name: string; type: 'email' | 'whatsapp' | 'sms';
      category: string; subject?: string; body: string; variables: string[];
    }> = [
      // Meeting templates
      {
        name: 'Meeting Confirmation — WhatsApp',
        type: 'whatsapp', category: 'meeting',
        body: 'Hi {{name}},\n\nYour meeting with {{company}} is confirmed for *{{time}}*.\n\nSee you then! 👋',
        variables: ['name', 'company', 'time'],
      },
      {
        name: 'Meeting Confirmation — Email',
        type: 'email', category: 'meeting',
        subject: 'Meeting Confirmed: {{time}}',
        body: '<p>Dear {{name}},</p><p>Your meeting with <strong>{{company}}</strong> is confirmed for <strong>{{time}}</strong>.</p><p>We look forward to speaking with you!</p><p>Best regards,<br>{{company}} Team</p>',
        variables: ['name', 'company', 'time'],
      },
      // Appointment templates
      {
        name: 'Appointment Confirmation — WhatsApp',
        type: 'whatsapp', category: 'appointment',
        body: 'Dear {{name}},\n\nYour appointment with {{company}} is confirmed for *{{date}}* at *{{time}}*.\n\nSee you then! 😊',
        variables: ['name', 'company', 'date', 'time'],
      },
      {
        name: 'Appointment Confirmation — Email',
        type: 'email', category: 'appointment',
        subject: 'Appointment Confirmed — {{date}} at {{time}}',
        body: '<p>Dear {{name}},</p><p>Your appointment with <strong>{{company}}</strong> is confirmed.</p><p><strong>Date:</strong> {{date}}<br><strong>Time:</strong> {{time}}</p><p>If you need to reschedule, please contact us in advance.</p><p>Best regards,<br>{{company}} Team</p>',
        variables: ['name', 'company', 'date', 'time'],
      },
      // Booking templates
      {
        name: 'Booking Confirmation — WhatsApp',
        type: 'whatsapp', category: 'booking',
        body: 'Hi {{name}}! 🎉\n\nYour booking with {{company}} is confirmed.\nDate & Time: *{{time}}*\n\nThank you for choosing us!',
        variables: ['name', 'company', 'time'],
      },
      {
        name: 'Booking Confirmation — Email',
        type: 'email', category: 'booking',
        subject: 'Booking Confirmed — {{company}}',
        body: '<p>Hi {{name}},</p><p>Your booking with <strong>{{company}}</strong> is confirmed for <strong>{{time}}</strong>.</p><p>Thank you for choosing us! We\'re excited to have you.</p><p>Regards,<br>{{company}} Team</p>',
        variables: ['name', 'company', 'time'],
      },
      // Follow-up templates
      {
        name: 'Follow-up — WhatsApp',
        type: 'whatsapp', category: 'followup',
        body: 'Hi {{name}}, just following up! Did you get a chance to review the information I sent? Feel free to reach out anytime. 😊',
        variables: ['name'],
      },
      // Reminder templates
      {
        name: 'Reminder — WhatsApp',
        type: 'whatsapp', category: 'reminder',
        body: 'Hi {{name}}, this is a friendly reminder about your {{meeting}} on *{{date}}*. See you soon! 👋',
        variables: ['name', 'meeting', 'date'],
      },
    ];

    let created = 0;
    let skipped = 0;

    for (const tpl of DEFAULTS) {
      const existing = await Template.findOne({ tenantId: tid, name: tpl.name });
      if (existing) { skipped++; continue; }
      await Template.create({ tenantId: tid, ...tpl, language: 'en', isActive: true, aiGenerated: false });
      created++;
    }

    sendSuccess(res, { created, skipped }, `Seeded ${created} templates (${skipped} already existed)`);
  } catch (err) { next(err); }
});

/* ── POST /api/internal/ai-action — log an AI action (fire-and-forget from AI service) ── */
router.post('/ai-action', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, sessionId, actionType, summary, userMessage, metadata } = req.body as {
      tenantId: string; sessionId: string; actionType: string;
      summary: string; userMessage?: string; metadata?: Record<string, unknown>;
    };
    if (!tenantId || !sessionId || !summary) {
      sendError(res, 'tenantId, sessionId, summary required', 400);
      return;
    }
    await AIAction.create({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      sessionId,
      actionType: actionType || 'general',
      summary,
      userMessage: userMessage?.slice(0, 300) || '',
      metadata: metadata || {},
    });
    sendSuccess(res, null, 'AI action logged');
  } catch (err) { next(err); }
});

export default router;
