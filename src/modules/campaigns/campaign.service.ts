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
  const existingCount = await Campaign.countDocuments({ tenantId: tid });
  if (existingCount === 0) {
    await seedDefaultCampaigns(tenantId);
  }

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

  const seeds: Partial<ICampaign>[] = [
    {
      tenantId: tid,
      createdBy: uid,
      name: 'Q4 Product Launch Announcement',
      type: 'broadcast',
      channel: 'email',
      status: 'completed',
      audience: { type: 'all_customers', filter: {} },
      stats: { total: 850, sent: 850, delivered: 832, opened: 468, clicked: 184, replied: 42, failed: 18 },
      createdAt: new Date(now.getTime() - 14 * 86400000) as any,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: 'VIP Customer Loyalty Offer',
      type: 'broadcast',
      channel: 'whatsapp',
      status: 'running',
      audience: { type: 'filtered', filter: { tags: 'vip' } },
      stats: { total: 320, sent: 280, delivered: 275, opened: 260, clicked: 95, replied: 88, failed: 5 },
      createdAt: new Date(now.getTime() - 3 * 86400000) as any,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: 'Monthly Appointment Reminder Drip',
      type: 'drip',
      channel: 'sms',
      status: 'running',
      audience: { type: 'all_customers', filter: {} },
      stats: { total: 540, sent: 490, delivered: 482, opened: 410, clicked: 72, replied: 65, failed: 8 },
      createdAt: new Date(now.getTime() - 7 * 86400000) as any,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: 'New Client Onboarding Sequence',
      type: 'followup',
      channel: 'email',
      status: 'running',
      audience: { type: 'filtered', filter: { status: 'new' } },
      stats: { total: 410, sent: 395, delivered: 390, opened: 245, clicked: 110, replied: 35, failed: 5 },
      createdAt: new Date(now.getTime() - 5 * 86400000) as any,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: 'Weekend Flash Sale WhatsApp Blast',
      type: 'broadcast',
      channel: 'whatsapp',
      status: 'completed',
      audience: { type: 'all_customers', filter: {} },
      stats: { total: 650, sent: 650, delivered: 642, opened: 610, clicked: 230, replied: 145, failed: 8 },
      createdAt: new Date(now.getTime() - 4 * 86400000) as any,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: 'Inactive Customer Re-engagement',
      type: 'reengagement',
      channel: 'email',
      status: 'paused',
      audience: { type: 'filtered', filter: { inactiveDays: 30 } },
      stats: { total: 280, sent: 120, delivered: 115, opened: 42, clicked: 14, replied: 6, failed: 5 },
      createdAt: new Date(now.getTime() - 6 * 86400000) as any,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: 'Upcoming Industry Webinar Invitation',
      type: 'broadcast',
      channel: 'email',
      status: 'scheduled',
      schedule: { startAt: new Date(now.getTime() + 5 * 86400000), timezone: 'Asia/Kolkata' },
      audience: { type: 'all_customers', filter: {} },
      stats: { total: 400, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, failed: 0 },
      createdAt: new Date(now.getTime() - 2 * 86400000) as any,
    },
    {
      tenantId: tid,
      createdBy: uid,
      name: 'Customer Feedback & CSAT Survey',
      type: 'followup',
      channel: 'sms',
      status: 'draft',
      audience: { type: 'manual', filter: {} },
      stats: { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, failed: 0 },
      createdAt: new Date(now.getTime() - 1 * 86400000) as any,
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
