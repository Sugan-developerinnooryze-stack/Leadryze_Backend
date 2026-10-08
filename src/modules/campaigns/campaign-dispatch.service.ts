import mongoose from 'mongoose';
import { Campaign, ICampaign } from './campaign.model';
import { CampaignRecipient, ICampaignRecipient } from './campaign-recipient.model';
import { Customer, ICustomer } from '../customers/customer.model';
import { getTemplateById, renderTemplate } from '../templates/template.service';
import { writeLog } from '../notifications/email-log.service';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { sendWhatsAppNow } from '../messages/whatsapp.service';
import { logger } from '../../utils/logger';
import { config } from '../../config';

// audience.filter is tenant-authored JSON that has never been executed as a
// live Mongo query before today (it was a Mixed bag nothing read) — allowlist
// a fixed set of Customer fields before it ever reaches a query, so this
// can't become a NoSQL-injection / cross-tenant-read door.
const ALLOWED_FILTER_FIELDS = ['status', 'channel', 'recordType', 'tags', 'source', 'leadSource', 'assignedTo'] as const;

function sanitizeAudienceFilter(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const field of ALLOWED_FILTER_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null && raw[field] !== '') {
      out[field] = raw[field];
    }
  }
  return out;
}

export async function resolveAudience(tenantId: string, audience: ICampaign['audience']): Promise<ICustomer[]> {
  const base = { tenantId: new mongoose.Types.ObjectId(tenantId) };
  if (audience.type === 'manual') {
    const ids = (audience.customerIds ?? []).map((id) => new mongoose.Types.ObjectId(id));
    if (!ids.length) return [];
    return Customer.find({ ...base, _id: { $in: ids } });
  }
  if (audience.type === 'filtered') {
    return Customer.find({ ...base, ...sanitizeAudienceFilter(audience.filter) });
  }
  // 'all_customers' (or unset, for backward compatibility with any
  // pre-existing audience.filter-only campaign) — default to everyone.
  return Customer.find(base);
}

export async function previewAudience(
  tenantId: string,
  audience: ICampaign['audience'],
  channel: 'email' | 'whatsapp' | 'sms'
): Promise<{ count: number; withContact: number; missingContact: number; sample: { name: string; email?: string; phone?: string }[] }> {
  const customers = await resolveAudience(tenantId, audience);
  const contactField = channel === 'email' ? 'email' : 'phone';
  const withContact = customers.filter((c) => !!c[contactField]).length;
  return {
    count: customers.length,
    withContact,
    missingContact: customers.length - withContact,
    sample: customers.slice(0, 10).map((c) => ({ name: c.name, email: c.email, phone: c.phone })),
  };
}

// Resolves the audience EXACTLY ONCE, at activation. Audience changes made
// after this point never retroactively change who gets messaged — matches
// how a real broadcast campaign behaves. Customers missing the channel's
// required contact field get a 'skipped' row instead of being silently
// dropped, so Total/Sent/Skipped reporting stays accurate.
export async function createRecipientsForCampaign(tenantId: string, campaign: ICampaign): Promise<number> {
  const customers = await resolveAudience(tenantId, campaign.audience);
  const contactField = campaign.channel === 'email' ? 'email' : 'phone';
  const tenantObjId = new mongoose.Types.ObjectId(tenantId);

  const rows: Partial<ICampaignRecipient>[] = customers.map((c) => {
    const hasContact = !!c[contactField];
    return {
      tenantId: tenantObjId,
      campaignId: campaign._id as mongoose.Types.ObjectId,
      customerId: c._id as mongoose.Types.ObjectId,
      name: c.name,
      email: c.email,
      phone: c.phone,
      channel: campaign.channel as 'email' | 'whatsapp' | 'sms',
      status: hasContact ? 'pending' : 'skipped',
      errorMessage: hasContact ? undefined : `Customer has no ${contactField} on file`,
    };
  });

  if (!rows.length) return 0;
  await CampaignRecipient.insertMany(rows, { ordered: false });
  await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.total': rows.length } });
  return rows.length;
}

export function renderVariablesForCustomer(customer: ICustomer): Record<string, string> {
  return {
    name: customer.name ?? '',
    firstName: customer.firstName ?? customer.name ?? '',
    lastName: customer.lastName ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    company: customer.company ?? '',
  };
}

async function sendToRecipient(
  tenantId: string,
  recipient: ICampaignRecipient,
  subjectTpl: string | undefined,
  bodyTpl: string,
  channel: 'email' | 'whatsapp' | 'sms'
): Promise<void> {
  const customer = await Customer.findById(recipient.customerId).lean();
  const variables = customer ? renderVariablesForCustomer(customer as unknown as ICustomer) : {};
  const body = renderTemplate(bodyTpl, variables);

  let providerMessageId: string | null = null;
  let errorMessage: string | undefined;

  try {
    if (channel === 'email') {
      const subject = renderTemplate(subjectTpl || '', variables);
      providerMessageId = await sendEmailNow({ to: recipient.email!, toName: recipient.name, subject, htmlContent: body });
    } else if (channel === 'whatsapp') {
      // sendWhatsAppNow never throws — null return means not configured or failed.
      providerMessageId = await sendWhatsAppNow(recipient.phone!, body);
    } else {
      // sendSmsNow never throws — null return means not configured or failed.
      providerMessageId = await sendSmsNow({
        to: recipient.phone!,
        body,
        statusCallbackUrl: `${config.s3.backendUrl}/api/v1/webhooks/twilio/status`,
      });
    }
  } catch (err) {
    // Only sendEmailNow can throw (Brevo API failures) — the other two
    // channels resolve to null instead, so this catch is email-specific.
    errorMessage = (err as Error).message;
  }

  const status: ICampaignRecipient['status'] = providerMessageId ? 'sent' : 'failed';
  const now = new Date();
  await CampaignRecipient.updateOne(
    { _id: recipient._id },
    {
      $set: {
        status,
        providerMessageId: providerMessageId ?? undefined,
        errorMessage: providerMessageId ? undefined : (errorMessage ?? 'Send failed or channel not configured'),
        sentAt: providerMessageId ? now : undefined,
        failedAt: providerMessageId ? undefined : now,
      },
      $inc: { attempts: 1 },
    }
  );
  await Campaign.updateOne(
    { _id: recipient.campaignId },
    { $inc: { [`stats.${status}`]: 1 } }
  );
  await writeLog({
    tenantId,
    channel,
    kind: 'automation',
    sourceModule: 'campaign',
    sourceId: String(recipient.campaignId),
    recipientName: recipient.name,
    recipientEmail: recipient.email,
    recipientPhone: recipient.phone,
    bodyPreview: body,
    status: providerMessageId ? 'sent' : 'failed',
    providerMessageId: providerMessageId ?? undefined,
    errorMessage: providerMessageId ? undefined : errorMessage,
  });
}

// The Pause mechanism's enforcement point: if the campaign isn't 'running'
// any more, this returns immediately without claiming new work. Recipients
// already claimed into 'queued' by an earlier, still-in-flight call to this
// function complete sending regardless — that's the documented Pause
// contract, not a bug.
export async function dispatchCampaignTick(campaignId: string, batchSize = 50): Promise<{ processed: number; done: boolean }> {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign || campaign.status !== 'running') return { processed: 0, done: true };

  const template = campaign.templateId ? await getTemplateById(String(campaign.tenantId), String(campaign.templateId)) : null;
  if (!template) {
    logger.error('dispatchCampaignTick: campaign has no resolvable template', { campaignId });
    await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'failed', lastError: 'Template not found' } });
    return { processed: 0, done: true };
  }

  const toClaim = await CampaignRecipient.find({ campaignId, status: 'pending' }).limit(batchSize).select('_id').lean();
  if (!toClaim.length) {
    const stillPending = await CampaignRecipient.countDocuments({ campaignId, status: { $in: ['pending', 'queued'] } });
    if (stillPending === 0) {
      await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'completed', completedAt: new Date() } });
    }
    return { processed: 0, done: stillPending === 0 };
  }

  const ids = toClaim.map((r) => r._id);
  // Atomic claim: MongoDB re-evaluates {status:'pending'} at write time for
  // EACH matched document, so an overlapping tick's updateMany simply won't
  // match any _id another tick already flipped to 'queued' first — each
  // recipient transitions pending -> queued exactly once even under overlap.
  await CampaignRecipient.updateMany({ _id: { $in: ids }, status: 'pending' }, { $set: { status: 'queued', queuedAt: new Date() } });
  const claimed = await CampaignRecipient.find({ _id: { $in: ids }, status: 'queued' });

  await Promise.all(
    claimed.map((r) => sendToRecipient(String(campaign.tenantId), r, template.subject, template.body, campaign.channel as 'email' | 'whatsapp' | 'sms'))
  );

  return { processed: claimed.length, done: false };
}
