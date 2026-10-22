import mongoose from 'mongoose';
import { Campaign, ICampaign } from './campaign.model';
import { parsePagination, buildSkip } from '../../utils/pagination';

export async function createCampaign(
  tenantId: string,
  userId: string,
  data: Partial<ICampaign>
): Promise<ICampaign> {
  return Campaign.create({
    ...data,
    tenantId: new mongoose.Types.ObjectId(tenantId),
    createdBy: new mongoose.Types.ObjectId(userId),
  });
}

export async function getCampaigns(tenantId: string, query: Record<string, unknown>) {
  const tid = new mongoose.Types.ObjectId(tenantId);

  const { page, limit, sort, order } = parsePagination(query);
  const skip = buildSkip(page, limit);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.channel) filter.channel = query.channel;
  if (query.search) {
    const q = String(query.search).trim();
    filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const [campaigns, total] = await Promise.all([
    Campaign.find(filter)
      .populate('templateId', 'name type')
      .sort({ [sort]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit),
    Campaign.countDocuments(filter),
  ]);
  return { campaigns, total, page, limit };
}

export async function seedDefaultCampaigns(tenantId: string, userId?: string): Promise<{ created: number }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const count = await Campaign.countDocuments({ tenantId: tid });
  if (count > 0) return { created: 0 };

  const uid = userId ? new mongoose.Types.ObjectId(userId) : new mongoose.Types.ObjectId();
  const now = new Date();
  const zeroStats = { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, failed: 0 };

  const seeds: Partial<ICampaign>[] = [
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] Q4 Product Launch Announcement',
      type: 'broadcast',
      channel: 'email',
      status: 'draft',
      audience: { type: 'all_customers', filter: {} },
      stats: zeroStats,
      createdAt: now,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] VIP Customer Loyalty Offer',
      type: 'broadcast',
      channel: 'whatsapp',
      status: 'draft',
      audience: { type: 'filtered', filter: { tags: 'vip' } },
      stats: zeroStats,
      createdAt: now,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] Monthly Appointment Reminder Drip',
      type: 'drip',
      channel: 'sms',
      status: 'draft',
      audience: { type: 'all_customers', filter: {} },
      stats: zeroStats,
      createdAt: now,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] New Client Onboarding Sequence',
      type: 'followup',
      channel: 'email',
      status: 'draft',
      audience: { type: 'filtered', filter: { status: 'new' } },
      stats: zeroStats,
      createdAt: now,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] Weekend Flash Sale WhatsApp Blast',
      type: 'broadcast',
      channel: 'whatsapp',
      status: 'draft',
      audience: { type: 'all_customers', filter: {} },
      stats: zeroStats,
      createdAt: now,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] Inactive Customer Re-engagement',
      type: 'reengagement',
      channel: 'email',
      status: 'draft',
      audience: { type: 'filtered', filter: { inactiveDays: 30 } },
      stats: zeroStats,
      createdAt: now,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] Upcoming Industry Webinar Invitation',
      type: 'broadcast',
      channel: 'email',
      status: 'draft',
      audience: { type: 'all_customers', filter: {} },
      stats: zeroStats,
      createdAt: now,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: '[Sample] Customer Feedback & CSAT Survey',
      type: 'followup',
      channel: 'sms',
      status: 'draft',
      audience: { type: 'manual', filter: {} },
      stats: zeroStats,
      createdAt: now,
    },
  ];

  await Campaign.insertMany(seeds);
  return { created: seeds.length };
}

export async function getCampaignById(tenantId: string, id: string): Promise<ICampaign | null> {
  return Campaign.findOne({ _id: id, tenantId });
}

export class CampaignEditLockedError extends Error {}

// A campaign that has left 'draft' can no longer be edited via this generic
// update — duplicate it instead. This has zero effect on any campaign that
// exists today, since nothing has ever moved a campaign out of 'draft' until
// the send lifecycle shipped; it only starts applying to campaigns activated
// after this point.
export async function updateCampaign(
  tenantId: string,
  id: string,
  data: Partial<ICampaign>
): Promise<ICampaign | null> {
  const existing = await Campaign.findOne({ _id: id, tenantId }).select('status');
  if (!existing) return null;
  if (existing.status !== 'draft') {
    throw new CampaignEditLockedError('Campaign cannot be edited after activation — duplicate it instead.');
  }
  return Campaign.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true });
}

export async function deleteCampaign(tenantId: string, id: string): Promise<void> {
  await Campaign.findOneAndDelete({ _id: id, tenantId });
}
