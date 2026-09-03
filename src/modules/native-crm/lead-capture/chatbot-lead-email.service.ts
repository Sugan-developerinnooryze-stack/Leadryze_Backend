import mongoose from 'mongoose';
import { sendEmailNow } from '../../messages/brevo.service';
import { EmailLog, IEmailLog } from '../../notifications/email-log.model';
import { Tenant } from '../../tenants/tenant.model';
import { NativeStaff } from '../staffs/staff.model';
import { User } from '../../auth/auth.model';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';

interface LeadForEmail {
  _id: unknown;
  tenantId: unknown;
  leadId: string;
  firstName: string;
  lastName?: string;
  email?: string;
  leadOwnerStaffId?: string;
  requirement?: string;
  interestedItems?: Array<{ datasetId: string; datasetVersion: number; recordId: string; title: string }>;
  sourceUrl?: string;
}

interface TenantBranding {
  companyName: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
}

async function resolveBranding(tenantId: string): Promise<TenantBranding> {
  // `branding` is its own top-level Tenant field, NOT nested under `widget`
  // (widget reuses it for the public chatbot's theming, per widget's own
  // doc comment on tenant.model.ts, but doesn't duplicate it).
  const tenant = await Tenant.findById(tenantId).select('name branding').lean();
  return {
    companyName:  tenant?.branding?.companyName || tenant?.name || 'our team',
    contactEmail: tenant?.branding?.contactEmail,
    contactPhone: tenant?.branding?.contactPhone,
    address:      tenant?.branding?.address,
  };
}

/** Resolves who gets the "new lead" alert: the assigned staff member's real
 * email, falling back to the tenant's TENANT_ADMIN when no staff was
 * assigned (round-robin found nobody) or that staff has no email on file —
 * same fallback tier resolveAutomationRecipient()'s own 'tenant_admin'
 * strategy uses (automation-rule.service.ts), reused inline here rather than
 * imported since that function's other strategies aren't relevant to this
 * caller. */
async function resolveSalespersonRecipient(
  tenantId: string, leadOwnerStaffId?: string,
): Promise<{ email: string; name: string } | null> {
  if (leadOwnerStaffId) {
    const staff = await NativeStaff.findOne({ tenantId, staffId: leadOwnerStaffId }).select('firstName lastName email').lean();
    if (staff?.email) {
      return { email: staff.email, name: `${staff.firstName} ${staff.lastName}`.trim() };
    }
  }
  const admin = await User.findOne({ tenantId, role: 'TENANT_ADMIN', isActive: true }).lean();
  if (!admin) return null;
  return { email: admin.email, name: `${admin.firstName ?? ''} ${admin.lastName ?? ''}`.trim() || 'there' };
}

const EMAIL_THROTTLE_MS = 10 * 60 * 1000;
const EMAIL_THROTTLE_MAX = 1;

/** Abuse guard, defense-in-depth alongside `hasRecentLeadForEmail` in
 * internal.routes.ts (which should catch this first, at the Lead-creation
 * step) — caps how many NEW `on_create_confirmation` sends one recipient
 * can receive per tenant in a short window. Distinct from
 * `retryFailedChatbotLeadEmails`'s hourly sweep, which only ever RE-sends
 * an existing 'failed' row and is never a source of new volume. Reuses the
 * EmailLog collection that already exists — no new collection needed. */
async function isThrottled(tenantId: string, recipientEmail: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - EMAIL_THROTTLE_MS);
  const recentCount = await EmailLog.countDocuments({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    kind: 'on_create_confirmation', recipientEmail,
    createdAt: { $gte: cutoff },
  });
  return recentCount >= EMAIL_THROTTLE_MAX;
}

/** Writes a 'queued' EmailLog row, attempts the send, then updates that
 * SAME row to 'sent'/'failed'/'skipped' — one row per logical email, never
 * silently lost. `sendEmailNow` either returns a messageId (sent), null
 * (channel not configured — treated as 'skipped', not retryable), or throws
 * (a real provider failure — 'failed', picked up by the hourly retry sweep
 * in scheduler.service.ts). */
async function queueAndSend(entry: {
  tenantId: string; sourceId: string; recipientName: string; recipientEmail: string;
  subject: string; htmlContent: string;
  // Only the CUSTOMER confirmation should ever be throttled — a real
  // salesperson legitimately receives a fresh alert for every genuinely
  // new lead assigned to them, which can easily be more than one within
  // the throttle window and must never be silently dropped.
  applyThrottle: boolean;
}): Promise<void> {
  if (entry.applyThrottle && await isThrottled(entry.tenantId, entry.recipientEmail)) {
    logger.warn('Chatbot-lead email throttled — recent send to this recipient already exists', {
      tenantId: entry.tenantId, recipientEmail: entry.recipientEmail,
    });
    return;
  }
  const row = await EmailLog.create({
    tenantId: new mongoose.Types.ObjectId(entry.tenantId),
    channel: 'email', kind: 'on_create_confirmation', sourceModule: 'lead', sourceId: entry.sourceId,
    relatedModule: 'lead', relatedId: entry.sourceId,
    recipientName: entry.recipientName, recipientEmail: entry.recipientEmail,
    subject: entry.subject, bodyPreview: entry.htmlContent.replace(/<[^>]+>/g, ' ').slice(0, 300),
    fullHtmlContent: entry.htmlContent,
    status: 'queued', attempts: 1,
  });
  await attemptSend(row, entry.recipientName, entry.recipientEmail, entry.subject, entry.htmlContent);
}

async function attemptSend(
  row: IEmailLog, recipientName: string, recipientEmail: string, subject: string, htmlContent: string,
): Promise<void> {
  try {
    const messageId = await sendEmailNow({ to: recipientEmail, toName: recipientName, subject, htmlContent });
    row.status = messageId ? 'sent' : 'skipped';
    row.errorMessage = messageId ? undefined : 'Email channel not configured';
    row.providerMessageId = messageId ?? undefined;
  } catch (err) {
    row.status = 'failed';
    row.errorMessage = (err as Error).message;
  }
  await row.save();
}

function productLine(lead: LeadForEmail): string | null {
  const first = lead.interestedItems?.[0];
  return first ? first.title : null;
}

/** Sends the two chatbot-lead emails (customer confirmation + salesperson
 * alert), tenant-branded, immediately after a chatbot Lead is created.
 * Fire-and-forget from the CALLER's perspective (never awaited by
 * captureLeadFromExternalSource — a slow email provider must never delay
 * the Lead-creation response the visitor is waiting on), but every attempt
 * is tracked in EmailLog, never silently swallowed — see queueAndSend(). */
export async function sendChatbotLeadEmails(tenantId: string, lead: LeadForEmail): Promise<void> {
  try {
    // Gated on widget.autoSendLeadEmails (default true), NOT the generic
    // NotificationSettings.emailEnabled toggle — that field governs a
    // different, unrelated feature (call/meeting/task/ticket on-create
    // confirmations, confirmation.service.ts). autoSendLeadEmails already
    // exists on the Tenant schema with a real Widget Settings UI toggle
    // (WidgetSettingsPage.tsx) — added earlier, this is the first code that
    // actually reads it.
    const tenant = await Tenant.findById(tenantId).select('widget.autoSendLeadEmails').lean();
    if (tenant?.widget?.autoSendLeadEmails === false) return;

    const branding = await resolveBranding(tenantId);
    const product = productLine(lead);
    const leadName = `${lead.firstName} ${lead.lastName ?? ''}`.trim();
    const sourceId = String(lead._id);

    const sends: Promise<void>[] = [];

    if (lead.email) {
      const productBlock = product
        ? `<p>We received your enquiry regarding:</p><p style="font-size:16px;font-weight:600;">${product}</p>`
        : `<p>We received your enquiry.</p>`;
      const contactLines = [
        branding.contactPhone ? `Phone: ${branding.contactPhone}` : null,
        branding.contactEmail ? `Email: ${branding.contactEmail}` : null,
        branding.address      ? `Address: ${branding.address}`   : null,
      ].filter(Boolean).join('<br/>');
      const customerHtml = `
        <p>Hi ${lead.firstName},</p>
        <p>Thank you for your interest in ${branding.companyName}.</p>
        ${productBlock}
        <p>Our sales team will contact you shortly regarding pricing, availability and technical specifications.</p>
        ${contactLines ? `<p>For immediate assistance:</p><p>${contactLines}</p>` : ''}
        <p>Regards,<br/>${branding.companyName}</p>
      `.trim();
      sends.push(queueAndSend({
        tenantId, sourceId, recipientName: leadName, recipientEmail: lead.email,
        subject: `Thank you for contacting ${branding.companyName}`, htmlContent: customerHtml,
        applyThrottle: true,
      }));
    }

    const salesperson = await resolveSalespersonRecipient(tenantId, lead.leadOwnerStaffId);
    if (salesperson) {
      const leadUrl = `${config.app.frontendUrl}/native-crm/leads`;
      const salesHtml = `
        <p>New lead received from the website chatbot.</p>
        <p><strong>Name:</strong> ${leadName}<br/><strong>Email:</strong> ${lead.email ?? '—'}</p>
        ${product ? `<p><strong>Interested Product:</strong><br/>${product}</p>` : ''}
        ${lead.requirement ? `<p><strong>Customer Question:</strong><br/>${lead.requirement}</p>` : ''}
        <p><strong>Source:</strong> AI Chatbot${lead.sourceUrl ? `<br/><strong>Website:</strong> ${lead.sourceUrl}` : ''}</p>
        <p><a href="${leadUrl}">View Lead (${lead.leadId})</a></p>
        <p>Please follow up with the customer.</p>
      `.trim();
      sends.push(queueAndSend({
        tenantId, sourceId, recipientName: salesperson.name, recipientEmail: salesperson.email,
        subject: `🔥 New AI Chatbot Lead — ${product ?? leadName}`, htmlContent: salesHtml,
        applyThrottle: false,
      }));
    }

    await Promise.all(sends);
  } catch (err) {
    logger.error('sendChatbotLeadEmails failed', { tenantId, leadId: String(lead._id), error: (err as Error).message });
  }
}

const MAX_EMAIL_ATTEMPTS = 3;

/** Hourly sweep (scheduler.service.ts) retrying chatbot-lead emails that
 * failed on their first attempt — every EmailLog row queueAndSend() created
 * is a real, findable record of the failure, so this only ever touches rows
 * already 'failed' (never 'queued'/'sent'), meaning a retry can't double-send
 * even if this sweep and a fresh capture race on the same lead. */
export async function retryFailedChatbotLeadEmails(): Promise<void> {
  const rows = await EmailLog.find({
    kind: 'on_create_confirmation', sourceModule: 'lead',
    status: 'failed', attempts: { $lt: MAX_EMAIL_ATTEMPTS },
  }).limit(200);

  for (const row of rows) {
    if (!row.recipientEmail || !row.fullHtmlContent) continue;
    row.attempts = (row.attempts ?? 1) + 1;
    await attemptSend(row, row.recipientName ?? row.recipientEmail, row.recipientEmail, row.subject ?? '', row.fullHtmlContent);
  }
}
