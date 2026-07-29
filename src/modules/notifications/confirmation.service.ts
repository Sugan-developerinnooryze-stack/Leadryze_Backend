import { logger } from '../../utils/logger';
import { resolveRecipient } from './recipient-resolver';
import { writeLog } from './email-log.service';
import { getOrCreateSettings } from '../native-crm/notification-settings/notification-settings.service';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
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

function whenFmt(sourceModule: ConfirmationSourceModule, r: SourceRecord): string | null {
  const raw = sourceModule === 'call' ? r.date : sourceModule === 'meeting' ? r.startDate : sourceModule === 'task' ? r.dueDate : null;
  if (!raw) return null;
  const d = new Date(raw as string);
  return isNaN(d.getTime()) ? null : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
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

    const when = whenFmt(sourceModule, record);
    const whenLine = when ? ` scheduled for <strong>${when}</strong>` : '';
    const subject = `Confirmed: ${title} — new ${noun}`;
    const htmlContent = `<p>Hi <strong>${recipient.name}</strong>,</p><p>This confirms a new ${noun} — <strong>${title}</strong>${whenLine}.</p><p>We'll follow up ahead of time if it's coming up soon.</p><p>Best regards,<br/>LeadRyze AI</p>`;
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
