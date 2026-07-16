import mongoose from 'mongoose';
import { Analytics } from './analytics.model';
import { Customer } from '../customers/customer.model';
import { Message } from '../messages/message.model';

export async function getDashboardStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last30 = new Date(today);
  last30.setDate(last30.getDate() - 30);

  const [customerStats, channelBreakdown, dailyLeads, totalMessages, aiMessages] =
    await Promise.all([
      Customer.aggregate([
        { $match: { tenantId: tid } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Customer.aggregate([
        { $match: { tenantId: tid, createdAt: { $gte: last30 } } },
        { $group: { _id: '$channel', count: { $sum: 1 } } },
      ]),
      Customer.aggregate([
        { $match: { tenantId: tid, createdAt: { $gte: last30 } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Message.countDocuments({ tenantId }),
      Message.countDocuments({ tenantId, aiGenerated: true }),
    ]);

  return {
    customerStats,
    channelBreakdown,
    dailyLeads,
    messages: { total: totalMessages, aiGenerated: aiMessages },
  };
}

export async function getAnalyticsByRange(
  tenantId: string,
  startDate: string,
  endDate: string,
  channel?: string
) {
  const filter: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(tenantId),
    date: { $gte: new Date(startDate), $lte: new Date(endDate) },
  };
  if (channel) filter.channel = channel;
  return Analytics.find(filter).sort({ date: 1 });
}
