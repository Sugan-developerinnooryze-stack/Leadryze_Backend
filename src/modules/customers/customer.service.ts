import mongoose from 'mongoose';
import { Customer, ICustomer } from './customer.model';
import { parsePagination, buildSkip } from '../../utils/pagination';

export async function createCustomer(tenantId: string, data: Partial<ICustomer>): Promise<ICustomer> {
  return Customer.create({ ...data, tenantId: new mongoose.Types.ObjectId(tenantId) });
}

export async function getCustomers(tenantId: string, query: Record<string, unknown>) {
  const { page, limit, sort, order } = parsePagination(query);
  const skip = buildSkip(page, limit);
  const filter: Record<string, unknown> = { tenantId };

  if (query.status) filter.status = query.status;
  if (query.channel) filter.channel = query.channel;
  // channels=zoho,mysql → filter by multiple sources at once
  if (query.channels) {
    const ch = String(query.channels).split(',').map((s) => s.trim()).filter(Boolean);
    if (ch.length > 0) filter.channel = { $in: ch };
  }
  if (query.search) {
    const re = new RegExp(String(query.search), 'i');
    filter.$or = [
      { firstName: re }, { lastName: re }, { email: re }, { phone: re },
    ];
  }

  const [customers, total] = await Promise.all([
    Customer.find(filter)
      .populate('assignedTo', 'firstName lastName email')
      .sort({ [sort]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit),
    Customer.countDocuments(filter),
  ]);
  return { customers, total, page, limit };
}

export async function getCustomerById(tenantId: string, id: string): Promise<ICustomer | null> {
  return Customer.findOne({ _id: id, tenantId });
}

export async function updateCustomer(
  tenantId: string,
  id: string,
  data: Partial<ICustomer>
): Promise<ICustomer | null> {
  return Customer.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: data },
    { new: true, runValidators: true }
  );
}

export async function deleteCustomer(tenantId: string, id: string): Promise<void> {
  await Customer.findOneAndDelete({ _id: id, tenantId });
}

export async function getCustomerStats(tenantId: string, channels?: string[]) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const base: Record<string, unknown> = { tenantId };
  const baseMongo: Record<string, unknown> = { tenantId: tid };
  if (channels && channels.length > 0) {
    base.channel = { $in: channels };
    baseMongo.channel = { $in: channels };
  }

  const [totalCustomers, newToday, booked, channelAgg, statusAgg] = await Promise.all([
    Customer.countDocuments(base),
    Customer.countDocuments({ ...base, createdAt: { $gte: today } }),
    Customer.countDocuments({ ...base, status: 'booked' }),
    Customer.aggregate([
      { $match: baseMongo },
      { $group: { _id: '$channel', count: { $sum: 1 } } },
    ]),
    Customer.aggregate([
      { $match: baseMongo },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const byChannel: Record<string, number> = {};
  channelAgg.forEach((r: { _id: string; count: number }) => { byChannel[r._id] = r.count; });

  const byStatus: Record<string, number> = {};
  statusAgg.forEach((r: { _id: string; count: number }) => { byStatus[r._id] = r.count; });

  const conversionRate = totalCustomers > 0 ? (booked / totalCustomers) * 100 : 0;

  return { totalCustomers, newToday, booked, conversionRate, byChannel, byStatus };
}
