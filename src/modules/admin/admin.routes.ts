import { Router, Response, NextFunction } from 'express';
import axios from 'axios';
import { z } from 'zod';
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
import { checkBrevoHealth, sendEmailNow, buildTenantCredentialsEmail } from '../messages/brevo.service';
import { checkTwilioHealth } from '../messages/twilio.service';
import { isWhatsAppConfigured } from '../messages/whatsapp.service';
import { ChatSession } from '../bot/chat-session.model';
import { attachAiActionTrace } from '../bot/chat-trace.util';
import { sendCreated } from '../../utils/response';
import { provisionTenant, getEffectiveFeatureFlags, forceAddUserSeat, updateTenantAiLimits, getAiUsage, getOrInitCreditsResetDate } from '../tenants/tenant.service';
import { getPlatformDefaults, setPlatformDefaults, getAiPlanDefaults, setAiPlanDefaults, getPlanLimits, DEFAULT_AI_PLAN_DEFAULTS } from './platform-defaults.model';
import { generatePassword } from '../native-crm/shared/app-credentials.service';
import { logger } from '../../utils/logger';
import { Role } from '../rbac/role.model';
import { assertPasswordUniqueAtTenant, isPasswordTakenAtTenant } from '../auth/auth.service';

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

    // Scoped to the same non-demo tenant set totalClients/uniqueClientIds
    // already uses above — these used to be unscoped .countDocuments() calls,
    // which silently pulled in both the leadryze-demo tenant's own data (the
    // "ALL CLIENTS" list below deliberately hides that tenant, so its records
    // were invisibly inflating every total) AND any records still pointing at
    // a tenantId that no longer exists in the tenants collection at all (a
    // hard-deleted tenant whose Customer/Campaign docs were never cleaned
    // up). Scoping to nonDemoTenantIds excludes both categories at once, so
    // every number here now actually equals the sum of what's enumerable in
    // the client cards below — which is the entire point of an "at a glance"
    // platform total.
    const [totalCustomers, activeConnectors, totalUsers, totalMessages, totalCampaigns] =
      await Promise.all([
        Customer.countDocuments({ tenantId: { $in: nonDemoTenantIds } }),
        Connector.countDocuments({ tenantId: { $in: nonDemoTenantIds }, isActive: true }),
        User.countDocuments({ tenantId: { $in: nonDemoTenantIds }, role: { $ne: 'SUPER_ADMIN' } }),
        Message.countDocuments({ tenantId: { $in: nonDemoTenantIds } }),
        Campaign.countDocuments({ tenantId: { $in: nonDemoTenantIds } }),
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
            // `admin` (the TENANT_ADMIN this tenant doc is being recreated
            // for) already exists — one seat already in use.
            maxUsers: 5, currentUserCount: 1, maxLeadsPerMonth: 500,
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
              .select('firstName lastName email emailVerified createdAt'),
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
    // LR-ADMIN-003: the Tenants list/stats deliberately hide the internal
    // leadryze-demo tenant (see the comment above) — this endpoint never
    // applied the same exclusion, so its users showed up here attributed
    // to a tenant that doesn't appear anywhere in the Tenants list at all.
    const demoTenant = await Tenant.findOne({ slug: 'leadryze-demo' }).select('_id').lean();
    const users = await User.find({
      role: { $ne: 'SUPER_ADMIN' },
      ...(demoTenant ? { tenantId: { $ne: demoTenant._id } } : {}),
    })
      .sort({ createdAt: -1 })
      .populate('tenantId', 'name slug plan isActive clientId');
    sendSuccess(res, users, 'Users fetched');
  } catch (err) { next(err); }
});

// Reused by createUserForTenant() below — TENANT_ADMIN maps to the
// tenant's seeded "Admin" system role; matches the map already used by
// user.routes.ts's own POST / (a Tenant Admin inviting their own team).
const ROLE_TO_SYSTEM_ROLE_NAME: Record<string, string> = {
  TENANT_ADMIN: 'Admin', MANAGER: 'Manager', AGENT: 'Agent', USER: 'Agent',
};

// POST /admin/users — Super Admin adds a user directly to an EXISTING
// tenant. Deliberately does not offer SUPER_ADMIN as a role here — creating
// another Super Admin is a materially higher-stakes action than adding a
// tenant's team member and isn't exposed through this generic form.
router.post('/users', async (req: AuthRequest, res, next) => {
  try {
    const { tenantId, firstName, lastName, email, role, password: suppliedPassword } = req.body as {
      tenantId?: string; firstName?: string; lastName?: string; email?: string; role?: string; password?: string;
    };

    if (!tenantId || !mongoose.isValidObjectId(tenantId)) { sendError(res, 'A valid tenantId is required', 400); return; }
    if (!firstName?.trim()) { sendError(res, 'First name is required', 400); return; }
    if (!lastName?.trim())  { sendError(res, 'Last name is required', 400); return; }
    if (!email?.trim())     { sendError(res, 'Email is required', 400); return; }
    // LR-USER-001: this route never checked email format at all — any
    // non-empty string ("not-an-email") was accepted and saved.
    if (!z.string().email().safeParse(email.trim()).success) { sendError(res, 'A valid email address is required', 400); return; }
    const allowedRoles = ['TENANT_ADMIN', 'MANAGER', 'AGENT', 'USER'];
    if (!role || !allowedRoles.includes(role)) { sendError(res, `Role must be one of: ${allowedRoles.join(', ')}`, 400); return; }

    const tenant = await Tenant.findById(tenantId).select('name clientId').lean();
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }

    const normalizedEmail = email.toLowerCase().trim();
    const exists = await User.findOne({ email: normalizedEmail, tenantId });
    if (exists) { sendError(res, 'A user with this email already exists in this tenant', 409); return; }

    let password = suppliedPassword;
    if (password) {
      if (password.length < 8) { sendError(res, 'Password must be at least 8 characters', 400); return; }
      await assertPasswordUniqueAtTenant(tenantId, password);
    } else {
      // Auto-generated — retry on the astronomically rare chance it
      // collides with an existing password at this tenant.
      let tries = 0;
      do {
        password = generatePassword();
        tries++;
      } while (tries < 10 && await isPasswordTakenAtTenant(tenantId, password));
    }

    const user = await User.create({
      email: normalizedEmail,
      password, // hashed by the model's pre-save hook — never written raw
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role,
      tenantId: new mongoose.Types.ObjectId(tenantId),
      // Only TENANT_ADMIN carries the tenant's clientId — matches
      // registerUser()/provisionTenant()'s convention. Login itself no
      // longer depends on this field (it resolves via {tenantId,email}),
      // this is purely for display/consistency with those other paths.
      ...(role === 'TENANT_ADMIN' ? { clientId: tenant.clientId } : {}),
      isActive: true,
      emailVerified: true, // admin-created — skips the verification step
      mustChangePassword: true,
    });

    // Super Admin bypasses the tenant's own seat cap (no block here), but
    // the new user still occupies a real seat — count it so a later
    // self-service invite from the tenant's own Users page can't silently
    // slip past the real limit.
    await forceAddUserSeat(tenantId);

    // Fire-and-forget role assignment — tenant's system roles already exist
    // (seeded at tenant-creation time), just look one up by name.
    const systemRoleName = ROLE_TO_SYSTEM_ROLE_NAME[role];
    Role.findOne({ tenantId, name: systemRoleName }, '_id').lean()
      .then((roleDoc) => { if (roleDoc) return User.findByIdAndUpdate(user._id, { roleId: roleDoc._id }); })
      .catch(() => {});

    let emailSent = true;
    try {
      const emailBody = buildTenantCredentialsEmail({
        toName: firstName.trim(),
        accountEmail: normalizedEmail,
        loginId: user.loginId ?? tenant.clientId ?? '(missing Login ID)',
        password,
        frontendUrl: config.app.frontendUrl,
      });
      await sendEmailNow({ ...emailBody, to: normalizedEmail, toName: `${firstName.trim()} ${lastName.trim()}` });
    } catch (err) {
      emailSent = false;
      logger.error('New-user credentials email failed', { tenantId, email: normalizedEmail, error: (err as Error).message });
    }

    logAuditEvent('user.created_by_admin',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId, target: 'User', targetId: user._id.toString(), detail: { tenantName: tenant.name, userEmail: normalizedEmail, role, emailSent } },
    );

    const userObj = user.toObject() as unknown as Record<string, unknown>;
    delete userObj.password;
    delete userObj.refreshToken;
    delete userObj.passwordEnc;

    sendCreated(res, { user: userObj, loginId: user.loginId ?? tenant.clientId, temporaryPassword: password, emailSent }, 'User created — credentials emailed');
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

// POST /admin/users/:id/reset-password — set a new password for any user.
// Two modes, distinguished only by the new `sendEmail` flag so the existing
// typed-password caller (UsersPage.tsx) is byte-for-byte unaffected:
//   - existing: { password } — sets exactly that password, no email, no
//     forced change, response carries no password (unchanged behavior).
//   - new, "Regenerate Tenant Admin Password": { sendEmail: true }, no
//     password supplied — server generates one via generatePassword(),
//     forces a change on next login, emails the credentials (Client ID +
//     password), and always returns the plaintext password in the response
//     as the guaranteed fallback if the email fails to send.
router.post('/users/:id/reset-password', async (req: AuthRequest, res, next) => {
  try {
    const { password: suppliedPassword, sendEmail } = req.body as { password?: string; sendEmail?: boolean };
    if (suppliedPassword && suppliedPassword.length < 8) {
      sendError(res, 'Password must be at least 8 characters', 400); return;
    }
    if (!suppliedPassword && !sendEmail) {
      sendError(res, 'Password must be at least 8 characters', 400); return;
    }

    const user = await User.findById(req.params.id).select('+password');
    if (!user) { sendError(res, 'User not found', 404); return; }

    let password = suppliedPassword;
    if (password) {
      try {
        await assertPasswordUniqueAtTenant(user.tenantId, password, req.params.id);
      } catch (err) { next(err); return; }
    } else {
      // Auto-generated — retry on the astronomically rare chance it
      // collides with an existing password at this tenant.
      let tries = 0;
      do {
        password = generatePassword();
        tries++;
      } while (tries < 10 && await isPasswordTakenAtTenant(user.tenantId, password, req.params.id));
    }

    user.password = password;
    await user.save(); // triggers bcrypt pre-save hook
    await User.findByIdAndUpdate(req.params.id, {
      $unset: { refreshToken: 1 },
      ...(sendEmail ? { mustChangePassword: true } : {}),
    });

    let emailSent: boolean | undefined;
    if (sendEmail) {
      emailSent = true;
      try {
        // Falls back to the tenant's clientId if this user predates the
        // per-user loginId migration and hasn't been backfilled yet.
        const userTenant = await Tenant.findById(user.tenantId).select('clientId').lean();
        const emailBody = buildTenantCredentialsEmail({
          toName: user.firstName,
          accountEmail: user.email,
          loginId: user.loginId ?? userTenant?.clientId ?? '(missing Login ID)',
          password,
          frontendUrl: config.app.frontendUrl,
        });
        await sendEmailNow({ ...emailBody, to: user.email, toName: `${user.firstName} ${user.lastName}`, subject: 'Your LeadRyze AI password has been reset' });
      } catch (err) {
        emailSent = false;
        logger.error('Password-reset credential email failed', { userId: req.params.id, error: (err as Error).message });
      }
    }

    logAuditEvent('user.password_reset_by_admin',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { target: 'User', targetId: req.params.id, detail: { userEmail: user.email, ...(sendEmail ? { emailSent } : {}) } },
    );
    sendSuccess(res, sendEmail ? { password, emailSent, loginId: user.loginId } : null, 'Password reset successfully');
  } catch (err) { next(err); }
});

// GET /admin/tenants/:id — single tenant detail (users, recent customers, recent messages)
router.get('/tenants/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }

    const tid = tenant._id;
    const [usersRaw, customerCount, recentCustomers, recentMessages, connectors, campaigns] = await Promise.all([
      User.find({ tenantId: tid }).select('firstName lastName email role emailVerified createdAt mustChangePassword loginId'),
      // LR-ADMIN-001: the Tenants list computes this the same way — the
      // detail page never did, so it always showed blank.
      Customer.countDocuments({ tenantId: tid }),
      Customer.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(5).select('name email phone channel createdAt'),
      Message.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(10)
        .select('content channel direction aiGenerated status createdAt')
        .populate('customerId', 'name email'),
      Connector.find({ tenantId: tid }).select('type isActive createdAt'),
      Campaign.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(5).select('name type status stats createdAt'),
    ]);

    const tenantWithCounts = { ...tenant.toObject(), customerCount, userCount: usersRaw.length };
    sendSuccess(res, { tenant: tenantWithCounts, users: usersRaw, recentCustomers, recentMessages, connectors, campaigns }, 'Tenant detail fetched');
  } catch (err) { next(err); }
});

// POST /admin/tenants — Super Admin direct tenant creation (Flow A):
// generates Client ID + password immediately, no approval step needed.
router.post('/tenants', async (req: AuthRequest, res, next) => {
  try {
    const { name, plan, domain, contactEmail, contactPhone, adminFirstName, adminLastName, adminEmail } = req.body ?? {};
    if (!name?.trim()) { sendError(res, 'Business name is required', 400); return; }
    if (!adminFirstName?.trim() || !adminLastName?.trim()) { sendError(res, 'Tenant admin first and last name are required', 400); return; }
    if (!adminEmail?.trim()) { sendError(res, 'Tenant admin email is required', 400); return; }
    if (!z.string().email().safeParse(adminEmail.trim()).success) { sendError(res, 'A valid tenant admin email is required', 400); return; }
    // LR-ADMIN-004: Business Contact Email had no format check at all.
    if (contactEmail?.trim() && !z.string().email().safeParse(contactEmail.trim()).success) {
      sendError(res, 'A valid business contact email is required', 400); return;
    }

    const existing = await User.findOne({ email: adminEmail.toLowerCase().trim() });
    if (existing) { sendError(res, 'A user with this email already exists', 409); return; }

    const result = await provisionTenant({
      name: name.trim(), plan, domain, contactEmail, contactPhone,
      adminFirstName: adminFirstName.trim(), adminLastName: adminLastName.trim(), adminEmail: adminEmail.trim(),
    });

    logAuditEvent('tenant.provisioned',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: result.tenant._id.toString(), target: 'Tenant', targetId: result.tenant._id.toString(),
        detail: { tenantName: result.tenant.name, clientId: result.clientId, adminEmail: result.adminUser.email, emailSent: result.emailSent } },
    );
    sendCreated(res, result, 'Tenant created — credentials emailed to the tenant admin');
  } catch (err) { next(err); }
});

// POST /admin/tenants/:id/approve — Flow B: strictly a one-time
// pending/rejected -> approved transition. Never regenerates credentials
// for an already-approved tenant — that's what Regenerate Password is for.
router.post('/tenants/:id/approve', async (req: AuthRequest, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    if (tenant.approvalStatus === 'approved' || tenant.approvalStatus === undefined) {
      sendError(res, 'This tenant is already approved — use Regenerate Tenant Admin Password to issue a new password', 409);
      return;
    }

    const adminUser = await User.findOne({ tenantId: tenant._id, role: 'TENANT_ADMIN' }).select('+password');
    if (!adminUser) { sendError(res, 'No tenant admin user found for this tenant', 404); return; }
    if (!adminUser.emailVerified) {
      sendError(res, "Cannot approve — the tenant admin's email is not verified yet", 400);
      return;
    }

    // Auto-generated — retry on the astronomically rare chance it
    // collides with an existing password at this tenant (e.g. a Manager
    // added via Add User before this approval happened).
    let temporaryPassword = generatePassword();
    let tries = 0;
    while (tries < 10 && await isPasswordTakenAtTenant(tenant._id, temporaryPassword, adminUser._id.toString())) {
      temporaryPassword = generatePassword();
      tries++;
    }
    adminUser.password = temporaryPassword; // hashed by the model's pre-save hook
    await adminUser.save();
    await User.findByIdAndUpdate(adminUser._id, { mustChangePassword: true });

    tenant.approvalStatus = 'approved';
    await tenant.save();

    let emailSent = true;
    try {
      const emailBody = buildTenantCredentialsEmail({
        toName: adminUser.firstName,
        accountEmail: adminUser.email,
        loginId: adminUser.loginId ?? tenant.clientId ?? '(missing Login ID)',
        password: temporaryPassword,
        frontendUrl: config.app.frontendUrl,
      });
      await sendEmailNow({ ...emailBody, to: adminUser.email, toName: `${adminUser.firstName} ${adminUser.lastName}` });
    } catch (err) {
      emailSent = false;
      logger.error('Tenant approval credentials email failed', { tenantId: tenant._id.toString(), email: adminUser.email, error: (err as Error).message });
    }

    logAuditEvent('tenant.approved',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: tenant._id.toString(), target: 'Tenant', targetId: tenant._id.toString(),
        detail: { tenantName: tenant.name, clientId: tenant.clientId, adminEmail: adminUser.email, emailSent } },
    );
    sendSuccess(res, { loginId: adminUser.loginId ?? tenant.clientId, email: adminUser.email, temporaryPassword, emailSent }, 'Tenant approved — credentials emailed to the tenant admin');
  } catch (err) { next(err); }
});

// POST /admin/tenants/:id/reject — Flow B: marks a pending signup as
// rejected. No credentials are ever generated for a rejected tenant.
router.post('/tenants/:id/reject', async (req: AuthRequest, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    tenant.approvalStatus = 'rejected';
    await tenant.save();
    logAuditEvent('tenant.rejected',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: tenant._id.toString(), target: 'Tenant', targetId: tenant._id.toString(), detail: { tenantName: tenant.name } },
    );
    sendSuccess(res, { approvalStatus: 'rejected' }, 'Tenant signup rejected');
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
    const previousIsActive = tenant.isActive;
    const { reason } = (req.body ?? {}) as { reason?: string };
    tenant.isActive = !tenant.isActive;
    await tenant.save();
    logAuditEvent(
      tenant.isActive ? 'client.activated' : 'client.deactivated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: tenant._id.toString(), target: 'Tenant', targetId: tenant._id.toString(), detail: { tenantName: tenant.name, previousIsActive, newIsActive: tenant.isActive, ...(reason ? { reason } : {}) } },
    );
    // LR-UX-001: user-facing message said "Client" while the rest of this
    // UI (and the person using it) calls this a "Tenant" — the internal
    // audit event name above is untouched, only the message shown to the
    // Super Admin.
    sendSuccess(res, { isActive: tenant.isActive }, `Tenant ${tenant.isActive ? 'activated' : 'deactivated'}`);
  } catch (err) { next(err); }
});

// GET /admin/system/health — service health + API key presence check
router.get('/system/health', async (_req, res, next) => {
  try {
    // MongoDB
    const mongoOk = mongoose.connection.readyState === 1;

    // AI service ping — capture response body for key statuses + its own
    // already-computed live checks (Qdrant reachability lives here, not a
    // new check on the backend side — the AI service already pings it).
    let aiOk = false;
    let aiKeys: Record<string, boolean | string> = {};
    let aiChecks: Record<string, 'ok' | 'degraded'> = {};
    let voiceAgent: { running: boolean; lastHeartbeatAt: string | null; ageSeconds: number | null } | null = null;
    try {
      const aiRes = await axios.get(`${config.app.aiServiceUrl}/health/detail`, {
        timeout: 4000,
        headers: { 'x-api-key': config.ai.internalApiKey },
      });
      aiOk = true;
      if (aiRes.data?.keys) aiKeys = aiRes.data.keys;
      if (aiRes.data?.checks) aiChecks = aiRes.data.checks;
      if (aiRes.data?.voiceAgent) voiceAgent = aiRes.data.voiceAgent;
    } catch { /* offline */ }
    const qdrantOk = aiChecks.qdrant === 'ok';
    const voiceAgentOk = !!voiceAgent?.running;

    // Brevo/Twilio — real, side-effect-free reachability pings, not just
    // "is the API key set" (which the apiKeys list below already shows).
    const [brevoOk, twilioOk] = await Promise.all([checkBrevoHealth(), checkTwilioHealth()]);

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
      { name: 'Qdrant',     status: qdrantOk ? 'ok' : 'error', detail: aiOk ? (qdrantOk ? 'Reachable' : 'Unreachable') : 'Unknown (AI service offline)' },
      { name: 'Brevo',      status: brevoOk  ? 'ok' : 'error', detail: brevoOk  ? 'Reachable' : (config.brevo.apiKey ? 'Unreachable' : 'Not configured') },
      { name: 'Twilio',     status: twilioOk ? 'ok' : 'error', detail: twilioOk ? 'Reachable' : (config.twilio.accountSid ? 'Unreachable' : 'Not configured') },
      {
        name: 'Voice Agent Worker',
        status: voiceAgentOk ? 'ok' : 'error',
        detail: !aiOk
          ? 'Unknown (AI service offline)'
          : voiceAgentOk
            ? `Running (last heartbeat ${Math.round(voiceAgent!.ageSeconds ?? 0)}s ago)`
            : 'Not running — start with `npm run voice-agent` (or `npm run dev:with-voice`) in ai/',
      },
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
        // isWhatsAppConfigured() (not a raw !!config.meta.waAccessToken check)
        // — this repo's own .env ships literal placeholder values
        // ('your-whatsapp-access-token' etc.), which a plain truthy check
        // would misreport as "Configured" even though sendWhatsAppNow()
        // treats them as absent and skips sending. See whatsapp.service.ts's
        // own PLACEHOLDER_VALUES comment for the full reasoning.
        name: 'Meta WhatsApp', key: 'META_WA_ACCESS_TOKEN', set: isWhatsAppConfigured(),
        usage: 'WhatsApp messaging', provider: 'meta',
        activeRole: isWhatsAppConfigured() ? 'primary' : 'inactive',
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
        // config.jwt.secret always has a truthy fallback value even when
        // JWT_SECRET was never set (see config/index.ts) — checking the raw
        // env var directly instead is the only way this badge can ever show
        // "not configured" for a real misconfiguration. (A separate startup
        // guard already blocks production boot on the insecure fallback;
        // this fixes the Health page's own badge to agree with that, rather
        // than always reporting "Configured".)
        name: 'JWT Secret', key: 'JWT_SECRET', set: !!process.env.JWT_SECRET,
        usage: 'Auth token signing', provider: 'internal',
        activeRole: 'primary', freeLimit: null, paidNote: 'Internal — no external service',
        rateLimit: 'N/A', purpose: 'Signs and verifies user authentication tokens',
        model: '',
      },
      {
        // Same fallback-masking issue as JWT Secret above — config.encryption.key
        // is never falsy, so the real env var must be checked directly.
        name: 'Encryption Key', key: 'ENCRYPTION_KEY', set: !!process.env.ENCRYPTION_KEY,
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

    // ── Service usage counters (Brevo, Twilio, Meta WhatsApp) from ServiceUsage collection ──
    const serviceProviders = ['brevo', 'twilio', 'meta'];
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
      if (p === 'meta')   usage[p].label = 'messages';
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

// GET /admin/ai-usage — per-tenant LLM token/cost/quota breakdown, built on the
// tenant-scoped AiTokenUsage collection (populated by the AI service after every
// real LLM call — see ai/src/agents/base.agent.ts's trackAiTokenUsage call).
router.get('/ai-usage', async (_req, res, next) => {
  try {
    const { AiTokenUsage } = await import('./ai-token-usage.model');

    const tenants = await Tenant.find({ isActive: true })
      .select('name plan aiConfig.monthlyTokenLimit aiConfig.monthlyVoiceMinutesLimit aiConfig.creditsLastResetAt').lean();

    // Prepaid-credit model: each tenant's own usage window starts at ITS
    // OWN creditsLastResetAt, not a single shared calendar-month start — so
    // this can no longer be one $match date >= X for every tenant at once.
    // Self-heals any tenant missing the field (stamps "now"), then pulls
    // every usage row from the EARLIEST reset date across all of them in one
    // query, and filters/sums per-tenant in memory against that tenant's own
    // date — still one DB round-trip, just not a single server-side $group.
    const resetDates = await Promise.all(
      tenants.map((t: any) => getOrInitCreditsResetDate(String(t._id), t.aiConfig?.creditsLastResetAt)),
    );
    const resetDateByTenant = new Map(tenants.map((t: any, i: number) => [String(t._id), resetDates[i]]));
    const earliestReset = resetDates.reduce((min, d) => (d < min ? d : min), resetDates[0] ?? new Date());
    const earliestResetKey = earliestReset.toISOString().slice(0, 10);

    const usageRows = await AiTokenUsage.find({ date: { $gte: earliestResetKey } }).lean();

    const usageByTenant = new Map<string, any>();
    for (const row of usageRows) {
      const tid = String(row.tenantId);
      const resetAt = resetDateByTenant.get(tid);
      if (!resetAt || row.date < resetAt.toISOString().slice(0, 10)) continue; // before THIS tenant's own reset
      const acc = usageByTenant.get(tid) ?? {
        totalTokens: 0, estimatedCostUsd: 0, requestCount: 0, moderationFallbackCount: 0,
        sttSeconds: 0, ttsCharacters: 0, voiceCostUsd: 0, voiceRequestCount: 0,
        continuousVoiceMinutes: 0, continuousVoiceSessionCount: 0, deepgramSttSeconds: 0,
        cartesiaTtsCharacters: 0, continuousVoiceCostUsd: 0,
      };
      acc.totalTokens += row.totalTokens || 0;
      acc.estimatedCostUsd += row.estimatedCostUsd || 0;
      acc.requestCount += row.requestCount || 0;
      acc.moderationFallbackCount += row.moderationFallbackCount || 0;
      acc.sttSeconds += row.sttSeconds || 0;
      acc.ttsCharacters += row.ttsCharacters || 0;
      acc.voiceCostUsd += row.voiceCostUsd || 0;
      acc.voiceRequestCount += row.voiceRequestCount || 0;
      acc.continuousVoiceMinutes += row.continuousVoiceMinutes || 0;
      acc.continuousVoiceSessionCount += row.continuousVoiceSessionCount || 0;
      acc.deepgramSttSeconds += row.deepgramSttSeconds || 0;
      acc.cartesiaTtsCharacters += row.cartesiaTtsCharacters || 0;
      acc.continuousVoiceCostUsd += row.continuousVoiceCostUsd || 0;
      usageByTenant.set(tid, acc);
    }

    // Single shared source (Super-Admin-editable via Platform Defaults) —
    // replaces what used to be 3 independently-hardcoded copies of the same
    // per-plan maps (this file, tenant.service.ts, and ai/src/services/
    // context.builder.ts). Fetched once outside the tenants loop below.
    const aiPlanDefaults = await getAiPlanDefaults();

    const rows = tenants
      .map((t: any) => {
        const usageRow = usageByTenant.get(String(t._id));
        const planDefaults = aiPlanDefaults[t.plan as keyof typeof aiPlanDefaults] ?? aiPlanDefaults.starter;
        const monthlyTokenLimit = t.aiConfig?.monthlyTokenLimit ?? planDefaults.monthlyTokenLimit;
        const tokensUsedThisMonth = usageRow?.totalTokens ?? 0;
        const monthlyVoiceMinutesLimit = t.aiConfig?.monthlyVoiceMinutesLimit ?? planDefaults.monthlyVoiceMinutesLimit;
        const continuousVoiceMinutesUsed = usageRow?.continuousVoiceMinutes ?? 0;
        return {
          creditsLastResetAt: resetDateByTenant.get(String(t._id)),
          tenantId: String(t._id),
          tenantName: t.name,
          plan: t.plan,
          monthlyTokenLimit,
          tokensUsedThisMonth,
          percentUsed: monthlyTokenLimit > 0 ? tokensUsedThisMonth / monthlyTokenLimit : 0,
          estimatedCostUsd: usageRow?.estimatedCostUsd ?? 0,
          requestCount: usageRow?.requestCount ?? 0,
          moderationFallbackCount: usageRow?.moderationFallbackCount ?? 0,
          sttSeconds: usageRow?.sttSeconds ?? 0,
          ttsCharacters: usageRow?.ttsCharacters ?? 0,
          voiceCostUsd: usageRow?.voiceCostUsd ?? 0,
          voiceRequestCount: usageRow?.voiceRequestCount ?? 0,
          monthlyVoiceMinutesLimit,
          continuousVoiceMinutesUsed,
          voiceMinutesPercentUsed: monthlyVoiceMinutesLimit > 0 ? continuousVoiceMinutesUsed / monthlyVoiceMinutesLimit : 0,
          continuousVoiceSessionCount: usageRow?.continuousVoiceSessionCount ?? 0,
          deepgramSttSeconds: usageRow?.deepgramSttSeconds ?? 0,
          cartesiaTtsCharacters: usageRow?.cartesiaTtsCharacters ?? 0,
          continuousVoiceCostUsd: usageRow?.continuousVoiceCostUsd ?? 0,
        };
      })
      .sort((a, b) => b.percentUsed - a.percentUsed);

    sendSuccess(res, { tenants: rows }, 'AI usage fetched');
  } catch (err) { next(err); }
});

// GET /admin/conversations — paginated, filterable list across all tenants,
// built entirely on the existing ChatSession collection (already stores the
// full transcript per session) — no new tracking, purely a read layer.
router.get('/conversations', async (req: AuthRequest, res, next) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const filter: any = {};
    if (req.query.tenantId) filter.tenantId = req.query.tenantId;
    if (req.query.escalated === 'true') filter.escalated = true;
    if (req.query.escalated === 'false') filter.escalated = false;
    if (req.query.channel) filter.channel = req.query.channel;

    const [sessions, total] = await Promise.all([
      ChatSession.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('tenantId', 'name')
        .lean(),
      ChatSession.countDocuments(filter),
    ]);

    const items = sessions.map((s: any) => ({
      sessionId: s.sessionId,
      tenantId: s.tenantId?._id ?? s.tenantId,
      tenantName: s.tenantId?.name ?? 'Unknown',
      visitorName: s.visitorName,
      visitorEmail: s.visitorEmail,
      visitorPhone: s.visitorPhone,
      channel: s.channel,
      escalated: s.escalated,
      messageCount: s.messages?.length ?? 0,
      lastActivityAt: s.updatedAt,
    }));

    sendSuccess(res, { items, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// GET /admin/conversations/:sessionId — full transcript + per-turn AI trace
// (see attachAiActionTrace in ../bot/chat-trace.util for the matching logic —
// shared with the tenant-facing Chat History panel at /bot/chat-history/:sessionId).
router.get('/conversations/:sessionId', async (req: AuthRequest, res, next) => {
  try {
    const { sessionId } = req.params;
    const session = await ChatSession.findOne({ sessionId }).populate('tenantId', 'name').lean();
    if (!session) { sendError(res, 'Conversation not found', 404); return; }

    const messages = await attachAiActionTrace(session.sessionId, session.messages || []);

    const tenantRef = session.tenantId as any;
    sendSuccess(res, {
      sessionId: session.sessionId,
      tenantId: tenantRef?._id ?? tenantRef,
      tenantName: tenantRef?.name ?? 'Unknown',
      visitorName: session.visitorName,
      visitorEmail: session.visitorEmail,
      visitorPhone: session.visitorPhone,
      channel: session.channel,
      escalated: session.escalated,
      messages,
    });
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
    const tenant = await Tenant.findById(req.params.id).select('featureFlags accessConfigMode name settings.maxUsers');
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    const { DEFAULT_FEATURE_FLAGS } = await import('../tenants/tenant.model');
    // Convert Mongoose subdocument → plain object so all saved fields (including false values) are present
    const rawFlags = tenant.featureFlags as unknown as { toObject?: () => Record<string, unknown> } | undefined;
    const saved = rawFlags?.toObject ? rawFlags.toObject() : (tenant.featureFlags ?? {});
    const flags = { ...DEFAULT_FEATURE_FLAGS, ...saved };
    // Mirrors getEffectiveFeatureFlags()'s own precedence: anything other
    // than an explicit 'custom' opt-out is treated as 'default' (including
    // tenants that predate this field), so this displayed mode always
    // matches what effectiveFlags below actually resolves to.
    const accessConfigMode = tenant.accessConfigMode === 'custom' ? 'custom' : 'default';
    // effectiveFlags is what's ACTUALLY applied right now — identical to
    // `flags` in 'custom' mode, or the Platform Defaults template in
    // 'default' mode. `flags` itself is always the tenant's own raw stored
    // values, untouched by mode, so switching back to Customize later
    // restores exactly what was there before, not the template.
    const effectiveFlags = await getEffectiveFeatureFlags(tenant);
    // Live ground truth for display — deliberately NOT the maintained
    // currentUserCount reservation counter (that's an enforcement-only
    // field; see reserveUserSeat() in tenant.service.ts).
    const activeUsers = await User.countDocuments({ tenantId: tenant._id, role: { $ne: 'SUPER_ADMIN' }, isActive: true });
    sendSuccess(res, { flags, effectiveFlags, accessConfigMode, tenantName: tenant.name, maxUsers: tenant.settings?.maxUsers ?? null, activeUsers });
  } catch (err) { next(err); }
});

// PUT /admin/tenants/:id/features — update feature flags (and/or access
// mode, and/or the user-seat limit) for a tenant. accessConfigMode and
// maxUsers are both optional so the existing {flags}-only callers keep
// working unchanged.
router.put('/tenants/:id/features', async (req: AuthRequest, res, next) => {
  try {
    const { flags, accessConfigMode, maxUsers } = req.body as {
      flags?: Record<string, boolean>; accessConfigMode?: 'default' | 'custom'; maxUsers?: number | null;
    };
    if (accessConfigMode && !['default', 'custom'].includes(accessConfigMode)) {
      sendError(res, "accessConfigMode must be 'default' or 'custom'", 400); return;
    }
    if (maxUsers !== undefined && maxUsers !== null && (!Number.isInteger(maxUsers) || maxUsers < 1)) {
      sendError(res, 'maxUsers must be a positive whole number, or null for unlimited', 400); return;
    }
    const before = await Tenant.findById(req.params.id).select('featureFlags accessConfigMode settings.maxUsers');
    if (!before) { sendError(res, 'Tenant not found', 404); return; }
    const previousFlags = before.featureFlags;
    const previousMode = before.accessConfigMode === 'custom' ? 'custom' : 'default';
    const previousMaxUsers = before.settings?.maxUsers ?? null;
    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...(flags !== undefined ? { featureFlags: flags } : {}),
          ...(accessConfigMode ? { accessConfigMode } : {}),
          // Changing the ceiling never touches currentUserCount or any User
          // document — raising it takes effect on the very next invite,
          // lowering it below current usage only blocks new invites, never
          // deactivates or deletes anyone.
          ...(maxUsers !== undefined ? { 'settings.maxUsers': maxUsers } : {}),
        },
      },
      { new: true, runValidators: false }
    ).select('featureFlags accessConfigMode name settings.maxUsers');
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    // Per-flag-key diff — {previousFlags, flags} already had the full before/
    // after objects; `changes` adds an explicit "what actually changed" list
    // so a reviewer doesn't have to manually compare the two.
    const previousFlagsObj = (previousFlags as unknown as { toObject?: () => Record<string, unknown> })?.toObject?.()
      ?? (previousFlags as unknown as Record<string, unknown> | undefined) ?? {};
    const changes: { key: string; from: unknown; to: unknown }[] = flags
      ? Object.keys(flags)
          .filter((key) => previousFlagsObj[key] !== flags[key])
          .map((key) => ({ key, from: previousFlagsObj[key] ?? null, to: flags[key] }))
      : [];
    if (accessConfigMode && accessConfigMode !== previousMode) {
      changes.push({ key: 'accessConfigMode', from: previousMode, to: accessConfigMode });
    }
    if (maxUsers !== undefined && maxUsers !== previousMaxUsers) {
      changes.push({ key: 'maxUsers', from: previousMaxUsers, to: maxUsers });
    }
    logAuditEvent(
      'feature_flags.updated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: req.params.id, target: 'Tenant', targetId: req.params.id, detail: { tenantName: tenant.name, previousFlags, flags, changes, result: 'success' } },
    );
    const activeUsers = await User.countDocuments({ tenantId: tenant._id, role: { $ne: 'SUPER_ADMIN' }, isActive: true });
    // LR-ADMIN-002: lowering the seat limit below current usage is allowed
    // (see the comment above — it only blocks new invites, never touches
    // anyone already active), but doing it silently gave no warning that
    // new invites would start failing right away.
    const newMaxUsers = tenant.settings?.maxUsers ?? null;
    const seatWarning = newMaxUsers !== null && newMaxUsers < activeUsers
      ? `This tenant has ${activeUsers} active users, above the new limit of ${newMaxUsers}. No one will be removed, but new invites will be blocked until usage drops below the limit.`
      : null;
    sendSuccess(res, { flags: tenant.featureFlags, accessConfigMode: tenant.accessConfigMode === 'custom' ? 'custom' : 'default', tenantName: tenant.name, maxUsers: newMaxUsers, activeUsers, seatWarning }, 'Feature flags updated');
  } catch (err) { next(err); }
});

// GET /admin/platform-defaults — the global template new tenants inherit
router.get('/platform-defaults', async (_req, res, next) => {
  try {
    const [flags, aiPlanDefaults] = await Promise.all([getPlatformDefaults(), getAiPlanDefaults()]);
    sendSuccess(res, { flags, aiPlanDefaults });
  } catch (err) { next(err); }
});

// PUT /admin/platform-defaults — edit the global template. Only affects
// tenants on accessConfigMode:'default' (immediately) and future tenants
// created from this point on — existing 'custom' tenants are untouched.
// aiPlanDefaults is optional so existing {flags}-only callers keep working.
router.put('/platform-defaults', async (req: AuthRequest, res, next) => {
  try {
    const { flags, aiPlanDefaults } = req.body as {
      flags: Record<string, boolean>;
      aiPlanDefaults?: Record<string, { monthlyTokenLimit: number; monthlyVoiceMinutesLimit: number; priceUsdPerMonth: number }>;
    };
    const previousFlags = await getPlatformDefaults();
    const updatedFlags = await setPlatformDefaults(flags);
    const previousFlagsObj = previousFlags as unknown as Record<string, unknown>;
    const changes = Object.keys(flags)
      .filter((key) => previousFlagsObj[key] !== flags[key])
      .map((key) => ({ key, from: previousFlagsObj[key] ?? null, to: flags[key] }));

    let updatedAiPlanDefaults = await getAiPlanDefaults();
    if (aiPlanDefaults) {
      const previousPlanDefaults = updatedAiPlanDefaults;
      updatedAiPlanDefaults = await setAiPlanDefaults(aiPlanDefaults as typeof DEFAULT_AI_PLAN_DEFAULTS);
      logAuditEvent(
        'platform_defaults.ai_plans_updated',
        { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
        { target: 'PlatformDefaults', targetId: 'platform-defaults', detail: { previousPlanDefaults, aiPlanDefaults: updatedAiPlanDefaults, result: 'success' } },
      );
    }

    logAuditEvent(
      'platform_defaults.updated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { target: 'PlatformDefaults', targetId: 'platform-defaults', detail: { previousFlags, flags: updatedFlags, changes, result: 'success' } },
    );
    sendSuccess(res, { flags: updatedFlags, aiPlanDefaults: updatedAiPlanDefaults }, 'Platform defaults updated');
  } catch (err) { next(err); }
});

// PUT /admin/tenants/:id/ai-config — Super-Admin-only control over a single
// tenant's AI usage budget (monthly token/voice-minute limit + admin-facing
// warning/critical thresholds). Mirrors PUT /admin/tenants/:id/features'
// shape (partial payload, audit-logged diff) — this is the ONLY write path
// for these 4 fields now; tenant.service.ts's updateTenant() (the
// TENANT_ADMIN-reachable PUT /tenants/:id) deliberately excludes them so a
// tenant can no longer raise its own AI budget. Sending `null` for a field
// clears the override back to the plan default.
router.put('/tenants/:id/ai-config', async (req: AuthRequest, res, next) => {
  try {
    const { monthlyTokenLimit, monthlyVoiceMinutesLimit, tokenWarningThresholdPercent, tokenCriticalThresholdPercent, resetUsageCounter } = req.body as {
      monthlyTokenLimit?: number | null;
      monthlyVoiceMinutesLimit?: number | null;
      tokenWarningThresholdPercent?: number | null;
      tokenCriticalThresholdPercent?: number | null;
      resetUsageCounter?: boolean;
    };
    for (const [key, val] of Object.entries({ monthlyTokenLimit, monthlyVoiceMinutesLimit, tokenWarningThresholdPercent, tokenCriticalThresholdPercent })) {
      if (val !== undefined && val !== null && (typeof val !== 'number' || val < 0)) {
        sendError(res, `${key} must be a non-negative number, or null to clear it`, 400); return;
      }
    }
    if (
      typeof tokenWarningThresholdPercent === 'number' && typeof tokenCriticalThresholdPercent === 'number' &&
      tokenWarningThresholdPercent >= tokenCriticalThresholdPercent
    ) {
      sendError(res, 'Warning threshold must be lower than critical threshold', 400); return;
    }

    const before = await Tenant.findById(req.params.id).select('name aiConfig');
    if (!before) { sendError(res, 'Tenant not found', 404); return; }
    const previousAiConfig = before.aiConfig;

    const tenant = await updateTenantAiLimits(req.params.id, {
      monthlyTokenLimit, monthlyVoiceMinutesLimit, tokenWarningThresholdPercent, tokenCriticalThresholdPercent, resetUsageCounter,
    });
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }

    logAuditEvent(
      resetUsageCounter ? 'tenant_ai_usage.reset' : 'tenant_ai_config.updated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      { tenantId: req.params.id, target: 'Tenant', targetId: req.params.id, detail: { tenantName: tenant.name, previousAiConfig, aiConfig: tenant.aiConfig, result: 'success' } },
    );

    const usage = await getAiUsage(req.params.id);
    sendSuccess(res, usage, 'AI usage limits updated');
  } catch (err) { next(err); }
});

export default router;
