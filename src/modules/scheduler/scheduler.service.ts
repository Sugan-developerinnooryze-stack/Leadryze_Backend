import cron from 'node-cron';
import { logger } from '../../utils/logger';
import { runContractScheduler } from '../native-crm/contracts/contract.scheduler';
import { Connector } from '../connectors/connector.model';
import { Customer } from '../customers/customer.model';
import { Activity } from '../activities/activity.model';
import { syncCRMToLocal } from '../connectors/connector.service';
import { isRedisAvailable, createBullMQConnection } from '../../config/redis';
import { writeLog } from '../logs/log.service';
import { sendEmailNow, buildFollowupEmail } from '../messages/brevo.service';
import { sendSmsNow, buildFollowupSms } from '../messages/twilio.service';

// ─── BullMQ (Redis-dependent) — graceful stub when Redis unavailable ──────────
let _bullmqAvailable = false;
export let emailQueue: { add: (...a: unknown[]) => Promise<void> } = { add: async () => {} };
export let whatsappQueue: { add: (...a: unknown[]) => Promise<void> } = { add: async () => {} };
export let followupQueue: { add: (...a: unknown[]) => Promise<void> } = { add: async () => {} };

export function initQueues(): void {
  if (isRedisAvailable()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Queue, Worker } = require('bullmq');
      const conn = createBullMQConnection();

      emailQueue    = new Queue('email',    { connection: conn });
      whatsappQueue = new Queue('whatsapp', { connection: conn });
      followupQueue = new Queue('followup', { connection: conn });

      new Worker('email', async (job: { id: string; data: Record<string, unknown> }) => {
        const { to, toName, subject, htmlContent } = job.data as { to: string; toName?: string; subject: string; htmlContent: string };
        if (to && subject && htmlContent) {
          await sendEmailNow({ to, toName, subject, htmlContent });
        }
        logger.info('Email job processed', { jobId: job.id, to });
      }, { connection: createBullMQConnection() });
      new Worker('whatsapp', async (job: { id: string; data: Record<string, unknown> }) => {
        const { to, body } = job.data as { to: string; body: string };
        if (to && body) {
          await sendSmsNow({ to, body });
        }
        logger.info('WhatsApp/SMS job processed', { jobId: job.id, to });
      }, { connection: createBullMQConnection() });
      new Worker('followup', async (job: { id: string; data: Record<string, unknown> }) => {
        logger.info('Followup job', { jobId: job.id, tenantId: job.data.tenantId, customerId: job.data.customerId });
      }, { connection: createBullMQConnection() });

      _bullmqAvailable = true;
      logger.info('BullMQ queues initialized');
    } catch (err) {
      logger.warn('BullMQ init failed', { error: (err as Error).message });
    }
  } else {
    logger.info('Redis not available — BullMQ skipped, cron-only mode active');
  }

  // Cron jobs always run regardless of Redis
  initCronJobs();
}

// ─── Auto CRM Sync — runs every 30 min for ALL tenants ───────────────────────
async function runCRMSyncForAllTenants(): Promise<void> {
  try {
    const connectors = await Connector.find({ isActive: true }).select(
      '+config.apiKey +config.accessToken +config.baseUrl +config.refreshToken'
    );

    if (connectors.length === 0) {
      logger.info('CRM auto-sync: no active connectors found');
      return;
    }

    logger.info(`CRM auto-sync: syncing ${connectors.length} connector(s)`);

    for (const connector of connectors) {
      try {
        const tenantId = connector.tenantId.toString();
        const connectorId = connector._id.toString();

        // Mark as syncing
        await Connector.findByIdAndUpdate(connectorId, { syncStatus: 'syncing' });

        const result = await syncCRMToLocal(tenantId, connectorId);

        logger.info('CRM auto-sync complete', {
          tenant: tenantId,
          connector: connector.name,
          type: connector.type,
          created: result.created,
          updated: result.updated,
          total: result.total,
        });

        const hasChanges = result.created > 0 || result.updated > 0 || result.deleted > 0;
        writeLog({
          tenantId,
          service: 'backend',
          level:   hasChanges ? 'info' : 'debug',
          event:   'connector.sync',
          message: `Auto-sync — ${connector.name} (${connector.type}): +${result.created} created, ~${result.updated} updated, -${result.deleted} deleted`,
          metadata: {
            connectorId:   connectorId,
            connectorName: connector.name,
            connectorType: connector.type,
            created:       result.created,
            updated:       result.updated,
            deleted:       result.deleted,
            total:         result.total,
            triggeredBy:   'cron',
          },
        });
      } catch (err) {
        logger.error('CRM auto-sync failed for connector', {
          connector: connector.name,
          error: (err as Error).message,
        });
        writeLog({
          tenantId: connector.tenantId.toString(),
          service:  'backend',
          level:    'error',
          event:    'connector.sync_failed',
          message:  `Auto-sync failed — ${connector.name} (${connector.type}): ${(err as Error).message}`,
          metadata: {
            connectorId:   connector._id.toString(),
            connectorName: connector.name,
            connectorType: connector.type,
            error:         (err as Error).message,
            triggeredBy:   'cron',
          },
        });
        await Connector.findByIdAndUpdate(connector._id, {
          syncStatus: 'failed',
          syncError: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger.error('CRM auto-sync job crashed', { error: (err as Error).message });
  }
}

// ─── AI Follow-up Check — runs daily at 9am ──────────────────────────────────
async function runDailyFollowupCheck(): Promise<void> {
  try {
    // Find customers who need follow-up: last contact was between 2-30 days ago
    type CustomerLean = {
      _id: unknown; tenantId: unknown; firstName: string; lastName?: string;
      email?: string; phone?: string; channel: string; lastContactedAt?: Date; updatedAt: Date;
    };

    const customers = await Customer.find({
      status: { $in: ['new', 'contacted'] },
    }).limit(100).lean<CustomerLean[]>();

    logger.info(`Daily follow-up check: ${customers.length} customer(s) need follow-up`);

    for (const customer of customers) {
      const lastContact: Date = customer.lastContactedAt ?? customer.updatedAt;
      const daysSince = Math.floor((Date.now() - lastContact.getTime()) / 86400000);
      if (daysSince < 2 || daysSince > 30) continue;

      const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Customer';
      const tenantId = String(customer.tenantId);
      const customerId = String(customer._id);

      // Send follow-up email if customer has an email address
      if (customer.email) {
        const emailOpts = buildFollowupEmail(customerName, 'LeadRyze AI', daysSince);
        emailOpts.to = customer.email;
        emailOpts.toName = customerName;
        await sendEmailNow(emailOpts).catch((err: Error) =>
          logger.error('Follow-up email failed', { customerId, error: err.message })
        );
      }

      // Send follow-up SMS if customer has a phone number
      if (customer.phone) {
        const smsBody = buildFollowupSms(customerName, daysSince);
        await sendSmsNow({ to: customer.phone, body: smsBody }).catch((err: Error) =>
          logger.error('Follow-up SMS failed', { customerId, error: err.message })
        );
      }

      if (_bullmqAvailable) {
        await followupQueue.add('followup', {
          tenantId, customerId, customerName,
          daysSinceContact: daysSince,
          channel: customer.channel || 'whatsapp',
          action: 'followup',
        });
      } else {
        logger.info('FOLLOWUP NEEDED', {
          tenant: tenantId, customer: customerName,
          email: customer.email, phone: customer.phone, daysSince,
        });
      }
    }
  } catch (err) {
    logger.error('Daily follow-up check failed', { error: (err as Error).message });
  }
}

// ─── 20-minute meeting reminder ──────────────────────────────────────────────
async function runMeetingReminders(): Promise<void> {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() + 18 * 60 * 1000); // 18 min from now
    const windowEnd   = new Date(now.getTime() + 22 * 60 * 1000); // 22 min from now

    const activities = await Activity.find({
      startDate:      { $gte: windowStart, $lte: windowEnd },
      reminderSentAt: { $exists: false },
      status:         { $in: ['pending', 'in_progress'] },
      'linkedPerson.email': { $exists: true, $ne: '' },
    }).lean();

    if (activities.length === 0) return;
    logger.info(`Meeting reminder check: ${activities.length} activity(ies) in window`);

    for (const activity of activities) {
      const lp = activity.linkedPerson;
      if (!lp) continue;

      const startFmt = activity.startDate
        ? new Date(activity.startDate).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        : 'soon';

      const subject  = `Reminder: ${activity.title} starts in 20 minutes`;
      const htmlBody = `<p>Hi <strong>${lp.displayName}</strong>,</p><p>Just a reminder that <strong>${activity.title}</strong> is scheduled to start at <strong>${startFmt}</strong> — that's in about 20 minutes.</p><p>Best regards,<br/>LeadRyze AI</p>`;
      const smsText  = `Hi ${lp.displayName}, reminder: "${activity.title}" starts in ~20 min at ${startFmt}.`;

      const tasks: Promise<unknown>[] = [
        Activity.findByIdAndUpdate(activity._id, { reminderSentAt: now }),
      ];

      if (lp.email) {
        tasks.push(
          sendEmailNow({ to: lp.email, toName: lp.displayName, subject, htmlContent: htmlBody }).catch((err: Error) =>
            logger.error('Reminder email failed', { activityId: String(activity._id), error: err.message })
          )
        );
      }
      if (lp.phone) {
        tasks.push(
          sendSmsNow({ to: lp.phone, body: smsText }).catch((err: Error) =>
            logger.error('Reminder SMS failed', { activityId: String(activity._id), error: err.message })
          )
        );
      }

      await Promise.all(tasks);
      logger.info('Meeting reminder sent', { activityId: String(activity._id), title: activity.title, to: lp.email || lp.phone });
    }
  } catch (err) {
    logger.error('Meeting reminder cron failed', { error: (err as Error).message });
  }
}

// ─── Post-meeting follow-up (30 min after end) ───────────────────────────────
async function runMeetingFollowups(): Promise<void> {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 35 * 60 * 1000); // ended 35 min ago
    const windowEnd   = new Date(now.getTime() - 25 * 60 * 1000); // ended 25 min ago

    const activities = await Activity.find({
      endDate:       { $gte: windowStart, $lte: windowEnd },
      followupSentAt: { $exists: false },
      status:         { $in: ['pending', 'in_progress', 'completed'] },
      'linkedPerson.email': { $exists: true, $ne: '' },
    }).lean();

    if (activities.length === 0) return;
    logger.info(`Meeting follow-up check: ${activities.length} activity(ies) ended in window`);

    for (const activity of activities) {
      const lp = activity.linkedPerson;
      if (!lp) continue;

      const subject  = `Thank you for your time — ${activity.title}`;
      const htmlBody = `<p>Hi <strong>${lp.displayName}</strong>,</p><p>Thank you for your time during <strong>${activity.title}</strong>. We hope it was productive!</p><p>If you have any questions or need to follow up, feel free to reach out anytime.</p><p>Best regards,<br/>LeadRyze AI</p>`;
      const smsText  = `Hi ${lp.displayName}, thanks for the meeting! Let us know if you need anything. – LeadRyze AI`;

      const tasks: Promise<unknown>[] = [
        Activity.findByIdAndUpdate(activity._id, { followupSentAt: now }),
      ];

      if (lp.email) {
        tasks.push(
          sendEmailNow({ to: lp.email, toName: lp.displayName, subject, htmlContent: htmlBody }).catch((err: Error) =>
            logger.error('Follow-up email failed', { activityId: String(activity._id), error: err.message })
          )
        );
      }
      if (lp.phone) {
        tasks.push(
          sendSmsNow({ to: lp.phone, body: smsText }).catch((err: Error) =>
            logger.error('Follow-up SMS failed', { activityId: String(activity._id), error: err.message })
          )
        );
      }

      await Promise.all(tasks);
      logger.info('Meeting follow-up sent', { activityId: String(activity._id), title: activity.title, to: lp.email || lp.phone });
    }
  } catch (err) {
    logger.error('Meeting follow-up cron failed', { error: (err as Error).message });
  }
}

// ─── Cron Job Registration ────────────────────────────────────────────────────
function initCronJobs(): void {
  // Sync ALL tenants' CRMs every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    logger.info('Cron triggered: CRM auto-sync (all tenants)');
    await runCRMSyncForAllTenants();
  });

  // Daily 9am follow-up check
  cron.schedule('0 9 * * *', async () => {
    logger.info('Cron triggered: daily follow-up check');
    await runDailyFollowupCheck();
  });

  // Hourly campaign trigger check
  cron.schedule('0 * * * *', async () => {
    logger.info('Cron triggered: campaign schedule check');
    // Campaign logic runs here when BullMQ is available
    if (_bullmqAvailable) {
      const { Campaign } = require('../campaigns/campaign.model');
      const now = new Date();
      const campaigns = await Campaign.find({ status: 'scheduled', 'schedule.startAt': { $lte: now } });
      for (const campaign of campaigns) {
        await Campaign.findByIdAndUpdate(campaign._id, { status: 'active' });
        await emailQueue.add('campaign-send', {
          campaignId: campaign._id.toString(),
          tenantId: campaign.tenantId.toString(),
        });
        logger.info('Campaign triggered', { campaignId: campaign._id });
      }
    }
  });

  // Meeting reminders — every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    await runMeetingReminders();
  });

  // Post-meeting follow-up — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await runMeetingFollowups();
  });

  // Contract → Work Order auto-generator — daily at 6am
  cron.schedule('0 6 * * *', async () => {
    logger.info('Cron triggered: contract work-order scheduler');
    await runContractScheduler();
  });

  logger.info('Cron jobs scheduled: CRM sync (30min), follow-up check (9am daily), campaign check (hourly), meeting reminders (2min), follow-ups (5min), contract WO generator (6am daily)');
}

// ─── Manual trigger helpers ───────────────────────────────────────────────────
export async function triggerCRMSync(): Promise<void> {
  await runCRMSyncForAllTenants();
}

export async function scheduleFollowup(tenantId: string, customerId: string, delayMs: number, action: string): Promise<void> {
  if (_bullmqAvailable) {
    await followupQueue.add('followup', { tenantId, customerId, action }, { delay: delayMs });
  }
}

export async function scheduleEmail(to: string, templateId: string, variables: Record<string, string>, delayMs = 0): Promise<void> {
  if (_bullmqAvailable) {
    await emailQueue.add('send', { to, templateId, variables }, { delay: delayMs });
  }
}

export async function scheduleWhatsApp(to: string, templateName: string, variables: Record<string, string>, delayMs = 0): Promise<void> {
  if (_bullmqAvailable) {
    await whatsappQueue.add('send', { to, templateName, variables }, { delay: delayMs });
  }
}
