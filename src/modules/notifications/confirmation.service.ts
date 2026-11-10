import mongoose from 'mongoose';
import { logger } from '../../utils/logger';
import { resolveRecipient } from './recipient-resolver';
import { writeLog } from './email-log.service';
import { getOrCreateSettings } from '../native-crm/notification-settings/notification-settings.service';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { Tenant } from '../tenants/tenant.model';
import { FSSettings } from '../native-crm/fs-settings/fs-settings.model';
import { Branch } from '../native-crm/branches/branch.model';
import {
  evaluateAssistantPause, assistantMarkerSelect, assistantPauseInCurrentWrite, AssistantPauseState,
  ASSISTANT_CONFIRMATION_SKIP_REASON, ASSISTANT_MARKER_KEYS, ASSISTANT_CHANGED_AT, ASSISTANT_FINGERPRINT,
} from '../native-crm/shared/assistant-provenance';
import { Call } from '../native-crm/calls/call.model';
import { Ticket } from '../native-crm/tickets/ticket.model';
import type { Model } from 'mongoose';
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

/**
 * LR-PL-NOTIF-001: Resolve decided timezone in order of priority:
 * 1. Record explicit timezone (e.g. call.timezone, meeting.timezone)
 * 2. Branch-specific settings / timezone if linked to branch
 * 3. Field Service business settings (FSSettings.timezone, e.g. Asia/Kolkata)
 * 4. Tenant settings or widget booking config (Tenant.settings.timezone)
 * 5. Fallback: 'Asia/Kolkata'
 */
export async function resolveEffectiveTimezone(
  tenantId: string,
  record?: SourceRecord | null,
): Promise<string> {
  if (record?.timezone && typeof record.timezone === 'string' && record.timezone.trim()) {
    return record.timezone.trim();
  }

  try {
    const tid = new mongoose.Types.ObjectId(tenantId);
    const branchId = (record?.branchId as string) || null;

    if (branchId) {
      try {
        const bid = new mongoose.Types.ObjectId(branchId);
        const branchSettings = await FSSettings.findOne({ tenantId: tid, branchId: bid }).select('timezone').lean();
        if (branchSettings?.timezone && branchSettings.timezone.trim() && branchSettings.timezone !== 'UTC') {
          return branchSettings.timezone.trim();
        }
        const branchDoc = await Branch.findById(bid).select('timezone').lean();
        if (branchDoc?.timezone && branchDoc.timezone.trim()) {
          return branchDoc.timezone.trim();
        }
      } catch {}
    }

    const fsSettings = await FSSettings.findOne({ tenantId: tid, branchId: null }).select('timezone').lean();
    if (fsSettings?.timezone && fsSettings.timezone.trim() && fsSettings.timezone !== 'UTC') {
      return fsSettings.timezone.trim();
    }

    const tenantDoc = await Tenant.findById(tid).select('settings.timezone widget.booking.timezone').lean();
    if (tenantDoc?.settings?.timezone && tenantDoc.settings.timezone.trim() && tenantDoc.settings.timezone !== 'UTC') {
      return tenantDoc.settings.timezone.trim();
    }
    if (tenantDoc?.widget?.booking?.timezone && tenantDoc.widget.booking.timezone.trim() && tenantDoc.widget.booking.timezone !== 'UTC') {
      return tenantDoc.widget.booking.timezone.trim();
    }
    if (tenantDoc?.settings?.timezone && tenantDoc.settings.timezone.trim()) {
      return tenantDoc.settings.timezone.trim();
    }
  } catch (err) {
    logger.warn('Failed to resolve effective timezone, using fallback', { tenantId, err });
  }

  return 'Asia/Kolkata';
}

/**
 * LR-PL-NOTIF-001: Format scheduled times in the decided timezone and print the zone name (rule LR-C3-DEC-009).
 */
export function whenFmt(sourceModule: ConfirmationSourceModule, r: SourceRecord, timeZone: string): string | null {
  const raw = sourceModule === 'call' ? r.date : sourceModule === 'meeting' ? r.startDate : sourceModule === 'task' ? r.dueDate : null;
  if (!raw) return null;
  const d = new Date(raw as string);
  if (isNaN(d.getTime())) return null;
  const tz = timeZone || 'Asia/Kolkata';
  const base = d.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  });
  try {
    const tzPart = new Intl.DateTimeFormat('en-IN', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value;
    const tzLabel = tzPart ? `${tzPart} (${tz})` : `(${tz})`;
    return `${base} ${tzLabel}`;
  } catch {
    return `${base} (${tz})`;
  }
}

export function isPastOrInactiveStatus(sourceModule: ConfirmationSourceModule, record: SourceRecord): boolean {
  if (sourceModule === 'call') {
    const status = String(record.callStatus ?? 'planned').toLowerCase();
    return status === 'completed' || status === 'missed' || status === 'cancelled';
  }
  if (sourceModule === 'meeting') {
    const status = String(record.meetingStatus ?? 'scheduled').toLowerCase();
    return status === 'completed' || status === 'cancelled';
  }
  if (sourceModule === 'task') {
    const status = String(record.taskStatus ?? 'todo').toLowerCase();
    return status === 'done' || status === 'cancelled';
  }
  if (sourceModule === 'ticket') {
    const status = String(record.ticketStatus ?? 'open').toLowerCase();
    return status === 'resolved' || status === 'closed';
  }
  return false;
}

/** Models whose records can carry the CRM-assistant pause markers and get an
 * on-create confirmation. Task never gets one (see below). Meeting is not
 * assistant-writable and has no markers. */
const PAUSE_MARKER_MODELS: Partial<Record<ConfirmationSourceModule, Model<any>>> = { call: Call, ticket: Ticket };

function markersOf(source: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ASSISTANT_MARKER_KEYS) if (source && source[key] !== undefined) out[key] = source[key];
  return out;
}

/** The CRM-assistant pause for a record about to be confirmed
 * (shared/assistant-provenance.ts), using the same fingerprint rule as the
 * reminder cron. The record's own values are compared with the markers
 * STORED for it. The services pass `created.toObject()`, which never
 * carries the (select:false, toObject-hidden) markers, so the stored markers
 * come from one of two places:
 * - the assistant write in progress, when it just created this record
 *   (the gateway create path), or
 * - one `_id` read of the markers.
 * If that read fails or finds nothing, the record's own marker keys are
 * used (normally none, so the confirmation is sent as before). */
async function assistantPauseForConfirmation(sourceModule: ConfirmationSourceModule, record: SourceRecord): Promise<AssistantPauseState> {
  const inThisWrite = assistantPauseInCurrentWrite(sourceModule, String(record._id));
  let stored: Record<string, unknown> | null = inThisWrite
    ? { [ASSISTANT_CHANGED_AT]: inThisWrite.at, [ASSISTANT_FINGERPRINT]: inThisWrite.fingerprint }
    : null;
  const model = PAUSE_MARKER_MODELS[sourceModule];
  if (!stored && model) {
    try {
      const doc = await model.findById(record._id).select(assistantMarkerSelect(model.schema)).lean() as Record<string, unknown> | null;
      if (doc) stored = markersOf(doc);
    } catch (err) {
      logger.warn('On-create confirmation: could not read the CRM-assistant pause markers', { sourceModule, recordId: String(record._id), error: (err as Error).message });
    }
  }
  // A Mongoose document is read through toObject(). A spread would miss its
  // field getters. Its own markers still come from the getters (markersOf).
  const asDocument = record as { toObject?: () => Record<string, unknown> };
  const values: Record<string, unknown> = typeof asDocument.toObject === 'function' ? asDocument.toObject() : { ...record };
  for (const key of ASSISTANT_MARKER_KEYS) delete values[key];
  return evaluateAssistantPause(sourceModule, { ...values, ...(stored ?? markersOf(record)) });
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
    // LR-PL-NOTIF-002: Internal tasks must never send customer confirmations
    if (sourceModule === 'task') return;
    const settings = await getOrCreateSettings(tenantId);
    if (!settings.sendOnCreateConfirmation) return;
    // LR-R2-NOTIF-001: Logging a completed/missed/cancelled call or past activity
    // must not send the "new ... scheduled / we'll follow up" confirmation.
    if (isPastOrInactiveStatus(sourceModule, record)) return;
    if (!record.relatedModule || !record.relatedId) return;
    const relatedModule = record.relatedModule;
    const relatedId = record.relatedId;
    const relatedLabel = record.relatedLabel ?? undefined;

    const sourceId = String(record._id);
    // Backstop: a record whose confirmation data is still exactly what the
    // internal CRM assistant wrote never gets a customer confirmation. Today
    // that is every record the gateway creates (see
    // native-crm/shared/assistant-provenance.ts). Decided before any
    // recipient is resolved or content rendered, and logged so history stays
    // complete. Nothing retries these rows.
    if ((await assistantPauseForConfirmation(sourceModule, record)).paused) {
      await writeLog({
        tenantId, channel: 'email', kind: 'on_create_confirmation', sourceModule, sourceId,
        relatedModule, relatedId, relatedLabel,
        status: 'skipped', errorMessage: ASSISTANT_CONFIRMATION_SKIP_REASON,
      });
      return;
    }
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

    // LR-PL-NOTIF-001: Resolve timezone from record, branch, FSSettings, tenant settings, or booking config
    const effectiveTimezone: string = await resolveEffectiveTimezone(tenantId, record);

    const when = whenFmt(sourceModule, record, effectiveTimezone);
    const whenLine = when ? ` scheduled for <strong>${when}</strong>` : '';
    const subject = `Confirmed: ${title} — new ${noun}`;

    // Activity enrichment: display timezone & meeting/call details
    let activityDetailLines = '';
    const details: string[] = [];
    if (sourceModule === 'meeting') {
      if (record.teamName) details.push(`<strong>Team:</strong> ${record.teamName}`);
      if (record.assignedStaffName) details.push(`<strong>With:</strong> ${record.assignedStaffName}`);
      const topicMatch = typeof record.notes === 'string' ? record.notes.match(/Topic:\s*(.+)$/) : null;
      if (topicMatch) details.push(`<strong>Reason:</strong> ${topicMatch[1]}`);
      if (effectiveTimezone) details.push(`<strong>Timezone:</strong> ${effectiveTimezone}`);
    } else if (sourceModule === 'call') {
      if (record.duration) details.push(`<strong>Duration:</strong> ${record.duration} mins`);
      if (effectiveTimezone) details.push(`<strong>Timezone:</strong> ${effectiveTimezone}`);
    }
    if (details.length) activityDetailLines = `<p>${details.join('<br/>')}</p>`;

    const htmlContent = `<p>Hi <strong>${recipient.name}</strong>,</p><p>This confirms a new ${noun} — <strong>${title}</strong>${whenLine}.</p>${activityDetailLines}<p>We'll follow up ahead of time if it's coming up soon.</p><p>Best regards,<br/>LeadRyze AI</p>`;
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
