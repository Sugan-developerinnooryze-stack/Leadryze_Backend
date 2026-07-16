import mongoose, { Schema, Document } from 'mongoose';

// Simple in-memory throttle so one IP can't generate hundreds of alert emails
const _alertedIPs = new Map<string, number>();
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export type SecurityEventType =
  | 'auth.token_invalid'
  | 'auth.token_expired'
  | 'auth.login_failed'
  | 'auth.login_success'
  | 'auth.logout'
  | 'auth.password_reset'
  | 'auth.email_verified'
  | 'ratelimit.violation'
  | 'webhook.sig_invalid'
  | 'websocket.auth_failed'
  | 'tenant.access_denied'
  | 'ai.prompt_blocked';

export interface ISecurityEvent extends Document {
  event:     SecurityEventType;
  tenantId?: string;
  userId?:   string;
  ip:        string;
  userAgent: string;
  detail?:   Record<string, unknown>;
  timestamp: Date;
}

const SecurityEventSchema = new Schema<ISecurityEvent>(
  {
    event:     { type: String, required: true, index: true },
    tenantId:  { type: String, index: true },
    userId:    { type: String },
    ip:        { type: String, default: 'unknown' },
    userAgent: { type: String, default: 'unknown' },
    detail:    { type: Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

// Auto-delete security events after 90 days
SecurityEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const SecurityEvent = mongoose.model<ISecurityEvent>('SecurityEvent', SecurityEventSchema);

export async function logSecurityEvent(
  event: SecurityEventType,
  context: {
    tenantId?: string;
    userId?:   string;
    ip?:       string;
    userAgent?: string;
    detail?:   Record<string, unknown>;
  }
): Promise<void> {
  try {
    await SecurityEvent.create({
      event,
      tenantId:  context.tenantId,
      userId:    context.userId,
      ip:        context.ip        || 'unknown',
      userAgent: context.userAgent || 'unknown',
      detail:    context.detail,
      timestamp: new Date(),
    });
    // Brute-force alert: if >5 auth.login_failed from same IP in 10 min, email SUPER_ADMIN
    if (event === 'auth.login_failed' && context.ip && context.ip !== 'unknown') {
      const ip = context.ip;
      const lastAlerted = _alertedIPs.get(ip) ?? 0;
      if (Date.now() - lastAlerted > ALERT_COOLDOWN_MS) {
        const since10m = new Date(Date.now() - ALERT_COOLDOWN_MS);
        const count = await SecurityEvent.countDocuments({
          event: 'auth.login_failed',
          ip,
          timestamp: { $gte: since10m },
        });
        if (count >= 5) {
          _alertedIPs.set(ip, Date.now());
          // Fire-and-forget email alert
          import('../messages/brevo.service').then(({ sendEmailNow }) => {
            const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || process.env.BREVO_SENDER_EMAIL || '';
            if (!superAdminEmail) return;
            sendEmailNow({
              to:          superAdminEmail,
              subject:     `[LeadRyze AI] Brute-force alert — ${count} failed logins from ${ip}`,
              htmlContent: `<p>⚠️ Security Alert</p><p><strong>${count}</strong> failed login attempts from IP <code>${ip}</code> in the last 10 minutes.</p><p>Check the Security Dashboard for details.</p>`,
            }).catch(() => {});
          }).catch(() => {});
        }
      }
    }
  } catch {
    // Never let security event logging crash the main flow
  }
}
