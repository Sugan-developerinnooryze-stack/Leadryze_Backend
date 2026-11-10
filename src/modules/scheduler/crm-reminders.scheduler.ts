/**
 * Reminder cron for Native CRM's own Call/Meeting/Task records — separate
 * from the pre-existing runMeetingReminders/runMeetingFollowups in
 * scheduler.service.ts, which operate on the unrelated "My CRM" Activity
 * model (synced external-CRM contacts via linkedPerson). The recipient is
 * resolved live via relatedModule/relatedId since Call/Meeting/Task store no
 * email/phone of their own; the lookahead window is configurable per tenant
 * via NotificationSettings (default 15 minutes) rather than hardcoded.
 * Ticket is intentionally excluded — it has no date field to key a
 * pre-event reminder off of (it still gets an on-create confirmation, see
 * notifications/confirmation.service.ts).
 *
 * CRM-assistant reminder pause (native-crm/shared/assistant-provenance.ts):
 * a Call/Task whose reminder-relevant values are still exactly what the
 * internal CRM assistant wrote (stamped, and its fingerprint still matches)
 * gets no customer reminder. That is decided from the record this tick read,
 * before any recipient is resolved. The skip gets one 'skipped' EmailLog row
 * per pause, and reminderSentAt stays unset. Once someone else has changed
 * that data, the fingerprint no longer matches and the normal rules below
 * decide, exactly as for a record created in the app screens.
 */
import { logger } from '../../utils/logger';
import { Call } from '../native-crm/calls/call.model';
import { Meeting } from '../native-crm/meetings/meeting.model';
import { Task } from '../native-crm/tasks/task.model';
import { resolveRecipient } from '../notifications/recipient-resolver';
import { writeLog } from '../notifications/email-log.service';
import { getOrCreateSettings } from '../native-crm/notification-settings/notification-settings.service';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { EmailLogSourceModule } from '../notifications/email-log.model';
import { Tenant } from '../tenants/tenant.model';
import { isFeatureFlagEnabled } from '../tenants/tenant.service';
import { resolveEffectiveTimezone } from '../notifications/confirmation.service';
import {
  evaluateAssistantPause, assistantMarkerSelect, runAsReminderBookkeeping, AssistantPauseState,
  ASSISTANT_REMINDER_SKIP_REASON, ASSISTANT_CHANGED_AT, REMINDER_SUPPRESSED_AT,
} from '../native-crm/shared/assistant-provenance';
import type { Model } from 'mongoose';

type ReminderKind = Extract<EmailLogSourceModule, 'call' | 'meeting' | 'task'>;

// Broad outer window for the Mongo query; the tenant's actual configured
// window is applied afterward as a tolerance-banded post-filter, since
// different tenants can configure different reminderWindowMinutes values.
const OUTER_MIN_MINUTES = 5;
const OUTER_MAX_MINUTES = 60;
const TOLERANCE_MINUTES = 2;

function buildReminderContent(kind: ReminderKind, title: string, recipientName: string, whenFmt: string, windowMinutes: number) {
  const noun = kind === 'call' ? 'call' : kind === 'meeting' ? 'meeting' : 'task';
  const subject = `Reminder: ${title} — ${noun} starts in ${windowMinutes} minutes`;
  const htmlContent = `<p>Hi <strong>${recipientName}</strong>,</p><p>Just a reminder that your ${noun} <strong>${title}</strong> is scheduled for <strong>${whenFmt}</strong> — that's in about ${windowMinutes} minutes.</p><p>Best regards,<br/>LeadRyze AI</p>`;
  const smsText = `Hi ${recipientName}, reminder: your ${noun} "${title}" starts in ~${windowMinutes} min at ${whenFmt}.`;
  return { subject, htmlContent, smsText };
}

async function windowMinutesFor(cache: Map<string, number>, tenantId: string): Promise<number> {
  if (cache.has(tenantId)) return cache.get(tenantId)!;
  const settings = await getOrCreateSettings(tenantId);
  const minutes = settings.reminderWindowMinutes ?? 15;
  cache.set(tenantId, minutes);
  return minutes;
}

interface ReminderTarget {
  sourceModule: ReminderKind;
  sourceId:     string;
  tenantId:     string;
  relatedModule: string;
  relatedId:     string;
  relatedLabel?: string | null;
  title:         string;
  when?:         Date;
  markSent:      () => Promise<unknown>;
  /** The CRM-assistant reminder pause, evaluated from the record this tick
   * read (shared/assistant-provenance.ts evaluateAssistantPause). */
  pause:          AssistantPauseState;
  /** Records that the "not sent" skip was logged for the record's CURRENT
   * pause. Resolves true only for the first caller for that pause. */
  markSuppressed: () => Promise<boolean>;
  /** LR-PL-NOTIF-001: the record's own zone fields (a call's or meeting's
   * timezone, a task's branchId). The reminder resolves its zone from them
   * exactly as the on-create confirmation does, so both e-mails for the same
   * call or meeting name the same zone. */
  zone:          { timezone?: unknown; branchId?: unknown };
}

/** Sets reminderSuppressedAt only while the record still carries the pause
 * stamp this tick read and has no marker yet, so exactly one tick per pause
 * gets `true`. Runs as reminder bookkeeping, the only writer the model hooks
 * let set this marker. Never touches reminderSentAt or the pause itself, so
 * a record whose data someone changes later still gets its normal reminder.
 * Does not bump updatedAt. A model without the marker (Meeting, which is not
 * assistant-writable) never records one. The paused record is still
 * re-selected on later ticks: the pause is re-evaluated from its values every
 * time. A tick that already read the marker (`alreadyMarked`) neither writes
 * nor logs again. */
async function markSuppressedOnce(model: Model<any>, id: unknown, stamp: unknown, alreadyMarked: unknown, now: Date): Promise<boolean> {
  if (!model.schema.path(REMINDER_SUPPRESSED_AT) || stamp === null || stamp === undefined) return false;
  if (alreadyMarked !== null && alreadyMarked !== undefined) return false;
  const res = await runAsReminderBookkeeping(() => model.updateOne(
    { _id: id, [ASSISTANT_CHANGED_AT]: stamp, [REMINDER_SUPPRESSED_AT]: null },
    { $set: { [REMINDER_SUPPRESSED_AT]: now } },
    { timestamps: false },
  ).exec());
  return (res?.modifiedCount ?? 0) > 0;
}

async function sendReminder(target: ReminderTarget, windowMinutes: number): Promise<void> {
  const { tenantId, sourceModule, sourceId, relatedModule, relatedId, relatedLabel } = target;

  const tenant = await Tenant.findById(tenantId).select('featureFlags').lean();
  if (!isFeatureFlagEnabled({ featureFlags: tenant?.featureFlags }, 'auto_reminder')) {
    logger.debug(`${sourceModule} reminder skipped — auto_reminder disabled for tenant`, { id: sourceId, tenantId });
    return;
  }

  // Reminder data still exactly as the CRM assistant wrote it: no customer
  // reminder. This is decided before any recipient is resolved or content
  // rendered. The skip is logged once per pause, and reminderSentAt stays
  // unset. Once someone else changes that data, the pause no longer holds and
  // the record gets its normal reminder.
  if (target.pause.paused) {
    if (await target.markSuppressed()) {
      await writeLog({
        tenantId, channel: 'email', kind: 'reminder', sourceModule, sourceId,
        relatedModule, relatedId, relatedLabel, status: 'skipped', errorMessage: ASSISTANT_REMINDER_SKIP_REASON,
      });
      logger.info(`${sourceModule} reminder not sent — reminder details still as set through the CRM assistant`, { id: sourceId, reason: target.pause.reason });
    }
    return;
  }

  const settings = await getOrCreateSettings(tenantId);
  const recipient = await resolveRecipient(tenantId, relatedModule, relatedId);

  if (!recipient || (!recipient.email && !recipient.phone)) {
    logger.debug(`${sourceModule} reminder skipped — no resolvable recipient`, { id: sourceId });
    await writeLog({
      tenantId, channel: 'email', kind: 'reminder', sourceModule, sourceId,
      relatedModule, relatedId, relatedLabel, status: 'skipped', errorMessage: 'No resolvable recipient',
    });
    return;
  }

  // LR-PL-NOTIF-001: same resolution as the confirmation (record zone first,
  // then branch, business and tenant settings). It used the tenant chain only,
  // so a call entered in Asia/Kolkata was confirmed in IST but reminded in the
  // tenant's zone.
  const effectiveTz = await resolveEffectiveTimezone(tenantId, { _id: sourceId, tenantId, ...target.zone });
  let whenFmt = 'soon';
  if (target.when) {
    const base = target.when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: effectiveTz });
    try {
      const tzPart = new Intl.DateTimeFormat('en-IN', { timeZone: effectiveTz, timeZoneName: 'short' })
        .formatToParts(target.when)
        .find((p) => p.type === 'timeZoneName')?.value;
      const tzLabel = tzPart ? `${tzPart} (${effectiveTz})` : `(${effectiveTz})`;
      whenFmt = `${base} ${tzLabel}`;
    } catch {
      whenFmt = `${base} (${effectiveTz})`;
    }
  }

  const { subject, htmlContent, smsText } = buildReminderContent(sourceModule, target.title, recipient.name, whenFmt, windowMinutes);

  await target.markSent();

  if (settings.emailEnabled && recipient.email) {
    try {
      const messageId = await sendEmailNow({ to: recipient.email, toName: recipient.name, subject, htmlContent });
      await writeLog({
        tenantId, channel: 'email', kind: 'reminder', sourceModule, sourceId, relatedModule, relatedId, relatedLabel,
        recipientName: recipient.name, recipientEmail: recipient.email, subject,
        bodyPreview: htmlContent.replace(/<[^>]+>/g, ' '),
        status: messageId ? 'sent' : 'skipped', providerMessageId: messageId ?? undefined,
        errorMessage: messageId ? undefined : 'Email channel not configured',
      });
    } catch (err) {
      logger.error(`${sourceModule} reminder email failed`, { id: sourceId, error: (err as Error).message });
      await writeLog({
        tenantId, channel: 'email', kind: 'reminder', sourceModule, sourceId, relatedModule, relatedId, relatedLabel,
        recipientName: recipient.name, recipientEmail: recipient.email, subject,
        status: 'failed', errorMessage: (err as Error).message,
      });
    }
  }

  if (settings.smsEnabled && recipient.phone) {
    // sendSmsNow never rejects — it returns null on both "not configured"
    // and "provider call failed" (see twilio.service.ts).
    const sid = await sendSmsNow({ to: recipient.phone, body: smsText });
    await writeLog({
      tenantId, channel: 'sms', kind: 'reminder', sourceModule, sourceId, relatedModule, relatedId, relatedLabel,
      recipientName: recipient.name, recipientPhone: recipient.phone, bodyPreview: smsText,
      status: sid ? 'sent' : 'failed', providerMessageId: sid ?? undefined,
      errorMessage: sid ? undefined : 'SMS send failed or not configured',
    });
  }

  logger.info(`${sourceModule} reminder sent`, { id: sourceId, to: recipient.email || recipient.phone });
}

export async function runCallMeetingReminders(): Promise<void> {
  const now = new Date();
  const outerStart = new Date(now.getTime() + OUTER_MIN_MINUTES * 60 * 1000);
  const outerEnd   = new Date(now.getTime() + OUTER_MAX_MINUTES * 60 * 1000);
  const windowCache = new Map<string, number>();

  try {
    const [candidateCalls, candidateMeetings, candidateTasks] = await Promise.all([
      Call.find({
        date: { $gte: outerStart, $lte: outerEnd },
        callStatus: 'planned',
        reminderSentAt: { $exists: false },
        relatedModule: { $exists: true, $ne: null },
        relatedId: { $exists: true, $ne: null },
      }).select(assistantMarkerSelect(Call.schema)).lean(),
      Meeting.find({
        startDate: { $gte: outerStart, $lte: outerEnd },
        meetingStatus: 'scheduled',
        reminderSentAt: { $exists: false },
        relatedModule: { $exists: true, $ne: null },
        relatedId: { $exists: true, $ne: null },
      }).lean(),
      Task.find({
        dueDate: { $gte: outerStart, $lte: outerEnd },
        taskStatus: { $nin: ['done', 'cancelled'] },
        reminderSentAt: { $exists: false },
        relatedModule: { $exists: true, $ne: null },
        relatedId: { $exists: true, $ne: null },
      }).select(assistantMarkerSelect(Task.schema)).lean(),
    ]);

    if (candidateCalls.length === 0 && candidateMeetings.length === 0 && candidateTasks.length === 0) return;
    logger.info(`Native CRM reminder check: ${candidateCalls.length} call(s), ${candidateMeetings.length} meeting(s), ${candidateTasks.length} task(s) in outer window`);

    for (const call of candidateCalls) {
      try {
        const tenantId = String(call.tenantId);
        const windowMinutes = await windowMinutesFor(windowCache, tenantId);
        const diffMin = ((call.date as Date).getTime() - now.getTime()) / 60000;
        if (Math.abs(diffMin - windowMinutes) > TOLERANCE_MINUTES) continue;
        await sendReminder({
          sourceModule: 'call', sourceId: String(call._id), tenantId,
          relatedModule: call.relatedModule!, relatedId: call.relatedId!, relatedLabel: call.relatedLabel,
          title: call.contactName, when: call.date as Date,
          zone: { timezone: (call as { timezone?: unknown }).timezone },
          markSent: () => Call.findByIdAndUpdate(call._id, { reminderSentAt: now }),
          pause: evaluateAssistantPause('call', call),
          markSuppressed: () => markSuppressedOnce(Call, call._id, call.assistantChangedAt, call.reminderSuppressedAt, now),
        }, windowMinutes);
      } catch (err) {
        logger.error('Call reminder failed', { callId: String(call._id), error: (err as Error).message });
      }
    }

    for (const meeting of candidateMeetings) {
      try {
        const tenantId = String(meeting.tenantId);
        const windowMinutes = await windowMinutesFor(windowCache, tenantId);
        const diffMin = ((meeting.startDate as Date).getTime() - now.getTime()) / 60000;
        if (Math.abs(diffMin - windowMinutes) > TOLERANCE_MINUTES) continue;
        await sendReminder({
          sourceModule: 'meeting', sourceId: String(meeting._id), tenantId,
          relatedModule: meeting.relatedModule!, relatedId: meeting.relatedId!, relatedLabel: meeting.relatedLabel,
          title: meeting.title, when: meeting.startDate as Date,
          zone: { timezone: (meeting as { timezone?: unknown }).timezone },
          markSent: () => Meeting.findByIdAndUpdate(meeting._id, { reminderSentAt: now }),
          // Meeting is not assistant-writable and has no markers. A stamp, if
          // one were ever present, would be honoured (paused, never logged).
          pause: evaluateAssistantPause('meeting', meeting),
          markSuppressed: () => markSuppressedOnce(Meeting, meeting._id, (meeting as { assistantChangedAt?: unknown }).assistantChangedAt, undefined, now),
        }, windowMinutes);
      } catch (err) {
        logger.error('Meeting reminder failed', { meetingId: String(meeting._id), error: (err as Error).message });
      }
    }

    for (const task of candidateTasks) {
      try {
        const tenantId = String(task.tenantId);
        const windowMinutes = await windowMinutesFor(windowCache, tenantId);
        const diffMin = ((task.dueDate as Date).getTime() - now.getTime()) / 60000;
        if (Math.abs(diffMin - windowMinutes) > TOLERANCE_MINUTES) continue;
        await sendReminder({
          sourceModule: 'task', sourceId: String(task._id), tenantId,
          relatedModule: task.relatedModule!, relatedId: task.relatedId!, relatedLabel: task.relatedLabel,
          title: task.title, when: task.dueDate as Date,
          zone: { branchId: (task as { branchId?: unknown }).branchId },
          markSent: () => Task.findByIdAndUpdate(task._id, { reminderSentAt: now }),
          pause: evaluateAssistantPause('task', task),
          markSuppressed: () => markSuppressedOnce(Task, task._id, task.assistantChangedAt, task.reminderSuppressedAt, now),
        }, windowMinutes);
      } catch (err) {
        logger.error('Task reminder failed', { taskId: String(task._id), error: (err as Error).message });
      }
    }
  } catch (err) {
    logger.error('Native CRM reminder cron crashed', { error: (err as Error).message });
  }
}
