import mongoose from 'mongoose';
import { Campaign, ICampaign } from './campaign.model';
import { CampaignRecipient } from './campaign-recipient.model';
import { getTemplateById, renderTemplate } from '../templates/template.service';
import { Customer } from '../customers/customer.model';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { sendWhatsAppNow } from '../messages/whatsapp.service';
import { previewAudience, createRecipientsForCampaign, dispatchCampaignTick, renderVariablesForCustomer } from './campaign-dispatch.service';
import { Tenant } from '../tenants/tenant.model';
import { config } from '../../config';

export class CampaignActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function loadDraftCampaign(tenantId: string, id: string): Promise<ICampaign> {
  const campaign = await Campaign.findOne({ _id: id, tenantId });
  if (!campaign) throw new CampaignActionError('Campaign not found', 404);
  return campaign;
}

// The idempotency guarantee: only a status:'draft' campaign can ever be
// activated. A double-click or retried request against a campaign that is
// already running/scheduled/completed/cancelled is rejected here — it never
// creates a second recipient batch.
export async function activateCampaign(tenantId: string, id: string): Promise<ICampaign> {
  const campaign = await loadDraftCampaign(tenantId, id);
  if (campaign.status !== 'draft') {
    throw new CampaignActionError(`Campaign cannot be activated from status "${campaign.status}"`, 409);
  }
  if (campaign.channel === 'instagram') {
    throw new CampaignActionError('Instagram campaigns are not yet supported', 400);
  }
  if (!campaign.templateId) {
    throw new CampaignActionError('Select a message template before activating', 400);
  }
  const template = await getTemplateById(tenantId, String(campaign.templateId));
  if (!template) {
    throw new CampaignActionError('Selected template could not be found', 400);
  }
  if (template.type !== campaign.channel) {
    throw new CampaignActionError(`Selected template is for ${template.type}, but this campaign's channel is ${campaign.channel}`, 400);
  }

  const preview = await previewAudience(tenantId, campaign.audience, campaign.channel as 'email' | 'whatsapp' | 'sms');
  if (preview.count === 0) {
    throw new CampaignActionError('No recipients match this campaign\'s audience', 400);
  }

  const recipientCount = await createRecipientsForCampaign(tenantId, campaign);

  const startAt = campaign.schedule?.startAt;
  const sendNow = !startAt || new Date(startAt).getTime() <= Date.now();

  campaign.status = sendNow ? 'running' : 'scheduled';
  campaign.activatedAt = new Date();
  campaign.stats.total = recipientCount;
  await campaign.save();

  if (sendNow) {
    // Fire-and-forget — covers "Send Now" immediately and drives all batches
    // to completion with zero BullMQ dependency. The restart/safety-net cron
    // (campaign-scheduler.service.ts) guarantees forward progress regardless.
    void (async () => {
      try {
        let result = await dispatchCampaignTick(String(campaign._id));
        while (!result.done && result.processed > 0) {
          result = await dispatchCampaignTick(String(campaign._id));
        }
      } catch {
        // logging handled in dispatchCampaignTick
      }
    })();
  }

  return campaign;
}

export async function pauseCampaign(tenantId: string, id: string): Promise<ICampaign> {
  const campaign = await loadDraftCampaign(tenantId, id);
  if (!['running', 'scheduled'].includes(campaign.status)) {
    throw new CampaignActionError(`Campaign cannot be paused from status "${campaign.status}"`, 409);
  }
  campaign.status = 'paused';
  await campaign.save();
  return campaign;
}

export async function resumeCampaign(tenantId: string, id: string): Promise<ICampaign> {
  const campaign = await loadDraftCampaign(tenantId, id);
  if (campaign.status !== 'paused') {
    throw new CampaignActionError(`Campaign cannot be resumed from status "${campaign.status}"`, 409);
  }
  const startAt = campaign.schedule?.startAt;
  const sendNow = !startAt || new Date(startAt).getTime() <= Date.now();
  campaign.status = sendNow ? 'running' : 'scheduled';
  await campaign.save();
  if (sendNow) {
    void (async () => {
      try {
        let result = await dispatchCampaignTick(String(campaign._id));
        while (!result.done && result.processed > 0) {
          result = await dispatchCampaignTick(String(campaign._id));
        }
      } catch {
        // logging handled in dispatchCampaignTick
      }
    })();
  }
  return campaign;
}

export async function cancelCampaign(tenantId: string, id: string): Promise<ICampaign> {
  const campaign = await loadDraftCampaign(tenantId, id);
  if (['completed', 'cancelled', 'failed'].includes(campaign.status)) {
    throw new CampaignActionError(`Campaign cannot be cancelled from status "${campaign.status}"`, 409);
  }
  campaign.status = 'cancelled';
  campaign.cancelledAt = new Date();
  await campaign.save();
  await CampaignRecipient.updateMany(
    { campaignId: campaign._id, status: { $in: ['pending', 'queued'] } },
    { $set: { status: 'skipped', errorMessage: 'Campaign cancelled' } }
  );
  return campaign;
}

export async function duplicateCampaign(tenantId: string, userId: string, id: string): Promise<ICampaign> {
  const original = await loadDraftCampaign(tenantId, id);
  return Campaign.create({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    name: `${original.name} (Copy)`,
    type: original.type,
    channel: original.channel,
    status: 'draft',
    templateId: original.templateId,
    audience: original.audience,
    stats: { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, failed: 0 },
    aiGenerated: false,
    createdBy: new mongoose.Types.ObjectId(userId),
  });
}

// One-off test send — deliberately does NOT create a CampaignRecipient row
// and does NOT touch campaign.stats, so it never pollutes real send counts.
export async function testSendCampaign(tenantId: string, id: string, to: string): Promise<{ sent: boolean }> {
  const campaign = await loadDraftCampaign(tenantId, id);
  if (!campaign.templateId) throw new CampaignActionError('Select a message template first', 400);
  const template = await getTemplateById(tenantId, String(campaign.templateId));
  if (!template) throw new CampaignActionError('Selected template could not be found', 400);

  const tenant = await Tenant.findById(tenantId).select('name branding settings').lean();
  const normalizedTo = to.toLowerCase().trim();
  const matchedCustomer = await Customer.findOne({ tenantId, email: normalizedTo }).lean();

  let recipientName = 'Test Recipient';
  if (matchedCustomer?.name) {
    recipientName = matchedCustomer.name;
  } else if (normalizedTo.includes('@')) {
    const localPart = normalizedTo.split('@')[0].replace(/[._-]/g, ' ').trim();
    if (localPart.length > 1) {
      recipientName = localPart.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  const customerData = matchedCustomer || {
    name: recipientName,
    email: to,
    phone: '+91 98765 43210',
    company: '',
  };

  const variables = renderVariablesForCustomer(customerData as any, tenant);
  const body = renderTemplate(template.body, variables);

  let messageId: string | null = null;
  if (campaign.channel === 'email') {
    const subject = renderTemplate(template.subject || '', variables);
    const senderName = tenant?.branding?.companyName || tenant?.name || config.brevo.senderName;
    const replyTo = tenant?.branding?.contactEmail || undefined;
    try {
      messageId = await sendEmailNow({
        to,
        toName: recipientName,
        senderName,
        replyTo,
        subject,
        htmlContent: body,
      });
    } catch {
      messageId = null;
    }
  } else if (campaign.channel === 'whatsapp') {
    messageId = await sendWhatsAppNow(to, body);
  } else {
    messageId = await sendSmsNow({ to, body });
  }
  return { sent: !!messageId };
}
