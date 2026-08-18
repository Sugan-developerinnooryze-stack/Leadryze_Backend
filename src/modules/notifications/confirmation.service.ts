import { logger } from '../../utils/logger';
import { resolveRecipient } from './recipient-resolver';
import { writeLog } from './email-log.service';
import { getOrCreateSettings } from '../native-crm/notification-settings/notification-settings.service';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { Tenant } from '../tenants/tenant.model';
// This module only ever handles the 4 "scheduled item" sources — the wider
// EmailLogSourceModule (which also covers automation-rule sources like
// 'lead'/'deal'/'quotation') is a storage-level type, not this file's scope.
type ConfirmationSourceModule = 'call' | 'meeting' | 'task' | 'ticket';

interface SourceRecord {
  _id: unknown;
  tenantId: unknown;
  relatedModule?: string | null;
  relatedId?: string | null;
  relatedLabel?: string | null;
  [key: string]: unknown;
}

const NOUN: Record<ConfirmationSourceModule, string> = {
  call: 'call', meeting: 'meeting', task: 'task', ticket: 'ticket',
};

function titleOf(sourceModule: ConfirmationSourceModule, r: SourceRecord): string {
  if (sourceModule === 'call') return String(r.contactName ?? 'your call');
  if (sourceModule === 'ticket') return String(r.subject ?? 'your ticket');
  return String(r.title ?? `your ${NOUN[sourceModule]}`);
}

// `timeZone` matters specifically for meetings: without it, toLocaleString()
// falls back to whatever system timezone the Node process happens to be
// running in (Render's containers default to UTC, but a local dev machine —
// or any future host — can be set to anything), which has nothing to do
// with the tenant's own configured booking timezone. A meeting's startDate
// is a real UTC instant; formatting it without the tenant's timezone can
// silently show the wrong wall-clock time to the recipient (confirmed live:
// a UTC-configured tenant's 10:00 AM booking rendered as 3:30 PM on an
// IST-local machine — exactly the +5:30 offset). Call/task/ticket records
// have no per-tenant timezone concept to draw from, so they're left exactly
// as before — this fix is scoped to what's actually wrong.
function whenFmt(sourceModule: ConfirmationSourceModule, r: SourceRecord, timeZone?: string): string | null {
  const raw = sourceModule === 'call' ? r.date : sourceModule === 'meeting' ? r.startDate : sourceModule === 'task' ? r.dueDate : null;
  if (!raw) return null;
  const d = new Date(raw as string);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
}

/**
 * Fires an immediate "you have a new X scheduled" confirmation when a
 * Call/Meeting/Task/Ticket is created linked to a resolvable Customer/
 * Contact. Fire-and-forget from the caller's perspective — never throws,
 * always writes an EmailLog row (sent/failed/skipped) so history stays
 * complete even when nothing could be sent.
 */
export async function sendOnCreateConfirmation(
  tenantId: string,
  sourceModule: ConfirmationSourceModule,
  record: SourceRecord,
): Promise<void> {
  try {
    const settings = await getOrCreateSettings(tenantId);
    if (!settings.sendOnCreateConfirmation) return;
    if (!record.relatedModule || !record.relatedId) return;
    const relatedModule = record.relatedModule;
    const relatedId = record.relatedId;
    const relatedLabel = record.relatedLabel ?? undefined;

    const sourceId = String(record._id);
    const recipient = await resolveRecipient(tenantId, relatedModule, relatedId);
    const title = titleOf(sourceModule, record);
    const noun = NOUN[sourceModule];

    if (!recipient || (!recipient.email && !recipient.phone)) {
      await writeLog({
        tenantId, channel: 'email', kind: 'on_create_confirmation', sourceModule, sourceId,
        relatedModule, relatedId, relatedLabel,
        status: 'skipped', errorMessage: 'No resolvable recipient',
      });
      return;
    }

    const meetingTimezone = sourceModule === 'meeting'
      ? (await Tenant.findById(tenantId).select('widget.booking.timezone').lean())?.widget?.booking?.timezone || 'UTC'
      : undefined;
    const when = whenFmt(sourceModule, record, meetingTimezone);
    const whenLine = when ? ` scheduled for <strong>${when}</strong>` : '';
    const subject = `Confirmed: ${title} — new ${noun}`;

    // Meeting-specific enrichment — team/assigned staff/timezone/service are
    // all real fields already on the Meeting document (createMeeting()
    // passes the full saved doc as `record`), just never surfaced in this
    // shared, generic confirmation email before now.
    let meetingDetailLines = '';
    if (sourceModule === 'meeting') {
      const details: string[] = [];
      if (record.teamName) details.push(`<strong>Team:</strong> ${record.teamName}`);
      if (record.assignedStaffName) details.push(`<strong>With:</strong> ${record.assignedStaffName}`);
      const topicMatch = typeof record.notes === 'string' ? record.notes.match(/Topic:\s*(.+)$/) : null;
      if (topicMatch) details.push(`<strong>Reason:</strong> ${topicMatch[1]}`);
      if (meetingTimezone) details.push(`<strong>Timezone:</strong> ${meetingTimezone}`);
      if (details.length) meetingDetailLines = `<p>${details.join('<br/>')}</p>`;
    }

    const htmlContent = `<p>Hi <strong>${recipient.name}</strong>,</p><p>This confirms a new ${noun} — <strong>${title}</strong>${whenLine}.</p>${meetingDetailLines}<p>We'll follow up ahead of time if it's coming up soon.</p><p>Best regards,<br/>LeadRyze AI</p>`;
    const smsText = `Hi ${recipient.name}, confirming your new ${noun} "${title}"${when ? ` on ${when}` : ''}.`;

    if (settings.emailEnabled && recipient.email) {
      try {
        const messageId = await sendEmailNow({ to: recipient.email, toName: recipient.name, subject, htmlContent });
        await writeLog({
          tenantId, channel: 'email', kind: 'on_create_confirmation', sourceModule, sourceId,
          relatedModule, relatedId, relatedLabel,
          recipientName: recipient.name, recipientEmail: recipient.email,
          subject, bodyPreview: htmlContent.replace(/<[^>]+>/g, ' '),
          status: messageId ? 'sent' : 'skipped', providerMessageId: messageId ?? undefined,
          errorMessage: messageId ? undefined : 'Email channel not configured',
        });
      } catch (err) {
        await writeLog({
          tenantId, channel: 'email', kind: 'on_create_confirmation', sourceModule, sourceId,
          relatedModule, relatedId, relatedLabel,
          recipientName: recipient.name, recipientEmail: recipient.email, subject,
          status: 'failed', errorMessage: (err as Error).message,
        });
      }
    }

    if (settings.smsEnabled && recipient.phone) {
      // sendSmsNow never rejects — it returns null on both "not configured"
      // and "provider call failed" (see twilio.service.ts), so status is
      // derived from the return value rather than a try/catch.
      const sid = await sendSmsNow({ to: recipient.phone, body: smsText });
      await writeLog({
        tenantId, channel: 'sms', kind: 'on_create_confirmation', sourceModule, sourceId,
        relatedModule, relatedId, relatedLabel,
        recipientName: recipient.name, recipientPhone: recipient.phone,
        bodyPreview: smsText, status: sid ? 'sent' : 'failed', providerMessageId: sid ?? undefined,
        errorMessage: sid ? undefined : 'SMS send failed or not configured',
      });
    }
  } catch (err) {
    logger.error('On-create confirmation failed', { sourceModule, recordId: String(record._id), error: (err as Error).message });
  }
}
