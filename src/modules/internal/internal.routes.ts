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
import { captureLeadFromExternalSource } from '../native-crm/lead-capture/lead-capture.service';
import { assignRoundRobin, resolveTeamForService } from '../native-crm/staffs/round-robin.service';
import { getActiveStaffByStaffId, listStaffs } from '../native-crm/staffs/staff.service';
import { listTeams } from '../native-crm/teams/team.service';
import { NativeTeam } from '../native-crm/teams/team.model';
import { computeAvailableSlots, computeTeamAvailableSlots, isSlotFree } from '../native-crm/meetings/availability.service';
import { createMeeting } from '../native-crm/meetings/meeting.service';
import { claimWidgetSession, resolveWidgetSessionClaim, releaseWidgetSessionClaim } from './widget-session-claim.service';
import {
  trackAiTokenUsage, getTenantTokenUsageThisMonth,
  trackContinuousVoiceUsage, getTenantVoiceMinutesUsageThisMonth,
} from '../admin/ai-token-usage.model';
import {
  searchCatalogItems, getCatalogItemBySku, upsertCatalogItemFromSource,
  startKnowledgeSourceSync, finishKnowledgeSourceSync,
} from '../native-crm/catalog/catalog-item.service';
import { getWebsiteProfile, upsertWebsiteProfileFromCrawl } from '../native-crm/catalog/website-profile.service';
import { resolveTeamFromStaffId } from '../native-crm/shared/team-resolution';
import { NativeTimeline } from '../native-crm/timeline/timeline.model';
import { listChatbotDatasets, executeDatasetQuery, getDatasetRecordById, QueryPlan } from '../native-crm/datasets/dataset-query.service';
import { getDatasetSchemaForChatbot } from '../native-crm/datasets/dataset.service';

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

    const [tenant, connectors, recentCustomers, templates, crmModules, customerCounts, qnaPairs, websiteProfile, hasWidgetDepartments] = await Promise.all([
      Tenant.findById(tid).select('name slug plan settings branding aiConfig widget.greeting widget.voice.maxSessionMinutes widget.voice.allowTextDuringVoice widget.voice.voiceName widget.voice.sttLanguage widget.voice.voicePreset widget.booking.requireTeam widget.booking.requireService widget.booking.requireName widget.booking.contactRequirement widget.booking.staffLabel widget.booking.timezone'),

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

      getWebsiteProfile(tenantId),

      NativeTeam.exists({ tenantId: tid, showInWidget: true, status: 'active' }),
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
      // Only the fields the continuous-voice worker actually needs (the
      // greeting for its deterministic session.say() opener, and the
      // per-call duration cap) — deliberately not the whole widget
      // sub-document, matching this endpoint's own existing "keep the
      // response small, select only what's used" discipline.
      widget: {
        greeting: tenant.widget?.greeting,
        voice: {
          maxSessionMinutes: tenant.widget?.voice?.maxSessionMinutes,
          allowTextDuringVoice: tenant.widget?.voice?.allowTextDuringVoice,
          // voiceName (push-to-talk free-text override) / sttLanguage (a
          // Whisper/Deepgram language hint) / voicePreset (continuous-voice
          // Cartesia selection) — all previously saved but never consumed
          // by continuous voice's own worker.ts, the real gap this closes.
          voiceName: tenant.widget?.voice?.voiceName,
          sttLanguage: tenant.widget?.voice?.sttLanguage,
          voicePreset: tenant.widget?.voice?.voicePreset,
        },
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
      websiteProfile: websiteProfile ? {
        summary: websiteProfile.summary,
        services: websiteProfile.services,
        contact: websiteProfile.contact,
        hours: websiteProfile.hours,
        staff: websiteProfile.staff,
        faqs: websiteProfile.faqs,
      } : null,
      hasWidgetDepartments: !!hasWidgetDepartments,
      // requireTeam/requireService deliberately pass through as-is
      // (undefined | true | false), NOT coerced to a boolean here — the AI
      // side resolves `requireTeam ?? hasWidgetDepartments` so an untouched
      // tenant keeps today's exact behavior; coercing to false here would
      // make "never configured" indistinguishable from "explicitly off".
      bookingRequireTeam:        tenant.widget?.booking?.requireTeam,
      bookingRequireService:     tenant.widget?.booking?.requireService,
      bookingRequireName:        tenant.widget?.booking?.requireName ?? true,
      bookingContactRequirement: tenant.widget?.booking?.contactRequirement ?? 'email_or_phone',
      bookingStaffLabel:         tenant.widget?.booking?.staffLabel || 'team member',
      bookingTimezone:           tenant.widget?.booking?.timezone || 'UTC',
    }, 'Tenant context fetched');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/internal/datasets?tenantId=
 *
 * Every dataset this tenant has opted into the public chatbot for — the
 * Generic Dataset system's own resolution source for search_dataset/
 * get_dataset_record (backendClient.listDatasetsForChatbot()). Only
 * availableToChatbot:true datasets with a real activeVersion (a version
 * that's actually finished importing — undefined means still importing or
 * never successfully finished) are offered; an in-progress or disabled
 * dataset is invisible to the AI, same opt-in posture as every other
 * widget-facing data source in this codebase.
 */
router.get('/datasets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.query as { tenantId: string };
    if (!tenantId || !mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'tenantId is required', 400);
      return;
    }
    sendSuccess(res, { datasets: await listChatbotDatasets(tenantId) });
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/datasets/:datasetId/schema?tenantId=
 *
 * The column/role schema (no raw row data) for one dataset's active
 * version — feeds the query router's fast-path/classifier so a plan only
 * ever references real, currently-known fields. Reuses
 * getDatasetSchemaForChatbot() as-is (dataset.service.ts) — already
 * enforces "no active version yet" -> null, no separate check needed here.
 */
router.get('/datasets/:datasetId/schema', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { datasetId } = req.params;
    const { tenantId } = req.query as { tenantId: string };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !mongoose.isValidObjectId(datasetId)) {
      sendError(res, 'tenantId and a valid datasetId are required', 400);
      return;
    }
    const columns = await getDatasetSchemaForChatbot(tenantId, datasetId);
    sendSuccess(res, { columns: columns ?? [] });
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/datasets/query
 *
 * The ONLY place a QueryPlan (built by the AI's query router) is actually
 * executed against real dataset records — reuses executeDatasetQuery() as-is
 * (dataset-query.service.ts), which itself re-enforces availableToChatbot
 * and resolves activeVersion server-side, never trusting datasetId alone.
 */
router.post('/datasets/query', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, datasetId, plan } = req.body as { tenantId: string; datasetId: string; plan: QueryPlan };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !datasetId || !mongoose.isValidObjectId(datasetId) || !plan) {
      sendError(res, 'tenantId, datasetId, and plan are required', 400);
      return;
    }
    const result = await executeDatasetQuery(tenantId, datasetId, plan);
    sendSuccess(res, result ?? { results: [], datasetName: null });
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/datasets/:datasetId/record/:recordId?tenantId=
 *
 * get_dataset_record's own lookup — the model always calls search_dataset
 * first to get a real recordId, this just fetches that exact row. Reuses
 * getDatasetRecordById() as-is (dataset-query.service.ts).
 */
router.get('/datasets/:datasetId/record/:recordId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { datasetId, recordId } = req.params;
    const { tenantId } = req.query as { tenantId: string };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !mongoose.isValidObjectId(datasetId)) {
      sendError(res, 'tenantId and a valid datasetId are required', 400);
      return;
    }
    const record = await getDatasetRecordById(tenantId, datasetId, recordId);
    sendSuccess(res, { record });
  } catch (err) { next(err); }
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
    const { tenantId, sessionId, role, content, metadata, visitorId, visitorName, visitorEmail, visitorPhone, escalated, channel } = req.body as {
      tenantId: string; sessionId: string; role: 'user' | 'assistant';
      content: string; metadata?: Record<string, unknown>;
      visitorId?: string; visitorName?: string; visitorEmail?: string; visitorPhone?: string; escalated?: boolean;
      channel?: 'text' | 'push_to_talk' | 'continuous_voice';
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

    // channel/visitorId default at creation (today's exact prior behavior
    // for channel) — only ever supplied on a NEW session; an existing
    // session's channel/visitorId never flip mid-conversation. $setOnInsert
    // only, matching every other per-session-identity field here.
    await ChatSession.findOneAndUpdate(
      { sessionId },
      {
        $push: { messages: msg },
        ...(Object.keys(setFields).length ? { $set: setFields } : {}),
        $setOnInsert: {
          tenantId: new mongoose.Types.ObjectId(tenantId), sessionId, channel: channel || 'web',
          ...(visitorId ? { visitorId } : {}),
        },
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

/**
 * POST /api/internal/widget-lead-capture
 *
 * The AI widget's own lead-capture call — reuses the SAME
 * captureLeadFromExternalSource() the browser extension already calls
 * (via its own authenticated HTTP route), just called in-process here since
 * there's no real staff JWT for an anonymous public visitor. Round-robin
 * assigns a staff owner BEFORE capture; an idempotency guard keyed on
 * (tenantId, platform:'chatbot', sessionId) stops a retried/duplicate call
 * for the same conversation from ever creating a second Lead.
 */
router.post('/widget-lead-capture', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, sessionId, visitorId, sourceUrl, firstName, lastName, email, phone, company, service } = req.body as {
      tenantId: string; sessionId: string; visitorId?: string; sourceUrl?: string;
      firstName: string; lastName?: string; email?: string; phone?: string; company?: string; service?: string;
    };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !sessionId || !firstName) {
      sendError(res, 'tenantId, sessionId, firstName are required', 400);
      return;
    }
    const tid = new mongoose.Types.ObjectId(tenantId);

    // Atomic claim — a plain findOne-then-create check here was confirmed
    // racy under real concurrent load (10 simultaneous calls for the same
    // sessionId produced 10 Leads instead of 1); see widget-session-claim
    // model/service for why this specific pattern is safe under a race.
    const claim = await claimWidgetSession(tenantId, sessionId, 'lead');
    if (!claim.claimed) {
      if (claim.outcome?.status === 'done') {
        sendSuccess(res, { ...claim.outcome.result, alreadyCreated: true }, 'Lead already created for this session');
      } else {
        sendError(res, 'Lead capture for this session is already in progress — please retry shortly', 409);
      }
      return;
    }

    const tenant = await Tenant.findById(tid).select('widget').lean();
    // Route to the team that actually handles the captured service, when one
    // matches (resolveTeamForService) — before falling back to the tenant's
    // one fixed default team, then fully tenant-wide. assignRoundRobin()
    // itself is unchanged; this only changes which teamId gets passed in.
    const routedTeamId = await resolveTeamForService(tenantId, service);
    const assigned = await assignRoundRobin(
      tenantId,
      routedTeamId ?? (tenant?.widget?.defaultTeamId ? String(tenant.widget.defaultTeamId) : undefined),
    );

    const { capture, lead } = await captureLeadFromExternalSource(
      tenantId, null, 'system:ai-widget', 'ai-widget@leadryze.internal',
      {
        platform: 'chatbot',
        sourceUrl: sourceUrl || 'widget-chat',
        raw: { sessionId, visitorId, firstName, lastName, email, phone, company, service },
        assignedStaffId: assigned?.staffId,
        assignedStaffName: assigned?.staffName,
      },
    );

    if (!lead) {
      await releaseWidgetSessionClaim(tenantId, sessionId, 'lead');
      sendError(res, capture.failureReason || 'Could not create a lead from the captured fields', 422);
      return;
    }
    const result = { leadId: lead._id, leadDisplayId: lead.leadId };
    await resolveWidgetSessionClaim(tenantId, sessionId, 'lead', result);
    sendSuccess(res, result, 'Lead created');
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/widget-crawl-complete
 *
 * Called by the AI service once a website crawl finishes — records
 * lastCrawledAt/crawlPageCount onto the tenant's widget config. These two
 * fields are deliberately absent from updateTenant()'s client-editable field
 * allow-list; this internal, service-key-gated route is the only path that
 * can set them, since the AI service (which actually ran the crawl) is the
 * source of truth for what happened, not whatever a client claims.
 */
router.post('/widget-crawl-complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, pagesCrawled } = req.body as { tenantId: string; pagesCrawled: number };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || typeof pagesCrawled !== 'number') {
      sendError(res, 'tenantId and pagesCrawled are required', 400);
      return;
    }
    await Tenant.findByIdAndUpdate(tenantId, {
      $set: { 'widget.lastCrawledAt': new Date(), 'widget.crawlPageCount': pagesCrawled },
    });
    sendSuccess(res, null, 'Crawl result recorded');
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/widget-teams?serviceHint=
 *
 * Departments a visitor may choose between when booking — only teams a
 * tenant admin has explicitly marked showInWidget:true, and only active
 * ones. Empty result means "no departments configured" — the AI reads that
 * as "proceed straight to availability", not an error. When serviceHint is
 * given, pre-filters to the team(s) resolveTeamForService() confidently
 * matches (reusing the SAME matcher already used post-booking, not new
 * matching logic) — falling back to the full list when nothing matches, so
 * an unconfident/unstated need still shows every option rather than none.
 */
router.get('/widget-teams', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, serviceHint } = req.query as { tenantId: string; serviceHint?: string };
    if (!tenantId || !mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'tenantId is required', 400);
      return;
    }
    const { items } = await listTeams(tenantId, { status: 'active', showInWidget: true, limit: 100 });
    let filtered = items;
    if (serviceHint) {
      const matchedTeamId = await resolveTeamForService(tenantId, serviceHint);
      if (matchedTeamId) {
        const narrowed = items.filter((t: any) => String(t._id) === matchedTeamId);
        if (narrowed.length) filtered = narrowed;
      }
    }
    sendSuccess(res, { teams: filtered.map((t: any) => ({ teamId: String(t._id), name: t.name })) });
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/widget-staff?teamId=
 *
 * Active staff (doctors) within one department a visitor already chose.
 */
router.get('/widget-staff', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, teamId } = req.query as { tenantId: string; teamId: string };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !teamId || !mongoose.isValidObjectId(teamId)) {
      sendError(res, 'tenantId and teamId are required', 400);
      return;
    }
    const { items } = await listStaffs(tenantId, { status: 'active', teamId, limit: 100 });
    sendSuccess(res, {
      staff: items.map((s: any) => ({ staffId: s.staffId, name: `${s.firstName} ${s.lastName}`.trim() })),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/widget-availability
 *
 * Tenant-wide business-hours availability for the widget's booking tool —
 * see availability.service.ts for the single-capacity model this uses (no
 * per-staff calendars exist anywhere in this codebase). An optional staffId
 * narrows the capacity check to one doctor's own meetings, for tenants using
 * the department/doctor booking wizard. An optional teamId (used only when
 * staffId is absent — a specific doctor choice always wins) unions the whole
 * team's availability instead, via computeTeamAvailableSlots — the direct
 * fix for "everyone shown as busy just because one team member is" when no
 * one doctor has been chosen yet.
 */
router.get('/widget-availability', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, days, timeOfDay, staffId, teamId, date } = req.query as { tenantId: string; days?: string; timeOfDay?: string; staffId?: string; teamId?: string; date?: string };
    if (!tenantId || !mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'tenantId is required', 400);
      return;
    }
    const opts = {
      days: days ? parseInt(days, 10) : undefined,
      timeOfDay: (timeOfDay as 'morning' | 'afternoon' | 'any') || undefined,
      // Real, confirmed bug this closes: a visitor-requested date (e.g.
      // "tomorrow") never reached the availability calculation at all — see
      // availability.service.ts's own comment on computeAvailableSlots for
      // the full root cause.
      forDate: (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : undefined,
    };
    const slots = (!staffId && teamId && mongoose.isValidObjectId(teamId))
      ? await computeTeamAvailableSlots(tenantId, teamId, opts)
      : await computeAvailableSlots(tenantId, { ...opts, staffId: staffId || undefined });
    sendSuccess(res, { slots });
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/widget-book-meeting
 *
 * Converts an offered slot into a real booking: re-checks the slot is still
 * free, round-robin-assigns a staff owner, creates/reuses a Lead via the
 * SAME captureLeadFromExternalSource() the plain widget-lead-capture route
 * uses (so a booking visitor gets exactly one Lead, not two), then creates a
 * real Meeting linked to it. Idempotent per session, same convention as
 * widget-lead-capture: a session that already has a completed booking gets
 * back its existing meeting rather than creating a second one.
 */
router.post('/widget-book-meeting', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      tenantId, sessionId, visitorId, sourceUrl, startIso, endIso, firstName, lastName, email, phone, topic, staffId,
    } = req.body as {
      tenantId: string; sessionId: string; visitorId?: string; sourceUrl?: string;
      startIso: string; endIso: string; firstName: string; lastName?: string; email?: string; phone?: string; topic?: string;
      staffId?: string;
    };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !sessionId || !startIso || !endIso || !firstName) {
      sendError(res, 'tenantId, sessionId, startIso, endIso, firstName are required', 400);
      return;
    }
    const tid = new mongoose.Types.ObjectId(tenantId);

    // Atomic claim — same race confirmed live for widget-lead-capture applies
    // here too (a plain findOne-then-create check lets N concurrent requests
    // for the identical session all pass before any of them finishes); see
    // widget-session-claim model/service.
    const claim = await claimWidgetSession(tenantId, sessionId, 'meeting');
    if (!claim.claimed) {
      if (claim.outcome?.status === 'done') {
        sendSuccess(res, { ...claim.outcome.result, alreadyCreated: true }, 'Meeting already booked for this session');
      } else {
        sendError(res, 'This booking is already in progress — please retry shortly', 409);
      }
      return;
    }

    // A chosen doctor (department/doctor wizard) resolves to a specific
    // active staff member and skips round-robin entirely; a stale/deleted/
    // wrong-tenant staffId falls open to round-robin rather than ever
    // blocking a booking over a selection that's gone stale.
    const chosenStaff = staffId ? await getActiveStaffByStaffId(tenantId, staffId) : null;

    // Only pre-check availability HERE when a SPECIFIC doctor was chosen —
    // that's a real, single-capacity check (is THIS person free). When no
    // doctor is chosen, a blind tenant-wide isSlotFree(..., undefined) check
    // would incorrectly reject a slot just because SOME unrelated staff
    // member (possibly not even on the relevant team) has a conflict at that
    // time — defeating the whole point of team-wide availability/time-aware
    // round robin below, which is the real, correct authority for "is
    // SOMEONE on this team free" in that case. A confirmed, real bug found
    // via live-fire testing, not a hypothetical.
    if (chosenStaff) {
      const free = await isSlotFree(tenantId, startIso, endIso, chosenStaff.staffId);
      if (!free) {
        await releaseWidgetSessionClaim(tenantId, sessionId, 'meeting');
        sendError(res, 'That time is no longer available — please pick another slot.', 409);
        return;
      }
    }

    let assigned: { staffId: string; staffName: string } | null;
    if (chosenStaff) {
      assigned = { staffId: chosenStaff.staffId, staffName: `${chosenStaff.firstName} ${chosenStaff.lastName}`.trim() };
    } else {
      // No explicit doctor chosen — try routing by the booking's own topic
      // before falling back to the tenant's fixed default team, same
      // resolveTeamForService()-first order as widget-lead-capture. The
      // resolved slot is now passed through so assignRoundRobin can skip a
      // roster member who's actually busy at this exact time (the direct
      // fix for "A busy -> B should be offered instead") rather than
      // blindly assigning whoever the plain rotation cursor points at.
      const tenant = await Tenant.findById(tid).select('widget').lean();
      const routedTeamId = await resolveTeamForService(tenantId, topic);
      const resolvedTeamId = routedTeamId ?? (tenant?.widget?.defaultTeamId ? String(tenant.widget.defaultTeamId) : undefined);
      assigned = await assignRoundRobin(tenantId, resolvedTeamId, { startIso, endIso });
      // Real, confirmed production bug this closes: neither routedTeamId nor
      // defaultTeamId is a team the VISITOR actually chose — chosenStaff
      // being falsy is exactly what put us in this branch. If that guessed
      // team happens to have nobody active/free on it (e.g. a tenant's
      // configured default team is short-staffed), a real staff member could
      // still be free elsewhere in the company — verified live: a tenant
      // whose default team had ZERO active staff got "no staff available"
      // on every single booking attempt, regardless of the real slot being
      // completely open. One retry, company-wide, before ever telling the
      // visitor nothing is free.
      if (!assigned && resolvedTeamId) {
        assigned = await assignRoundRobin(tenantId, undefined, { startIso, endIso });
      }
      if (!assigned) {
        // Every candidate (or the whole tenant, if no team scoping applies)
        // is genuinely busy at this exact slot — a real, possible race since
        // the offered times came from a slightly earlier availability check.
        // Never fall back to a random/unassigned booking — tell the visitor
        // plainly so the AI can offer fresh times instead.
        await releaseWidgetSessionClaim(tenantId, sessionId, 'meeting');
        sendError(res, 'No staff member is available at this time — please pick another slot.', 409);
        return;
      }
    }

    const { capture, lead } = await captureLeadFromExternalSource(
      tenantId, null, 'system:ai-widget', 'ai-widget@leadryze.internal',
      {
        platform: 'chatbot',
        sourceUrl: sourceUrl || 'widget-chat',
        raw: { sessionId, visitorId, firstName, lastName, email, phone, topic },
        assignedStaffId: assigned?.staffId,
        assignedStaffName: assigned?.staffName,
      },
    );
    if (!lead) {
      await releaseWidgetSessionClaim(tenantId, sessionId, 'meeting');
      sendError(res, capture.failureReason || 'Could not create a lead for this booking', 422);
      return;
    }

    const fullName = `${firstName} ${lastName ?? ''}`.trim();
    const { teamId: resolvedTeamId2, teamName: resolvedTeamName2 } = await resolveTeamFromStaffId(tenantId, assigned?.staffId);
    let meeting;
    try {
      meeting = await createMeeting(tenantId, {
        title: `Call with ${fullName}`,
        startDate: startIso,
        endDate: endIso,
        attendees: email ? [email] : undefined,
        notes: topic ? `Booked via website widget. Topic: ${topic}` : 'Booked via website widget.',
        relatedModule: 'lead',
        relatedId: String(lead._id),
        relatedLabel: fullName,
        assignedStaffId: assigned?.staffId,
        assignedStaffName: assigned?.staffName,
        teamId: resolvedTeamId2 ?? undefined,
        teamName: resolvedTeamName2 ?? undefined,
        source: 'widget',
      });
      if (assigned) {
        await NativeTimeline.create({
          tenantId: tid,
          entityModule: 'meetings',
          entityId: String(meeting._id),
          action: 'assigned',
          description: resolvedTeamName2
            ? `AI Widget → ${resolvedTeamName2} → ${assigned.staffName}`
            : `AI Widget → Round Robin → ${assigned.staffName}`,
          performedBy: 'system:ai-widget',
          metadata: { staffId: assigned.staffId, staffName: assigned.staffName, teamId: resolvedTeamId2, teamName: resolvedTeamName2 },
        });
      }
    } catch (err: any) {
      // Duplicate-key on the partial unique index — two requests raced past
      // the isSlotFree check above for the identical slot. Rare, but a real
      // possibility under concurrency; the Lead above still exists (harmless,
      // same as any other captured-but-not-booked lead) — only the meeting
      // creation itself needs to fail loudly here.
      await releaseWidgetSessionClaim(tenantId, sessionId, 'meeting');
      if (err?.code === 11000) {
        sendError(res, 'That time was just booked by someone else — please pick another slot.', 409);
        return;
      }
      throw err;
    }

    // No separate booking-confirmation email needed here — createMeeting()
    // above already triggers meeting.service.ts's own sendOnCreateConfirmation()
    // (backend/src/modules/notifications/confirmation.service.ts), a fuller,
    // already-built, tenant-configurable on-create email/SMS system with its
    // own EmailLog audit trail. Confirmed live: a direct booking test sent a
    // real "Confirmed: Call with ... — new meeting" email via Brevo with no
    // extra code — this route was already covered before this pass.

    const result = { meetingId: meeting._id, startIso, endIso, staffName: assigned?.staffName, leadId: lead._id };
    await resolveWidgetSessionClaim(tenantId, sessionId, 'meeting', result);
    sendSuccess(res, result, 'Meeting booked');
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

/**
 * POST /api/internal/ai-token-usage
 * Records one turn's worth of LLM token usage/cost against a tenant's
 * daily-bucketed counter (AiTokenUsage) — fire-and-forget from the AI
 * service, same non-blocking convention as /logs and /ai-action above.
 */
router.post('/ai-token-usage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      tenantId, promptTokens, completionTokens, totalTokens, estimatedCostUsd, usedModerationFallback,
      sttSeconds, ttsCharacters, voiceCostUsd, isVoiceRequest,
    } = req.body as {
      tenantId: string; promptTokens?: number; completionTokens?: number;
      totalTokens?: number; estimatedCostUsd?: number; usedModerationFallback?: boolean;
      sttSeconds?: number; ttsCharacters?: number; voiceCostUsd?: number; isVoiceRequest?: boolean;
    };
    if (!tenantId || !mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Valid tenantId is required', 400);
      return;
    }
    await trackAiTokenUsage(tenantId, {
      promptTokens: promptTokens || 0,
      completionTokens: completionTokens || 0,
      totalTokens: totalTokens || 0,
      estimatedCostUsd: estimatedCostUsd || 0,
      usedModerationFallback,
      sttSeconds, ttsCharacters, voiceCostUsd, isVoiceRequest,
    });
    sendSuccess(res, null, 'Token usage recorded');
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/ai-token-usage/:tenantId
 * Returns the tenant's month-to-date total token usage — the source of
 * truth checkTenantTokenQuota() in the AI service briefly caches in Redis
 * (see rate-limiter.ts) rather than calling this on every single message.
 */
router.get('/ai-token-usage/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;
    if (!mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Invalid tenantId', 400);
      return;
    }
    const totalTokens = await getTenantTokenUsageThisMonth(tenantId);
    sendSuccess(res, { totalTokens });
  } catch (err) { next(err); }
});

/**
 * POST /api/internal/continuous-voice-usage
 * Records one completed continuous-voice (LiveKit) session's real usage —
 * called by the voice-agent worker process (ai/src/voice-agent/worker.ts) at
 * session close, using AgentSession's own real usage summary
 * (session.usage.modelUsage), not client-side estimates.
 */
router.post('/continuous-voice-usage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, minutes, deepgramSttSeconds, cartesiaTtsCharacters, estimatedCostUsd } = req.body as {
      tenantId: string; minutes?: number; deepgramSttSeconds?: number;
      cartesiaTtsCharacters?: number; estimatedCostUsd?: number;
    };
    if (!tenantId || !mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Valid tenantId is required', 400);
      return;
    }
    await trackContinuousVoiceUsage(tenantId, {
      minutes: minutes || 0,
      deepgramSttSeconds: deepgramSttSeconds || 0,
      cartesiaTtsCharacters: cartesiaTtsCharacters || 0,
      estimatedCostUsd: estimatedCostUsd || 0,
    });
    sendSuccess(res, null, 'Continuous voice usage recorded');
  } catch (err) { next(err); }
});

/**
 * GET /api/internal/continuous-voice-usage/:tenantId
 * Month-to-date continuous-voice minutes — the source of truth
 * checkTenantVoiceMinutesQuota() in the AI service briefly caches in Redis.
 */
router.get('/continuous-voice-usage/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;
    if (!mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Invalid tenantId', 400);
      return;
    }
    const minutes = await getTenantVoiceMinutesUsageThisMonth(tenantId);
    sendSuccess(res, { minutes });
  } catch (err) { next(err); }
});

/**
 * Product Catalog — internal routes the AI service calls for the
 * search_products/get_product_details tools and for the website crawler's
 * JSON-LD → catalog upsert step (see ai/src/rag/website-ingest.service.ts).
 */
router.post('/catalog/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, query, category, limit } = req.body as {
      tenantId: string; query?: string; category?: string; limit?: number;
    };
    if (!tenantId || !mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Valid tenantId is required', 400);
      return;
    }
    const items = await searchCatalogItems(tenantId, { query, category, limit });
    sendSuccess(res, { items });
  } catch (err) { next(err); }
});

router.get('/catalog/:tenantId/sku/:sku', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, sku } = req.params;
    if (!mongoose.isValidObjectId(tenantId)) {
      sendError(res, 'Invalid tenantId', 400);
      return;
    }
    const item = await getCatalogItemBySku(tenantId, sku);
    sendSuccess(res, { item: item || null });
  } catch (err) { next(err); }
});

router.post('/catalog/knowledge-source/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, type, label } = req.body as { tenantId: string; type: 'website' | 'excel' | 'csv' | 'json'; label: string };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !type || !label) {
      sendError(res, 'tenantId, type and label are required', 400);
      return;
    }
    const source = await startKnowledgeSourceSync(tenantId, type, label);
    sendSuccess(res, { knowledgeSourceId: String(source._id) });
  } catch (err) { next(err); }
});

router.post('/catalog/knowledge-source/finish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { knowledgeSourceId, outcome, durationMs, error } = req.body as {
      knowledgeSourceId: string; outcome: 'completed' | 'failed'; durationMs: number; error?: string;
    };
    if (!knowledgeSourceId || !outcome) {
      sendError(res, 'knowledgeSourceId and outcome are required', 400);
      return;
    }
    await finishKnowledgeSourceSync(knowledgeSourceId, outcome, durationMs || 0, error);
    sendSuccess(res, null, 'Knowledge source sync finished');
  } catch (err) { next(err); }
});

router.post('/catalog/upsert-from-crawl', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, knowledgeSourceId, sourceUrl, fields } = req.body as {
      tenantId: string; knowledgeSourceId: string; sourceUrl: string; fields: Record<string, unknown>;
    };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !knowledgeSourceId || !sourceUrl || !fields) {
      sendError(res, 'tenantId, knowledgeSourceId, sourceUrl and fields are required', 400);
      return;
    }
    const result = await upsertCatalogItemFromSource(tenantId, knowledgeSourceId, 'crawl', { sourceUrl }, fields as any);
    sendSuccess(res, result);
  } catch (err) { next(err); }
});

/**
 * Website Profile — one structured "who we are" document per tenant, built
 * once per crawl (see ai/src/rag/website-profile-extractor.ts), read back
 * into every chat turn via the tenant-context response above.
 */
router.post('/website-profile/upsert-from-crawl', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, knowledgeSourceId, fields } = req.body as {
      tenantId: string; knowledgeSourceId: string; fields: Record<string, unknown>;
    };
    if (!tenantId || !mongoose.isValidObjectId(tenantId) || !knowledgeSourceId || !fields) {
      sendError(res, 'tenantId, knowledgeSourceId and fields are required', 400);
      return;
    }
    const result = await upsertWebsiteProfileFromCrawl(tenantId, knowledgeSourceId, fields as any);
    sendSuccess(res, result);
  } catch (err) { next(err); }
});

export default router;
