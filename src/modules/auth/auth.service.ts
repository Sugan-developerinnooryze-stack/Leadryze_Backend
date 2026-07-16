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

  const tenant = await Tenant.create({
    clientId,
    name: companyName,
    slug,
    plan: 'starter',
    isActive: true,
    settings: {
      allowedChannels: ['web', 'whatsapp', 'email', 'sms'],
      maxUsers: 5,
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
        <p>Your account has been created. Please verify your email address to get started.</p>
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

export async function verifyEmail(token: string, email: string): Promise<LoginResult> {
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

  return { ...tokens, user: userObj as unknown as Omit<IUser, 'password' | 'refreshToken'>, permissions: null };
}

export async function loginUser(
  email: string,
  password: string,
  tenantId?: string,
  ctx?: { ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const query: Record<string, unknown> = { email: email.toLowerCase(), isActive: true };
  if (tenantId) query.tenantId = tenantId;
  const user = await User.findOne(query).select('+password');
  if (!user || !(await user.comparePassword(password))) {
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

  return { ...tokens, user: userObj as unknown as Omit<IUser, 'password' | 'refreshToken'>, permissions };
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

  user.password = newPassword;
  await user.save(); // triggers bcrypt hash via pre-save hook

  // Invalidate existing refresh token — forces re-login on other devices
  await User.findByIdAndUpdate(userId, { refreshToken: null });
}

export async function resetPassword(token: string, email: string, newPassword: string): Promise<void> {
  const user = await User.findOne({
    email: email.toLowerCase(),
    passwordResetToken: sha256(token),
    passwordResetExpiry: { $gt: new Date() },
  }).select('+passwordResetToken +passwordResetExpiry');

  if (!user) throw Object.assign(new Error('Invalid or expired reset link'), { statusCode: 400 });

  user.password = newPassword;
  await user.save(); // triggers bcrypt hash via pre-save hook

  await User.findByIdAndUpdate(user._id, {
    $unset: { passwordResetToken: 1, passwordResetExpiry: 1 },
    refreshToken: null,
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
