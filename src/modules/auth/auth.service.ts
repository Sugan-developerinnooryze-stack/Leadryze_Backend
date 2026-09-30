import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import mongoose from 'mongoose';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
import { config } from '../../config';
import { User, IUser } from './auth.model';
import { Tenant } from '../tenants/tenant.model';
import { JwtPayload, UserRole } from '../../types';
import { sendEmailNow } from '../messages/brevo.service';
import { logger } from '../../utils/logger';
import { logSecurityEvent } from '../logs/security-event.model';
import { UserSession, parseUserAgent, lookupGeo } from './user-session.model';
import { getPermissionArray } from '../rbac/permission.service';
import { ensureSystemPermissions } from '../rbac/rbac.seed';

export interface LoginResult {
  accessToken:  string;
  refreshToken: string;
  user:         Omit<IUser, 'password' | 'refreshToken'>;
  permissions:  string[] | null; // null = full access (SUPER_ADMIN / TENANT_ADMIN without roleId)
  mustChangePassword: boolean;
}

/** Undefined/'approved' both mean "allowed" — undefined covers every
 * pre-existing tenant plus any .lean() read of a legacy document that
 * predates this field (schema defaults don't hydrate on .lean()). Only the
 * literal values 'pending'/'rejected' ever block login. Shared by both the
 * email and Client-ID login branches so they can never enforce different
 * rules. */
function assertTenantLoginAllowed(tenant: { isActive?: boolean; approvalStatus?: string } | null): void {
  if (tenant?.approvalStatus === 'pending') {
    throw Object.assign(new Error('Your account is awaiting Super Admin approval.'), { statusCode: 403 });
  }
  if (tenant?.approvalStatus === 'rejected') {
    throw Object.assign(new Error('Your account request was not approved. Contact support.'), { statusCode: 403 });
  }
  if (tenant && !tenant.isActive) {
    throw Object.assign(new Error("Your organization's account has been deactivated. Contact support."), { statusCode: 403 });
  }
}

/** Client-ID login has no second field to pick one specific person at a
 * company — it tries the new password against every active user at that
 * tenant (see loginUserByClientId). That's only safe if no two people at
 * the same company can ever have matching passwords, so this is called
 * before EVERY password is set, anywhere in the app (self-service change,
 * forgot-password, and every Super-Admin-issued credential), and rejects
 * the new password if it would collide with anyone else's. Compares via
 * bcrypt against each candidate's hash — works regardless of whether that
 * other person's password was self-chosen or admin-issued. */
export async function isPasswordTakenAtTenant(
  tenantId: string | mongoose.Types.ObjectId,
  plaintextPassword: string,
  excludeUserId?: string,
): Promise<boolean> {
  const others = await User.find({
    tenantId,
    isActive: true,
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
  }).select('+password');
  for (const other of others) {
    if (await other.comparePassword(plaintextPassword)) return true;
  }
  return false;
}

export async function assertPasswordUniqueAtTenant(
  tenantId: string | mongoose.Types.ObjectId,
  plaintextPassword: string,
  excludeUserId?: string,
): Promise<void> {
  if (await isPasswordTakenAtTenant(tenantId, plaintextPassword, excludeUserId)) {
    throw Object.assign(
      new Error('This password is already in use by another account at your company. Choose a different one.'),
      { statusCode: 409 },
    );
  }
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName?: string;
}

function generateTokens(payload: Omit<JwtPayload, 'iat' | 'exp'>) {
  const accessToken = jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
  });
  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn as jwt.SignOptions['expiresIn'],
  });
  return { accessToken, refreshToken };
}

export async function registerUser(input: RegisterInput): Promise<{ message: string }> {
  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) throw Object.assign(new Error('Email already registered'), { statusCode: 409 });

  // Auto-create a tenant for this client
  const companyName = input.companyName || `${input.firstName}'s Workspace`;
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    + '-' + crypto.randomBytes(3).toString('hex');

  // Generate unique 8-char uppercase hex clientId (e.g. ADFE7895)
  let clientId: string;
  let tries = 0;
  do {
    clientId = crypto.randomBytes(4).toString('hex').toUpperCase();
    tries++;
  } while (tries < 10 && await Tenant.exists({ clientId }));

  const { getPlatformDefaults } = await import('../admin/platform-defaults.model');
  const platformDefaults = await getPlatformDefaults();

  const tenant = await Tenant.create({
    clientId,
    name: companyName,
    slug,
    plan: 'starter',
    isActive: true,
    approvalStatus: 'pending',
    // Same "inherit the current template, stay on default" behavior as
    // provisionTenant() — see getEffectiveFeatureFlags() in tenant.service.ts.
    accessConfigMode: 'default',
    featureFlags: platformDefaults,
    settings: {
      allowedChannels: ['web', 'whatsapp', 'email', 'sms'],
      maxUsers: 5,
      // The TENANT_ADMIN created right below already occupies one seat.
      currentUserCount: 1,
      maxLeadsPerMonth: 500,
      timezone: 'Asia/Kuala_Lumpur',
      language: 'en',
      crmOption: 'no_crm',
    },
    branding: { companyName },
    aiConfig: {
      agentName: 'LeadBot',
      language: 'en',
      fallbackToHuman: true,
      systemPrompt: `You are LeadBot, an AI assistant for ${companyName}. Help capture leads and answer questions.`,
    },
  });

  const verificationToken = crypto.randomBytes(32).toString('hex');
  const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const user = await User.create({
    email: input.email.toLowerCase(),
    password: input.password,
    firstName: input.firstName,
    lastName: input.lastName,
    role: 'TENANT_ADMIN' as UserRole,
    tenantId: tenant._id,
    clientId,
    isActive: true,
    emailVerified: false,
    emailVerificationToken: sha256(verificationToken), // store hash, send raw token in email
    emailVerificationExpiry: verificationExpiry,
  });

  // Seed system permissions + default roles for this new tenant (fire-and-forget — never blocks registration)
  ensureSystemPermissions(tenant._id.toString()).then(async () => {
    // Assign Admin roleId to the newly created TENANT_ADMIN
    const { Role } = await import('./auth.model').then(() => import('../rbac/role.model'));
    const adminRole = await Role.findOne({ tenantId: tenant._id, name: 'Admin' }, '_id').lean();
    if (adminRole) {
      await User.findByIdAndUpdate(user._id, { roleId: adminRole._id });
    }
  }).catch(() => {});

  // Send verification email via Brevo (raw token in URL — not the hash)
  const verifyUrl = `${config.app.frontendUrl}/verify-email?token=${verificationToken}&email=${encodeURIComponent(user.email)}`;
  await sendEmailNow({
    to: user.email,
    toName: `${input.firstName} ${input.lastName}`,
    subject: 'Verify your LeadRyze AI account',
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Welcome to LeadRyze AI, ${input.firstName}!</h2>
        <p>Your account has been created. Please verify your email address to complete your signup request.</p>
        <div style="margin:32px 0">
          <a href="${verifyUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
            Verify Email Address
          </a>
        </div>
        <p style="color:#666;font-size:14px">Or copy this link:<br/><a href="${verifyUrl}">${verifyUrl}</a></p>
        <p style="color:#666;font-size:14px">This link expires in 24 hours.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#999;font-size:12px">LeadRyze AI — AI-powered lead management</p>
      </div>
    `,
  }).catch(() => {}); // Don't fail registration if email fails

  return { message: 'Registration successful. Please check your email to verify your account.' };
}

export interface PendingApprovalResult {
  status: 'pending_approval';
  message: string;
}

export async function verifyEmail(token: string, email: string): Promise<LoginResult | PendingApprovalResult> {
  const user = await User.findOne({
    email: email.toLowerCase(),
    emailVerificationToken: sha256(token),
    emailVerificationExpiry: { $gt: new Date() },
  }).select('+emailVerificationToken +emailVerificationExpiry');

  if (!user) throw Object.assign(new Error('Invalid or expired verification link'), { statusCode: 400 });

  await User.findByIdAndUpdate(user._id, {
    emailVerified: true,
    $unset: { emailVerificationToken: 1, emailVerificationExpiry: 1 },
  });

  // Approval-gated tenants (self-signup) don't get an auto-issued session
  // just from verifying their email anymore — a Super Admin has to approve
  // first. Every other tenant (approved, or undefined on a legacy .lean()
  // read) keeps today's behavior of logging straight in.
  const tenant = await Tenant.findById(user.tenantId).select('approvalStatus').lean();
  if (tenant?.approvalStatus === 'pending') {
    return {
      status: 'pending_approval',
      message: "Email verified. Your account is awaiting Super Admin approval — you'll receive an email with your login details once approved.",
    };
  }

  const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
    userId: (user._id as mongoose.Types.ObjectId).toString(),
    tenantId: user.tenantId.toString(),
    role: user.role,
    email: user.email,
  };

  const tokens = generateTokens(payload);
  await User.findByIdAndUpdate(user._id, { refreshToken: sha256(tokens.refreshToken) });

  const userObj = user.toObject() as unknown as Record<string, unknown>;
  delete userObj.password;
  delete userObj.refreshToken;
  delete userObj.emailVerificationToken;

  return {
    ...tokens,
    user: userObj as unknown as Omit<IUser, 'password' | 'refreshToken'>,
    permissions: null,
    mustChangePassword: user.mustChangePassword ?? false,
  };
}

export async function loginUser(
  email: string,
  password: string,
  tenantId?: string,
  ctx?: { ip?: string; userAgent?: string },
  clientId?: string,
): Promise<LoginResult> {
  // New, additive login path — every existing call site omits this 5th
  // arg, so it's always undefined for them and this guard never fires.
  // Everything below is the pre-existing email branch, unmodified.
  if (clientId) {
    return loginUserByClientId(clientId, password, ctx);
  }

  const query: Record<string, unknown> = { email: email.toLowerCase(), isActive: true };
  if (tenantId) query.tenantId = tenantId;

  // Real, confirmed bug this fixes: the same email can legitimately exist
  // under multiple tenants (the unique index is {email,tenantId}, not a
  // global one — e.g. someone invited into two separate client workspaces).
  // The login form never asks which tenant, so this used to findOne() and
  // silently compare the password against whichever account Mongo happened
  // to return first — a perfectly correct password failed with a generic
  // "Invalid email or password" whenever that happened to be the WRONG
  // tenant's account. Confirmed directly against production: two MANAGER
  // accounts for the same email under two different tenants. Trying the
  // password against every matching account (there are only ever a
  // handful) resolves to the right one without needing a tenant-picker UI.
  const candidates = await User.find(query).select('+password');
  let user: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (await candidate.comparePassword(password)) { user = candidate; break; }
  }
  if (!user) {
    logSecurityEvent('auth.login_failed', {
      ip:        ctx?.ip ?? 'unknown',
      userAgent: ctx?.userAgent ?? 'unknown',
      detail:    { email },
    });
    throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
  }

  // Super admins bypass email verification
  if (!user.emailVerified && user.role !== 'SUPER_ADMIN') {
    throw Object.assign(new Error('Please verify your email before logging in. Check your inbox.'), { statusCode: 403 });
  }

  // Deactivated/pending/rejected tenants block login for everyone except
  // Super Admin (who manages these flags itself — never lock out the
  // account that can undo a mistaken deactivation).
  if (user.role !== 'SUPER_ADMIN') {
    const tenant = await Tenant.findById(user.tenantId).select('isActive approvalStatus').lean();
    try {
      assertTenantLoginAllowed(tenant);
    } catch (err) {
      logSecurityEvent('auth.login_failed', {
        tenantId:  user.tenantId.toString(),
        ip:        ctx?.ip ?? 'unknown',
        userAgent: ctx?.userAgent ?? 'unknown',
        detail:    { email, reason: tenantBlockReason(tenant) },
      });
      throw err;
    }
  }

  return finalizeSuccessfulLogin(user, ctx);
}

/** Client-ID + password login — resolves `user` differently (Client ID
 * identifies the tenant, then the account within it) but shares every
 * other rule with the email branch above: the same `assertTenantLoginAllowed`
 * gate, and the same `finalizeSuccessfulLogin` tail for token issuance,
 * security-event logging, session creation, and permission resolution.
 * Rate limiting is shared automatically — both paths go through the same
 * POST /auth/login route and authRateLimit middleware.
 *
 * The plain, shared tenant Client ID resolves ONLY to a TENANT_ADMIN at
 * that company — never to a sub-user, even if the submitted password
 * happens to match one. Confirmed live (2026-09-22): a Super Admin testing
 * this by hand hit exactly the ambiguous case — typing the shared Client ID
 * with a Manager's password logged them in AS that Manager, not as the
 * Tenant Admin they intended, because nothing about the submitted value
 * says WHICH person. Every sub-user has their own distinct loginId
 * (`${clientId}-U${seq}`) precisely so this can be unambiguous instead —
 * see the direct-match branch below, which is what they're expected to use.
 * assertPasswordUniqueAtTenant() still guards every password-setting call
 * site as defense in depth (and disambiguates the rare multi-TENANT_ADMIN
 * case below), but is no longer what makes this branch safe by itself. */
async function loginUserByClientId(
  clientId: string,
  password: string,
  ctx?: { ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const normalized = clientId.trim().toUpperCase();

  const tenant = await Tenant.findOne({ clientId: normalized }).select('_id isActive approvalStatus').lean();
  if (tenant) {
    const candidates = await User.find({ tenantId: tenant._id, isActive: true, role: 'TENANT_ADMIN' }).select('+password');
    let user: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.comparePassword(password)) { user = candidate; break; }
    }
    if (!user) {
      logSecurityEvent('auth.login_failed', {
        tenantId:  String(tenant._id),
        ip:        ctx?.ip ?? 'unknown',
        userAgent: ctx?.userAgent ?? 'unknown',
        detail:    { clientId: normalized },
      });
      throw Object.assign(new Error('Invalid Client ID or password'), { statusCode: 401 });
    }

    if (!user.emailVerified && user.role !== 'SUPER_ADMIN') {
      throw Object.assign(new Error('Please verify your email before logging in. Check your inbox.'), { statusCode: 403 });
    }

    if (user.role !== 'SUPER_ADMIN') {
      try {
        assertTenantLoginAllowed(tenant);
      } catch (err) {
        logSecurityEvent('auth.login_failed', {
          tenantId:  String(tenant._id),
          ip:        ctx?.ip ?? 'unknown',
          userAgent: ctx?.userAgent ?? 'unknown',
          detail:    { clientId: normalized, reason: tenantBlockReason(tenant) },
        });
        throw err;
      }
    }

    return finalizeSuccessfulLogin(user, ctx);
  }

  // New path — only reached when `normalized` isn't any tenant's raw
  // clientId at all (every real clientId is a fixed 8-char hex value, so it
  // can never collide with a "${clientId}-U${seq}" loginId). A loginId
  // match pins down exactly one person; only THAT account's password is
  // ever checked — unlike the legacy branch above, a wrong password here
  // must not fall through and get tried against anyone else at the tenant.
  const direct = await User.findOne({ loginId: normalized, isActive: true }).select('+password');
  if (direct && await direct.comparePassword(password)) {
    if (!direct.emailVerified && direct.role !== 'SUPER_ADMIN') {
      throw Object.assign(new Error('Please verify your email before logging in. Check your inbox.'), { statusCode: 403 });
    }
    if (direct.role !== 'SUPER_ADMIN') {
      const directTenant = await Tenant.findById(direct.tenantId).select('isActive approvalStatus').lean();
      try {
        assertTenantLoginAllowed(directTenant);
      } catch (err) {
        logSecurityEvent('auth.login_failed', {
          tenantId:  direct.tenantId.toString(),
          ip:        ctx?.ip ?? 'unknown',
          userAgent: ctx?.userAgent ?? 'unknown',
          detail:    { loginId: normalized, reason: tenantBlockReason(directTenant) },
        });
        throw err;
      }
    }
    return finalizeSuccessfulLogin(direct, ctx);
  }

  logSecurityEvent('auth.login_failed', {
    ip: ctx?.ip ?? 'unknown', userAgent: ctx?.userAgent ?? 'unknown', detail: { clientId: normalized },
  });
  throw Object.assign(new Error('Invalid Client ID or password'), { statusCode: 401 });
}

function tenantBlockReason(tenant: { isActive?: boolean; approvalStatus?: string } | null): string {
  if (tenant?.approvalStatus === 'pending')  return 'tenant_pending_approval';
  if (tenant?.approvalStatus === 'rejected') return 'tenant_rejected';
  return 'tenant_deactivated';
}

/** Shared tail for every successful login, regardless of how `user` was
 * resolved (email+password candidate loop, or Client ID + password) — token
 * issuance, security-event logging, session creation, and permission
 * resolution must never diverge between the two login paths. */
async function finalizeSuccessfulLogin(user: IUser, ctx?: { ip?: string; userAgent?: string }): Promise<LoginResult> {
  const userId        = (user._id as mongoose.Types.ObjectId).toString();
  const userTenantId  = user.tenantId.toString();
  const roleId        = user.roleId?.toString();

  const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
    userId,
    tenantId: userTenantId,
    role:     user.role,
    email:    user.email,
    roleId,
  };

  const tokens = generateTokens(payload);
  logSecurityEvent('auth.login_success', {
    tenantId: userTenantId,
    userId,
    ip:        ctx?.ip ?? 'unknown',
    userAgent: ctx?.userAgent ?? 'unknown',
  });
  await User.findByIdAndUpdate(user._id, { refreshToken: sha256(tokens.refreshToken), lastLogin: new Date() });

  // Create active session record (fire-and-forget — never blocks login)
  const { browser, os } = parseUserAgent(ctx?.userAgent ?? '');
  const sessionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  UserSession.create({
    userId:    userId,
    tenantId:  userTenantId,
    tokenHash: sha256(tokens.refreshToken),
    ip:        ctx?.ip ?? 'unknown',
    browser,
    os,
    expiresAt: sessionExpiresAt,
  }).then((session) => {
    if (ctx?.ip) {
      lookupGeo(ctx.ip).then((geo) => {
        UserSession.findByIdAndUpdate(session._id, { city: geo.city, country: geo.country }).catch(() => {});
      }).catch(() => {});
    }
  }).catch(() => {});

  const userObj = user.toObject() as unknown as Record<string, unknown>;
  delete userObj.password;
  delete userObj.refreshToken;

  // Fetch effective permissions — null means full access (SUPER_ADMIN / TENANT_ADMIN without roleId)
  let permissions: string[] | null = null;
  if (roleId && user.role !== 'SUPER_ADMIN' && user.role !== 'TENANT_ADMIN') {
    permissions = await getPermissionArray(userTenantId, roleId).catch(() => null);
  }

  return {
    ...tokens,
    user: userObj as unknown as Omit<IUser, 'password' | 'refreshToken'>,
    permissions,
    mustChangePassword: user.mustChangePassword ?? false,
  };
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
  // Always return success to prevent email enumeration
  if (!user) return;

  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await User.findByIdAndUpdate(user._id, {
    passwordResetToken: sha256(resetToken), // store hash — send raw token in email URL
    passwordResetExpiry: expiry,
  });

  const resetUrl = `${config.app.frontendUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(user.email)}`;

  await sendEmailNow({
    to: user.email,
    toName: `${user.firstName} ${user.lastName}`,
    subject: 'Reset your LeadRyze AI password',
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Reset your password</h2>
        <p>Hi ${user.firstName}, we received a request to reset your password.</p>
        <div style="margin:32px 0">
          <a href="${resetUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
            Reset Password
          </a>
        </div>
        <p style="color:#666;font-size:14px">Or copy this link:<br/><a href="${resetUrl}">${resetUrl}</a></p>
        <p style="color:#666;font-size:14px">This link expires in <strong>1 hour</strong>. If you didn't request this, ignore this email.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#999;font-size:12px">LeadRyze AI — AI-powered lead management</p>
      </div>
    `,
  }).catch((emailErr) => {
    // Always return success to prevent email enumeration — log the failure for debugging
    logger.error('Forgot password email failed to send', { email: user.email, error: (emailErr as Error).message });
  });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await User.findById(userId).select('+password');
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

  const matches = await user.comparePassword(currentPassword);
  if (!matches) throw Object.assign(new Error('Current password is incorrect'), { statusCode: 401 });

  await assertPasswordUniqueAtTenant(user.tenantId, newPassword, userId);

  user.password = newPassword;
  await user.save(); // triggers bcrypt hash via pre-save hook

  // Invalidate existing refresh token — forces re-login on other devices.
  // Also explicitly clears mustChangePassword: for every existing user this
  // is already false (no-op write of the same value); for a Super-Admin-
  // provisioned/approved tenant admin changing their forced temporary
  // password, this is what lets RequireAuth stop redirecting them back to
  // /change-password once the frontend re-fetches /auth/me.
  // $unset passwordEnc — this is now a self-chosen password; any encrypted
  // copy a Super Admin could previously read back is stale and must not
  // keep being shown as if it still worked.
  await User.findByIdAndUpdate(userId, { refreshToken: null, mustChangePassword: false, $unset: { passwordEnc: 1 } });
}

export async function resetPassword(token: string, email: string, newPassword: string): Promise<void> {
  const user = await User.findOne({
    email: email.toLowerCase(),
    passwordResetToken: sha256(token),
    passwordResetExpiry: { $gt: new Date() },
  }).select('+passwordResetToken +passwordResetExpiry');

  if (!user) throw Object.assign(new Error('Invalid or expired reset link'), { statusCode: 400 });

  await assertPasswordUniqueAtTenant(user.tenantId, newPassword, (user._id as mongoose.Types.ObjectId).toString());

  user.password = newPassword;
  await user.save(); // triggers bcrypt hash via pre-save hook

  await User.findByIdAndUpdate(user._id, {
    // Self-chosen — clear any Super-Admin-readable copy, it's now stale.
    // mustChangePassword: false matches changePassword()'s own update
    // above — without it, a brand-new user who uses Forgot Password
    // instead of their first real login would still get redirected to
    // change their password again right after they just changed it.
    $unset: { passwordResetToken: 1, passwordResetExpiry: 1, passwordEnc: 1 },
    refreshToken: null,
    mustChangePassword: false,
  });
}

export async function refreshTokens(token: string): Promise<{ accessToken: string; refreshToken: string }> {
  const payload = jwt.verify(token, config.jwt.refreshSecret) as JwtPayload;
  const user = await User.findById(payload.userId).select('+refreshToken');

  // Compare stored hash against incoming token's hash (constant-time safe via sha256 comparison)
  const incomingHash = sha256(token);
  const storedHash = user?.refreshToken || '';
  const hashMatch = storedHash.length === incomingHash.length &&
    crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(incomingHash));

  if (!user || !hashMatch) {
    throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 });
  }

  const newPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
    userId: (user._id as mongoose.Types.ObjectId).toString(),
    tenantId: user.tenantId.toString(),
    role: user.role,
    email: user.email,
  };

  const tokens = generateTokens(newPayload);
  await User.findByIdAndUpdate(user._id, { refreshToken: sha256(tokens.refreshToken) });
  return tokens;
}

export async function logoutUser(
  userId: string,
  ctx?: { ip?: string; userAgent?: string; tenantId?: string },
): Promise<void> {
  // await so the event is guaranteed saved before sessions are wiped
  await logSecurityEvent('auth.logout', {
    userId,
    tenantId:  ctx?.tenantId,
    ip:        ctx?.ip        || 'unknown',
    userAgent: ctx?.userAgent || 'unknown',
  });
  await Promise.all([
    User.findByIdAndUpdate(userId, { $unset: { refreshToken: 1 } }),
    UserSession.deleteMany({ userId }),
  ]);
}
