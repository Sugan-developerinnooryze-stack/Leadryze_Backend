import { Router, Response, NextFunction } from 'express';
import axios from 'axios';
import { getAllTenantsLogs } from '../logs/log.service';
import { authenticate } from '../../middlewares/auth.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import { User } from '../auth/auth.model';
import { Tenant } from '../tenants/tenant.model';
import { Connector } from '../connectors/connector.model';
import { CRMRecord } from '../crm/crm-record.model';
import { Customer } from '../customers/customer.model';
import { Message } from '../messages/message.model';
import { Campaign } from '../campaigns/campaign.model';
import { config } from '../../config';
import mongoose from 'mongoose';
import { UserSession } from '../auth/user-session.model';
import { AuditLog, logAuditEvent } from '../logs/audit-log.model';

const router = Router();

function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'SUPER_ADMIN') {
    sendError(res, 'Super admin access required', 403);
    return;
  }
  next();
}

router.use(authenticate, requireSuperAdmin);

// GET /admin/stats
router.get('/stats', async (_req, res, next) => {
  try {
    // Count clients = union of (non-demo TENANT_ADMIN tenantIds) + (all non-demo tenant docs)
    // This handles: tenants with no TENANT_ADMIN (e.g. seeded Acme Corp) and TENANT_ADMINs
    // whose tenant doc was accidentally deleted.
    const [tenantAdminTenantIds, nonDemoTenantIds, demoTenant] = await Promise.all([
      User.distinct('tenantId', { role: 'TENANT_ADMIN' }),
      Tenant.distinct('_id', { slug: { $ne: 'leadryze-demo' } }),
      Tenant.findOne({ slug: 'leadryze-demo' }).select('_id').lean(),
    ]);
    const demoId = demoTenant?._id?.toString();
    const uniqueClientIds = new Set([
      ...tenantAdminTenantIds
        .filter((id: any) => id.toString() !== demoId)
        .map((id: any) => id.toString()),
      ...nonDemoTenantIds.map((id: any) => id.toString()),
    ]);
    const totalClients = uniqueClientIds.size;

    const [totalCustomers, activeConnectors, totalUsers, totalMessages, totalCampaigns] =
      await Promise.all([
        Customer.countDocuments(),
        Connector.countDocuments({ isActive: true }),
        User.countDocuments({ role: { $ne: 'SUPER_ADMIN' } }),
        Message.countDocuments(),
        Campaign.countDocuments(),
      ]);
    sendSuccess(res, { totalClients, totalCustomers, activeConnectors, totalUsers, totalMessages, totalCampaigns }, 'Stats fetched');
  } catch (err) { next(err); }
});

// GET /admin/clients — each tenant with full stats + primary admin user
router.get('/clients', async (_req, res, next) => {
  try {
    // ── Self-heal: find TENANT_ADMIN users whose tenant document is missing ──
    // This happens when someone deletes a tenant from Compass while the user
    // record still exists, or when registration partially fails.
    const tenantAdmins = await User.find({ role: 'TENANT_ADMIN' })
      .select('tenantId firstName lastName email createdAt').lean();

    const knownTenantIds = await Tenant.distinct('_id');
    const knownSet = new Set(knownTenantIds.map((id) => id.toString()));

    for (const admin of tenantAdmins) {
      if (knownSet.has(admin.tenantId.toString())) continue;
      // Tenant document is missing — recreate it using the user's info
      const companyName = `${admin.firstName}'s Workspace`;
      const slug = (admin.email.split('@')[0] || admin.firstName)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-')
        + '-' + admin.tenantId.toString().slice(-6);
      try {
        await Tenant.create({
          _id: admin.tenantId,
          name: companyName,
          slug,
          plan: 'starter',
          isActive: true,
          settings: {
            allowedChannels: ['web', 'whatsapp', 'email', 'sms'],
            maxUsers: 5, maxLeadsPerMonth: 500,
            timezone: 'Asia/Kuala_Lumpur', language: 'en', crmOption: 'no_crm',
          },
          branding: { companyName },
          aiConfig: { agentName: 'LeadBot', language: 'en', fallbackToHuman: true },
        });
      } catch { /* already exists from a concurrent request — safe to ignore */ }
    }

    const tenants = await Tenant.find({ slug: { $ne: 'leadryze-demo' } }).sort({ createdAt: -1 });

    const clientsWithStats = await Promise.all(
      tenants.map(async (t) => {
        const tid = t._id;
        const [userCount, customerCount, activeConnectors, messageCount, campaignCount, adminUser] =
          await Promise.all([
            User.countDocuments({ tenantId: tid }),
            Customer.countDocuments({ tenantId: tid }),
            Connector.find({ tenantId: tid, isActive: true }).select('type'),
            Message.countDocuments({ tenantId: tid }),
            Campaign.countDocuments({ tenantId: tid }),
            User.findOne({ tenantId: tid, role: 'TENANT_ADMIN' })
              .select('firstName lastName email createdAt'),
          ]);
        return {
          ...t.toObject(),
          userCount,
          customerCount,
          connectorCount: activeConnectors.length,
          connectorTypes: activeConnectors.map((c) => c.type as string),
          messageCount,
          campaignCount,
          adminUser: adminUser ?? null,
        };
      })
    );
    sendSuccess(res, clientsWithStats, 'Clients fetched');
  } catch (err) { next(err); }
});

// GET /admin/users — all non-super-admin users
router.get('/users', async (_req, res, next) => {
  try {
    const users = await User.find({ role: { $ne: 'SUPER_ADMIN' } })
      .sort({ createdAt: -1 })
      .populate('tenantId', 'name slug plan isActive');
    sendSuccess(res, users, 'Users fetched');
  } catch (err) { next(err); }
});

// POST /admin/users/:id/verify-email — force set emailVerified: true
router.post('/users/:id/verify-email', async (req: AuthRequest, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { emailVerified: true }, $unset: { emailVerificationToken: 1, emailVerificationExpiry: 1 } },
      { new: true }
    ).select('email firstName lastName emailVerified');
    if (!user) { sendError(res, 'User not found', 404); return; }
    logAuditEvent('user.email_verified_forced',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { target: 'User', targetId: req.params.id, detail: { userEmail: user.email } },
    );
    sendSuccess(res, { emailVerified: true, email: user.email }, 'Email verified');
  } catch (err) { next(err); }
});

// POST /admin/users/:id/reset-password — set a new password for any user
router.post('/users/:id/reset-password', async (req: AuthRequest, res, next) => {
  try {
    const { password } = req.body as { password: string };
    if (!password || password.length < 8) {
      sendError(res, 'Password must be at least 8 characters', 400); return;
    }
    const user = await User.findById(req.params.id).select('+password');
    if (!user) { sendError(res, 'User not found', 404); return; }
    user.password = password;
    await user.save(); // triggers bcrypt pre-save hook
    await User.findByIdAndUpdate(req.params.id, { $unset: { refreshToken: 1 } });
    logAuditEvent('user.password_reset_by_admin',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { target: 'User', targetId: req.params.id, detail: { userEmail: user.email } },
    );
    sendSuccess(res, null, 'Password reset successfully');
  } catch (err) { next(err); }
});

// GET /admin/tenants/:id — single tenant detail (users, recent customers, recent messages)
router.get('/tenants/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }

    const tid = tenant._id;
    const [users, recentCustomers, recentMessages, connectors, campaigns] = await Promise.all([
      User.find({ tenantId: tid }).select('firstName lastName email role emailVerified createdAt'),
      Customer.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(5).select('name email phone channel createdAt'),
      Message.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(10)
        .select('content channel direction aiGenerated status createdAt')
        .populate('customerId', 'name email'),
      Connector.find({ tenantId: tid }).select('type isActive createdAt'),
      Campaign.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(5).select('name type status stats createdAt'),
    ]);

    sendSuccess(res, { tenant, users, recentCustomers, recentMessages, connectors, campaigns }, 'Tenant detail fetched');
  } catch (err) { next(err); }
});

// GET /admin/logs — all tenants' AI + backend logs combined
router.get('/logs', async (req: AuthRequest, res, next) => {
  try {
    const service  = req.query.service as 'ai' | 'backend' | undefined;
    const level    = req.query.level   as string | undefined;
    const limit    = Math.min(Number(req.query.limit  ?? 100), 500);
    const offset   = Number(req.query.offset ?? 0);
    const result   = await getAllTenantsLogs({ service, level, limit, offset });
    sendSuccess(res, result, 'Admin logs fetched');
  } catch (err) { next(err); }
});

// PATCH /admin/clients/:id/toggle
router.patch('/clients/:id/toggle', async (req: AuthRequest, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) { sendError(res, 'Client not found', 404); return; }
    tenant.isActive = !tenant.isActive;
    await tenant.save();
    logAuditEvent(
      tenant.isActive ? 'client.activated' : 'client.deactivated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: tenant._id.toString(), target: 'Tenant', targetId: tenant._id.toString(), detail: { tenantName: tenant.name } },
    );
    sendSuccess(res, { isActive: tenant.isActive }, `Client ${tenant.isActive ? 'activated' : 'deactivated'}`);
  } catch (err) { next(err); }
});

// GET /admin/system/health — service health + API key presence check
router.get('/system/health', async (_req, res, next) => {
  try {
    // MongoDB
    const mongoOk = mongoose.connection.readyState === 1;

    // AI service ping — capture response body for key statuses
    let aiOk = false;
    let aiKeys: Record<string, boolean | string> = {};
    try {
      const aiRes = await axios.get(`${config.app.aiServiceUrl}/health/detail`, {
        timeout: 4000,
        headers: { 'x-api-key': config.ai.internalApiKey },
      });
      aiOk = true;
      if (aiRes.data?.keys) aiKeys = aiRes.data.keys;
    } catch { /* offline */ }

    // Redis — always do a live ping rather than relying on startup flag
    let redisOk = false;
    let redisDetail = 'Disconnected';
    try {
      const { getRedisClient, connectRedis, isRedisAvailable } = await import('../../config/redis');
      let client = getRedisClient();
      if (!client) {
        // Retry once in case startup connect raced
        await connectRedis();
        client = getRedisClient();
      }
      if (client) {
        await client.ping();
        redisOk = true;
        redisDetail = 'Connected';
      } else {
        redisDetail = isRedisAvailable() ? 'Degraded' : 'Not configured or unreachable';
      }
    } catch { redisDetail = 'Ping failed'; }

    const services = [
      { name: 'MongoDB',    status: mongoOk ? 'ok' : 'error', detail: mongoOk ? 'Connected' : 'Disconnected' },
      { name: 'Redis',      status: redisOk ? 'ok' : 'error', detail: redisDetail },
      { name: 'AI Service', status: aiOk    ? 'ok' : 'error', detail: aiOk ? 'Reachable' : `Unreachable at ${config.app.aiServiceUrl}` },
    ];

    // Determine which providers are active from AI service response
    const activePrimary  = String(aiKeys.LLM_PROVIDER  || '');
    const activeFallback = String(aiKeys.LLM_FALLBACK_PROVIDER || '');

    // AI-service-owned keys are read from the AI service health response
    const apiKeys = [
      {
        name: 'Anthropic (Claude)', key: 'ANTHROPIC_API_KEY', set: !!aiKeys.ANTHROPIC_API_KEY,
        usage: 'Chat / AI responses', provider: 'anthropic',
        activeRole: activePrimary === 'anthropic' ? 'primary' : activeFallback === 'anthropic' ? 'fallback' : 'inactive',
        freeLimit: null, paidNote: 'Pay-per-token. Haiku ~$0.25/M tokens.',
        rateLimit: 'Depends on tier', purpose: 'Runs the chat agent, intent classification, CRM queries, follow-ups',
        model: activePrimary === 'anthropic' ? String(aiKeys.LLM_MODEL || '') : '',
      },
      {
        name: 'Groq (Llama)', key: 'GROQ_API_KEY', set: !!aiKeys.GROQ_API_KEY,
        usage: 'Chat / AI responses (fast free inference)', provider: 'groq',
        activeRole: activePrimary === 'groq' ? 'primary' : activeFallback === 'groq' ? 'fallback' : 'inactive',
        freeLimit: '14,400 req/day · 30 req/min', paidNote: 'Free tier available at console.groq.com',
        rateLimit: '30 req/min (free)', purpose: 'Runs Llama 3 models for chat, CRM queries, intent detection',
        model: activePrimary === 'groq' ? String(aiKeys.LLM_MODEL || '') : '',
      },
      {
        name: 'Google Gemini', key: 'GOOGLE_API_KEY', set: !!aiKeys.GOOGLE_API_KEY,
        usage: 'AI fallback / chat responses', provider: 'gemini',
        activeRole: activePrimary === 'gemini' ? 'primary' : activeFallback === 'gemini' ? 'fallback' : 'inactive',
        freeLimit: '1M tokens/day · 15 req/min', paidNote: 'Free tier at aistudio.google.com',
        rateLimit: '15 req/min (free)', purpose: 'Fallback AI when primary is unavailable or rate-limited',
        model: activePrimary === 'gemini' ? String(aiKeys.LLM_MODEL || '') : String(aiKeys.LLM_FALLBACK_MODEL || ''),
      },
      {
        name: 'OpenAI (GPT)', key: 'OPENAI_API_KEY', set: !!aiKeys.OPENAI_API_KEY,
        usage: 'AI fallback + embeddings', provider: 'openai',
        activeRole: activePrimary === 'openai' ? 'primary' : activeFallback === 'openai' ? 'fallback' : 'inactive',
        freeLimit: null, paidNote: 'Pay-per-token. GPT-4o-mini ~$0.15/M tokens.',
        rateLimit: 'Tier-based', purpose: 'Fallback AI model and optional embedding generation',
        model: '',
      },
      {
        name: 'Voyage (Embeddings)', key: 'VOYAGE_API_KEY', set: !!aiKeys.VOYAGE_API_KEY,
        usage: `Embedding model (${aiKeys.EMBEDDING_PROVIDER || 'voyage'})`, provider: 'voyage',
        activeRole: 'primary',
        freeLimit: '200M tokens free', paidNote: 'Free tier available at voyageai.com',
        rateLimit: '300 req/min (free)', purpose: 'Converts text to vectors for knowledge base search (RAG)',
        model: String(aiKeys.EMBEDDING_MODEL || 'voyage-3'),
      },
      {
        name: 'Qdrant (Vector DB)', key: 'QDRANT_URL', set: !!aiKeys.QDRANT_URL,
        usage: 'Knowledge base / RAG', provider: 'qdrant',
        activeRole: 'primary',
        freeLimit: '1 cluster free (1GB)', paidNote: 'Free cluster at cloud.qdrant.io',
        rateLimit: 'No rate limit', purpose: 'Stores and searches document embeddings for context injection',
        model: '',
      },
      {
        name: 'Brevo (Email)', key: 'BREVO_API_KEY', set: !!config.brevo.apiKey,
        usage: 'Email delivery', provider: 'brevo',
        activeRole: !!config.brevo.apiKey ? 'primary' : 'inactive',
        freeLimit: '300 emails/day', paidNote: 'Free plan at brevo.com',
        rateLimit: '300/day (free)', purpose: 'Sends follow-up emails, campaign emails, notifications',
        model: '',
      },
      {
        name: 'Meta WhatsApp', key: 'META_WA_ACCESS_TOKEN', set: !!config.meta.waAccessToken,
        usage: 'WhatsApp messaging', provider: 'meta',
        activeRole: !!config.meta.waAccessToken ? 'primary' : 'inactive',
        freeLimit: '1,000 free conversations/month', paidNote: 'Pricing per conversation after free tier',
        rateLimit: '250 messages/sec', purpose: 'Sends and receives WhatsApp messages from leads and customers',
        model: '',
      },
      {
        name: 'Twilio', key: 'TWILIO_ACCOUNT_SID', set: !!config.twilio.accountSid,
        usage: 'SMS delivery', provider: 'twilio',
        activeRole: !!config.twilio.accountSid ? 'primary' : 'inactive',
        freeLimit: 'Trial credit ~$15', paidNote: 'Pay-per-message after trial',
        rateLimit: '1 msg/sec (trial)', purpose: 'Sends SMS follow-ups, reminders, and campaign messages',
        model: '',
      },
      {
        name: 'Zoho CRM', key: 'ZOHO_CLIENT_ID', set: !!config.zoho.clientId,
        usage: 'CRM sync connector', provider: 'zoho',
        activeRole: !!config.zoho.clientId ? 'primary' : 'inactive',
        freeLimit: 'Free plan (3 users)', paidNote: 'API access included in all plans',
        rateLimit: '200 req/min (free)', purpose: 'Syncs contacts, deals, invoices and other CRM data',
        model: '',
      },
      {
        name: 'HubSpot', key: 'HUBSPOT_CLIENT_ID', set: !!config.hubspot.clientId,
        usage: 'CRM sync connector', provider: 'hubspot',
        activeRole: !!config.hubspot.clientId ? 'primary' : 'inactive',
        freeLimit: 'Free CRM plan', paidNote: 'API rate limits based on plan tier',
        rateLimit: '110 req/10 sec', purpose: 'Syncs HubSpot contacts, deals, and pipeline data',
        model: '',
      },
      {
        name: 'JWT Secret', key: 'JWT_SECRET', set: !!config.jwt.secret,
        usage: 'Auth token signing', provider: 'internal',
        activeRole: 'primary', freeLimit: null, paidNote: 'Internal — no external service',
        rateLimit: 'N/A', purpose: 'Signs and verifies user authentication tokens',
        model: '',
      },
      {
        name: 'Encryption Key', key: 'ENCRYPTION_KEY', set: !!config.encryption.key,
        usage: 'Connector credential encryption', provider: 'internal',
        activeRole: 'primary', freeLimit: null, paidNote: 'Internal — no external service',
        rateLimit: 'N/A', purpose: 'Encrypts stored CRM connector OAuth credentials in MongoDB',
        model: '',
      },
    ];

    const aiServiceOffline = !aiOk;
    sendSuccess(res, { services, apiKeys, aiServiceOffline }, 'System health fetched');
  } catch (err) { next(err); }
});

// GET /admin/system/key-stats — aggregate LLM usage from activity logs + service usage counters
router.get('/system/key-stats', async (_req, res, next) => {
  try {
    const { ActivityLog } = await import('../logs/log.model');
    const { ServiceUsage } = await import('./service-usage.model');

    const now    = new Date();
    const day7   = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const day30  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const today  = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const todayStr = now.toISOString().slice(0, 10);
    const day7Str  = day7.toISOString().slice(0, 10);
    const day30Str = day30.toISOString().slice(0, 10);

    // ── LLM call counts from ActivityLog ──────────────────────────────────────
    const [stats7d, stats30d, statsToday] = await Promise.all([
      ActivityLog.aggregate([
        { $match: { service: 'ai', event: { $in: ['agent.response', 'agent.escalation'] }, createdAt: { $gte: day7 } } },
        { $group: { _id: { provider: '$metadata.provider', model: '$metadata.model' }, calls: { $sum: 1 }, escalations: { $sum: { $cond: [{ $eq: ['$event', 'agent.escalation'] }, 1, 0] } } } },
      ]),
      ActivityLog.aggregate([
        { $match: { service: 'ai', event: { $in: ['agent.response', 'agent.escalation'] }, createdAt: { $gte: day30 } } },
        { $group: { _id: { provider: '$metadata.provider', model: '$metadata.model' }, calls: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $match: { service: 'ai', event: { $in: ['agent.response', 'agent.escalation'] }, createdAt: { $gte: today } } },
        { $group: { _id: { provider: '$metadata.provider', model: '$metadata.model' }, calls: { $sum: 1 } } },
      ]),
    ]);

    // Normalise LLM stats into { [provider]: { today, week, month, model, escalations } }
    const usage: Record<string, { today: number; week: number; month: number; model: string; escalations: number; label?: string }> = {};
    for (const row of stats30d) {
      const p = String(row._id?.provider || 'unknown');
      if (!usage[p]) usage[p] = { today: 0, week: 0, month: 0, model: String(row._id?.model || ''), escalations: 0 };
      usage[p].month += row.calls;
    }
    for (const row of stats7d) {
      const p = String(row._id?.provider || 'unknown');
      if (!usage[p]) usage[p] = { today: 0, week: 0, month: 0, model: String(row._id?.model || ''), escalations: 0 };
      usage[p].week += row.calls;
      usage[p].escalations += (row.escalations as number) || 0;
    }
    for (const row of statsToday) {
      const p = String(row._id?.provider || 'unknown');
      if (!usage[p]) usage[p] = { today: 0, week: 0, month: 0, model: String(row._id?.model || ''), escalations: 0 };
      usage[p].today += row.calls;
    }

    // ── Service usage counters (Brevo, Twilio) from ServiceUsage collection ──
    const serviceProviders = ['brevo', 'twilio'];
    const serviceRows = await ServiceUsage.aggregate([
      { $match: { provider: { $in: serviceProviders }, date: { $gte: day30Str } } },
      { $group: { _id: { provider: '$provider', period: { $cond: [{ $eq: ['$date', todayStr] }, 'today', { $cond: [{ $gte: ['$date', day7Str] }, 'week', 'month'] }] } }, sent: { $sum: '$sent' }, failed: { $sum: '$failed' } } },
    ]);

    for (const row of serviceRows) {
      const p      = String(row._id.provider);
      const period = String(row._id.period) as 'today' | 'week' | 'month';
      if (!usage[p]) usage[p] = { today: 0, week: 0, month: 0, model: '', escalations: 0, label: 'emails' };
      if (p === 'brevo')  usage[p].label = 'emails';
      if (p === 'twilio') usage[p].label = 'messages';
      usage[p][period]      += (row.sent   as number) || 0;
      usage[p].escalations  += period === 'today' ? ((row.failed as number) || 0) : 0; // reuse escalations for failed count
      // week & month should also include today
      if (period === 'today') {
        usage[p].week  += (row.sent as number) || 0;
        usage[p].month += (row.sent as number) || 0;
      } else if (period === 'week') {
        usage[p].month += (row.sent as number) || 0;
      }
    }

    sendSuccess(res, { usage }, 'Key usage stats fetched');
  } catch (err) { next(err); }
});

// GET /admin/security-events — paginated, filterable list of SecurityEvent documents
router.get('/security-events', async (req: AuthRequest, res, next) => {
  try {
    const { SecurityEvent } = await import('../logs/security-event.model');
    const { event, tenantId, ip, from, to } = req.query;
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit  as string) || 50));
    const offset = Math.max(0,               parseInt(req.query.offset as string) || 0);

    const filter: Record<string, unknown> = {};
    if (event)    filter.event    = event;
    if (tenantId) filter.tenantId = tenantId;
    if (ip)       filter.ip       = ip;
    if (from || to) {
      const ts: Record<string, unknown> = {};
      if (from) ts.$gte = new Date(from as string);
      if (to)   ts.$lte = new Date(to   as string);
      filter.timestamp = ts;
    }

    const [events, total] = await Promise.all([
      SecurityEvent.find(filter).sort({ timestamp: -1 }).skip(offset).limit(limit).lean(),
      SecurityEvent.countDocuments(filter),
    ]);
    sendSuccess(res, { events, total, limit, offset }, 'Security events fetched');
  } catch (err) { next(err); }
});

// GET /admin/security-stats — 24h + 7d event counts by type, plus top offending IPs
router.get('/security-stats', async (_req, res, next) => {
  try {
    const { SecurityEvent } = await import('../logs/security-event.model');
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);

    const [stats24h, stats7d, topIPs] = await Promise.all([
      SecurityEvent.aggregate([
        { $match: { timestamp: { $gte: since24h } } },
        { $group: { _id: '$event', count: { $sum: 1 } } },
      ]),
      SecurityEvent.aggregate([
        { $match: { timestamp: { $gte: since7d } } },
        { $group: { _id: '$event', count: { $sum: 1 } } },
      ]),
      SecurityEvent.aggregate([
        { $match: { timestamp: { $gte: since24h }, event: { $in: ['auth.login_failed', 'ratelimit.violation'] } } },
        { $group: { _id: '$ip', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const by24h = Object.fromEntries(stats24h.map((r: { _id: string; count: number }) => [r._id, r.count]));
    const by7d  = Object.fromEntries(stats7d.map((r:  { _id: string; count: number }) => [r._id, r.count]));
    sendSuccess(res, { by24h, by7d, topIPs }, 'Security stats fetched');
  } catch (err) { next(err); }
});

// GET /admin/tenants/:id/crm-sync — shows what's actually in CRMRecord for a tenant (debug)
router.get('/tenants/:id/crm-sync', async (req: AuthRequest, res, next) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.params.id);

    type ModuleRow = { _id: { channel: string; module: string }; count: number; lastSynced: Date };

    const [connectors, modules] = await Promise.all([
      Connector.find({ tenantId: tid }).select('type name isActive syncStatus lastSyncAt syncError'),
      CRMRecord.aggregate<ModuleRow>([
        { $match: { tenantId: tid } },
        { $group: { _id: { channel: '$channel', module: '$module' }, count: { $sum: 1 }, lastSynced: { $max: '$syncedAt' } } },
        { $sort: { '_id.channel': 1, count: -1 } },
      ]),
    ]);

    const isEmpty = modules.length === 0;
    sendSuccess(res, {
      isEmpty,
      connectors: connectors.map((c) => ({
        type: c.type, name: c.name, isActive: c.isActive,
        syncStatus: c.syncStatus, lastSyncAt: c.lastSyncAt, syncError: c.syncError || null,
      })),
      crmModules: modules.map((m: ModuleRow) => ({
        channel: m._id.channel, module: m._id.module,
        count: m.count, lastSynced: m.lastSynced,
      })),
      diagnosis: isEmpty
        ? 'No CRM data synced yet — go to Connectors and click Sync.'
        : `${modules.length} module(s) synced. AI can answer questions about: ${modules.map((m: ModuleRow) => m._id.module).join(', ')}.`,
    }, 'CRM sync status');
  } catch (err) { next(err); }
});

// GET /admin/security-posture — Security Health Score + config checks
router.get('/security-posture', async (_req, res, next) => {
  try {
    const { SecurityEvent } = await import('../logs/security-event.model');
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [failedLogins24h, rateLimitHits24h, webhookFails24h, tokenErrors24h] = await Promise.all([
      SecurityEvent.countDocuments({ event: 'auth.login_failed',   timestamp: { $gte: since24h } }),
      SecurityEvent.countDocuments({ event: 'ratelimit.violation', timestamp: { $gte: since24h } }),
      SecurityEvent.countDocuments({ event: 'webhook.sig_invalid', timestamp: { $gte: since24h } }),
      SecurityEvent.countDocuments({ event: { $in: ['auth.token_expired', 'auth.token_invalid'] }, timestamp: { $gte: since24h } }),
    ]);

    // Config checks
    const checks = [
      { id: 'jwt_secret',       label: 'JWT Secret configured',            pass: !!config.jwt.secret && config.jwt.secret !== 'changeme' },
      { id: 'jwt_refresh',      label: 'JWT Refresh Secret configured',    pass: !!config.jwt.refreshSecret && config.jwt.refreshSecret !== 'changeme' },
      { id: 'encryption_key',   label: 'Encryption key configured',        pass: !!config.encryption?.key },
      { id: 'internal_key',     label: 'Internal service key configured',  pass: !!config.ai?.internalServiceKey },
      { id: 'brevo_configured', label: 'Email alerting configured (Brevo)', pass: !!config.brevo?.apiKey },
      { id: 'failed_logins',    label: 'No brute-force activity (24h)',     pass: failedLogins24h < 10 },
      { id: 'rate_limits',      label: 'No rate-limit spikes (24h)',        pass: rateLimitHits24h < 20 },
      { id: 'webhook_sigs',     label: 'No webhook signature failures (24h)', pass: webhookFails24h < 5 },
      { id: 'token_errors',     label: 'No token errors (24h)',             pass: tokenErrors24h < 10 },
    ];

    let score = 100;
    for (const c of checks) {
      if (!c.pass) score -= 11;
    }
    score = Math.max(0, score);

    const grade = score >= 85 ? 'good' : score >= 60 ? 'warning' : 'critical';

    sendSuccess(res, {
      score,
      grade,
      checks,
      events24h: { failedLogins24h, rateLimitHits24h, webhookFails24h, tokenErrors24h },
    }, 'Security posture fetched');
  } catch (err) { next(err); }
});

// GET /admin/connector-health — aggregate all connectors by sync status
router.get('/connector-health', async (_req, res, next) => {
  try {
    const connectors = await Connector.find({})
      .select('tenantId type name isActive syncStatus lastSyncAt syncError createdAt')
      .populate('tenantId', 'name')
      .lean();

    const stats = {
      total:    connectors.length,
      active:   connectors.filter((c) => c.isActive).length,
      healthy:  connectors.filter((c) => c.syncStatus === 'success').length,
      failed:   connectors.filter((c) => c.syncStatus === 'failed').length,
      pending:  connectors.filter((c) => !c.syncStatus || c.syncStatus === 'idle').length,
    };

    const list = connectors.map((c) => ({
      id:          (c._id as mongoose.Types.ObjectId).toString(),
      type:        c.type,
      name:        c.name,
      isActive:    c.isActive,
      syncStatus:  c.syncStatus || 'never',
      lastSyncAt:  c.lastSyncAt || null,
      syncError:   c.syncError  || null,
      tenant:      (c.tenantId as unknown as { name?: string })?.name || c.tenantId,
    }));

    sendSuccess(res, { stats, connectors: list }, 'Connector health fetched');
  } catch (err) { next(err); }
});

// GET /admin/sessions — all active sessions grouped by user
router.get('/sessions', async (_req, res, next) => {
  try {
    const sessions = await UserSession.find({ expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();

    const userIds = [...new Set(sessions.map((s) => s.userId))];
    const users   = await User.find({ _id: { $in: userIds } })
      .select('firstName lastName email role tenantId')
      .lean();

    const userMap = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

    const enriched = sessions.map((s) => ({
      id:        (s._id as mongoose.Types.ObjectId).toString(),
      userId:    s.userId,
      user:      userMap[s.userId] ?? null,
      tenantId:  s.tenantId,
      ip:        s.ip,
      city:      s.city    || 'Unknown',
      country:   s.country || 'Unknown',
      browser:   s.browser,
      os:        s.os,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));

    sendSuccess(res, { sessions: enriched, total: enriched.length }, 'Active sessions fetched');
  } catch (err) { next(err); }
});

// DELETE /admin/sessions/:id — terminate a single session
router.delete('/sessions/:id', async (req: AuthRequest, res, next) => {
  try {
    const session = await UserSession.findByIdAndDelete(req.params.id);
    if (!session) { sendError(res, 'Session not found', 404); return; }

    // Clear refresh token on the user so the next token refresh is rejected
    await User.findByIdAndUpdate(session.userId, { $unset: { refreshToken: 1 } });

    logAuditEvent(
      'session.terminated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { target: 'UserSession', targetId: session._id.toString(), detail: { targetUserId: session.userId, ip: session.ip, browser: session.browser } },
    );

    sendSuccess(res, null, 'Session terminated');
  } catch (err) { next(err); }
});

// DELETE /admin/sessions/user/:userId/all — terminate all sessions for a user
router.delete('/sessions/user/:userId/all', async (req: AuthRequest, res, next) => {
  try {
    const { deletedCount } = await UserSession.deleteMany({ userId: req.params.userId });
    await User.findByIdAndUpdate(req.params.userId, { $unset: { refreshToken: 1 } });
    logAuditEvent(
      'session.terminated_all',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { target: 'User', targetId: req.params.userId, detail: { deletedCount } },
    );
    sendSuccess(res, { deletedCount }, 'All user sessions terminated');
  } catch (err) { next(err); }
});

// GET /admin/audit-logs — filterable audit trail
router.get('/audit-logs', async (req: AuthRequest, res, next) => {
  try {
    const { tenantId, action, actorId, from, to } = req.query;
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit  as string) || 50));
    const offset = Math.max(0,               parseInt(req.query.offset as string) || 0);

    const filter: Record<string, unknown> = {};
    if (tenantId) filter.tenantId = tenantId;
    if (action)   filter.action   = action;
    if (actorId)  filter.actorId  = actorId;
    if (from || to) {
      const ts: Record<string, unknown> = {};
      if (from) ts.$gte = new Date(from as string);
      if (to)   ts.$lte = new Date(to   as string);
      filter.timestamp = ts;
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ timestamp: -1 }).skip(offset).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);

    sendSuccess(res, { logs, total, limit, offset }, 'Audit logs fetched');
  } catch (err) { next(err); }
});

// GET /admin/tenants/:id/features — get feature flags for a tenant
router.get('/tenants/:id/features', async (req: AuthRequest, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.id).select('featureFlags name');
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    const { DEFAULT_FEATURE_FLAGS } = await import('../tenants/tenant.model');
    // Convert Mongoose subdocument → plain object so all saved fields (including false values) are present
    const rawFlags = tenant.featureFlags as unknown as { toObject?: () => Record<string, unknown> } | undefined;
    const saved = rawFlags?.toObject ? rawFlags.toObject() : (tenant.featureFlags ?? {});
    const flags = { ...DEFAULT_FEATURE_FLAGS, ...saved };
    sendSuccess(res, { flags, tenantName: tenant.name });
  } catch (err) { next(err); }
});

// PUT /admin/tenants/:id/features — update feature flags for a tenant
router.put('/tenants/:id/features', async (req: AuthRequest, res, next) => {
  try {
    const { flags } = req.body as { flags: Record<string, boolean> };
    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { featureFlags: flags } },
      { new: true, runValidators: false }
    ).select('featureFlags name');
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    logAuditEvent(
      'feature_flags.updated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: req.params.id, target: 'Tenant', targetId: req.params.id, detail: { tenantName: tenant.name, flags } },
    );
    sendSuccess(res, { flags: tenant.featureFlags, tenantName: tenant.name }, 'Feature flags updated');
  } catch (err) { next(err); }
});

export default router;
