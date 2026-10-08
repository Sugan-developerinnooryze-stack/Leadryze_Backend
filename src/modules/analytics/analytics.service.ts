import mongoose from 'mongoose';
import { Analytics } from './analytics.model';
import { Lead } from '../native-crm/leads/lead.model';

// LR-REPORT-002: this used to aggregate the AI-widget/chatbot `Customer`
// collection — a separate concept from a tenant's real Leads — so a tenant
// with real native-CRM lead data (and no chatbot customers) saw an
// permanently empty Analytics page. Source of truth is native-crm's own
// Lead model now, and the response shape matches what AnalyticsPage.tsx
// actually reads (`dailyLeads`, `byChannel`), which the old
// `channelBreakdown` array never did even when it had data.
export async function getDashboardStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last30 = new Date(today);
  last30.setDate(last30.getDate() - 30);

  const [channelBreakdown, dailyRaw] = await Promise.all([
    Lead.aggregate([
      { $match: { tenantId: tid, createdAt: { $gte: last30 } } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: { tenantId: tid, createdAt: { $gte: last30 } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const byChannel = Object.fromEntries(channelBreakdown.map((r) => [r._id as string, r.count as number]));
  const dailyLeads = dailyRaw.map((r) => ({ date: r._id as string, count: r.count as number }));

  return { dailyLeads, byChannel };
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
