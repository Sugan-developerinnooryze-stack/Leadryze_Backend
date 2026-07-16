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
  const { page, limit, sort, order } = parsePagination(query);
  const skip = buildSkip(page, limit);
  const filter: Record<string, unknown> = { tenantId };
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;

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

export async function getCampaignById(tenantId: string, id: string): Promise<ICampaign | null> {
  return Campaign.findOne({ _id: id, tenantId });
}

export async function updateCampaign(
  tenantId: string,
  id: string,
  data: Partial<ICampaign>
): Promise<ICampaign | null> {
  return Campaign.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true });
}

export async function deleteCampaign(tenantId: string, id: string): Promise<void> {
  await Campaign.findOneAndDelete({ _id: id, tenantId });
}
