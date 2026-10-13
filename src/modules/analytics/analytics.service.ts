import mongoose from 'mongoose';
import { Lead } from '../native-crm/leads/lead.model';
import { Deal } from '../native-crm/deals/deal.model';
import { Contact } from '../native-crm/contacts/contact.model';
import { Company } from '../native-crm/companies/company.model';
import { NativeCustomer } from '../native-crm/customers/customer.model';
import { Ticket } from '../native-crm/tickets/ticket.model';
import { NativeWorkorder } from '../native-crm/workorders/workorder.model';
import { NativeQuotation } from '../native-crm/quotations/quotation.model';
import { NativeInvoice } from '../native-crm/invoices/invoice.model';
import { NativeReceipt } from '../native-crm/receipts/receipt.model';
import { Task } from '../native-crm/tasks/task.model';
import { Meeting } from '../native-crm/meetings/meeting.model';
import { Call } from '../native-crm/calls/call.model';
import { NativeStaff } from '../native-crm/staffs/staff.model';
import { AutomationRule } from '../native-crm/automation-rules/automation-rule.model';
import { AutomationFlow } from '../native-crm/automation-flows/automation-flow.model';
import { AutomationFlowRun } from '../native-crm/automation-flows/automation-flow-run.model';
import { AutomationRun } from '../automation/automation-run.model';
import { Connector } from '../connectors/connector.model';
import { Campaign } from '../campaigns/campaign.model';
import { Analytics } from './analytics.model';

import { DateTime } from 'luxon';

export interface DateRangeFilter {
  preset?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  referenceDate?: string;
}

export interface ParsedDateRange {
  start: Date;
  end: Date;
  startUtc: Date;
  endExclusiveUtc: Date;
  prevStart: Date;
  prevEnd: Date;
  days: number;
  preset: string;
  dateFormat: string;
  intervalType: 'day' | 'month';
  timeZone: string;
  localStartDate: string;
  localEndDate: string;
  localPeriodLabel: string;
  shortPeriodLabel: string;
}

export function normalizeTimezone(tz?: string): string {
  if (!tz) return 'Asia/Kolkata';
  if (tz === 'Asia/Calcutta') return 'Asia/Kolkata';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Kolkata';
  }
}

export function parseDateRange(filter?: DateRangeFilter): ParsedDateRange {
  const timeZone = normalizeTimezone(filter?.timezone);
  const now = filter?.referenceDate
    ? DateTime.fromISO(filter.referenceDate, { zone: timeZone })
    : DateTime.now().setZone(timeZone);

  const rawPreset = (filter?.preset || '').toLowerCase().trim();
  const preset = rawPreset || (filter?.startDate ? 'custom' : 'this_month');

  let startLocal: DateTime;
  let endLocal: DateTime;
  let nextDayExclusive: DateTime;

  // 1. Today: October 9, 2026 only
  if (preset === 'today') {
    startLocal = now.startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // 2. Yesterday: October 8, 2026 only
  else if (preset === 'yesterday') {
    const yest = now.minus({ days: 1 });
    startLocal = yest.startOf('day');
    endLocal = yest.endOf('day');
    nextDayExclusive = yest.plus({ days: 1 }).startOf('day');
  }
  // 3. This Week: rolling seven-day period (October 2 through October 9, 2026, inclusive)
  else if (preset === 'this_week' || preset === 'week' || preset === '7d') {
    startLocal = now.minus({ days: 7 }).startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // 4. This Month: rolling one-month period (September 9 through October 9, 2026, inclusive)
  else if (preset === 'this_month' || preset === 'month' || preset === '30d') {
    startLocal = now.minus({ months: 1 }).startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // 5. Bimonthly: rolling two-month period (August 9 through October 9, 2026, inclusive)
  else if (preset === 'bimonthly' || preset === 'last_2_months' || preset === '60d') {
    startLocal = now.minus({ months: 2 }).startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // 6. Quarterly: rolling three-month period (July 9 through October 9, 2026, inclusive)
  else if (preset === 'quarterly' || preset === 'last_3_months' || preset === '90d' || preset === 'this_quarter') {
    startLocal = now.minus({ months: 3 }).startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // 7. Last 6 Months: rolling six-month period (April 9 through October 9, 2026, inclusive)
  else if (preset === 'last_6_months' || preset === 'last_six_months' || preset === '6m' || preset === '180d') {
    startLocal = now.minus({ months: 6 }).startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // 8. Last 1 Year: rolling one-year period (October 9, 2025 through October 9, 2026, inclusive)
  else if (preset === 'last_1_year' || preset === 'last_year' || preset === '1y' || preset === '365d' || preset === 'this_year') {
    startLocal = now.minus({ years: 1 }).startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // 9. Custom Date: From Date through To Date, both inclusive
  else if (preset === 'custom' && filter?.startDate) {
    let s = DateTime.fromISO(filter.startDate, { zone: timeZone }).startOf('day');
    let e = DateTime.fromISO(filter.endDate || filter.startDate, { zone: timeZone }).endOf('day');
    if (!s.isValid) s = now.minus({ months: 1 }).startOf('day');
    if (!e.isValid) e = now.endOf('day');
    if (s > e) {
      const tmp = s;
      s = e.startOf('day');
      e = tmp.endOf('day');
    }
    startLocal = s;
    endLocal = e;
    nextDayExclusive = e.plus({ days: 1 }).startOf('day');
  }
  // All Time legacy support
  else if (preset === 'all_time') {
    startLocal = DateTime.fromISO('2020-01-01T00:00:00', { zone: timeZone });
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }
  // Default: This Month (rolling one-month period)
  else {
    startLocal = now.minus({ months: 1 }).startOf('day');
    endLocal = now.endOf('day');
    nextDayExclusive = now.plus({ days: 1 }).startOf('day');
  }

  const startUtc = startLocal.toUTC().toJSDate();
  const endExclusiveUtc = nextDayExclusive.toUTC().toJSDate();
  const endInclusiveUtc = endLocal.toUTC().toJSDate();

  const durationMs = Math.max(endExclusiveUtc.getTime() - startUtc.getTime(), 86400000);
  const prevEndExclusiveUtc = new Date(startUtc.getTime());
  const prevStartUtc = new Date(startUtc.getTime() - durationMs);
  const prevEnd = new Date(prevEndExclusiveUtc.getTime() - 1);
  const days = Math.max(1, Math.round(durationMs / 86400000));

  const intervalType: 'day' | 'month' = days > 62 ? 'month' : 'day';
  const dateFormat = intervalType === 'month' ? '%Y-%m' : '%Y-%m-%d';

  const isSameDay = startLocal.hasSame(endLocal, 'day');
  const localPeriodLabel = isSameDay
    ? startLocal.toFormat('LLLL d, yyyy')
    : `${startLocal.toFormat('LLLL d, yyyy')} – ${endLocal.toFormat('LLLL d, yyyy')}`;
  const shortPeriodLabel = isSameDay
    ? startLocal.toFormat('LLL d, yyyy')
    : `${startLocal.toFormat('LLL d, yyyy')} – ${endLocal.toFormat('LLL d, yyyy')}`;

  return {
    start: startUtc,
    end: endInclusiveUtc,
    startUtc,
    endExclusiveUtc,
    prevStart: prevStartUtc,
    prevEnd,
    days,
    preset,
    dateFormat,
    intervalType,
    timeZone,
    localStartDate: startLocal.toFormat('yyyy-MM-dd'),
    localEndDate: endLocal.toFormat('yyyy-MM-dd'),
    localPeriodLabel,
    shortPeriodLabel,
  };
}

export function generateIntervalSlots(range: ParsedDateRange): string[] {
  const slots: string[] = [];
  const timeZone = range.timeZone || 'Asia/Kolkata';

  if (range.intervalType === 'month') {
    let cur = DateTime.fromJSDate(range.startUtc, { zone: timeZone }).startOf('month');
    const end = DateTime.fromJSDate(range.end, { zone: timeZone }).startOf('month');
    while (cur <= end) {
      slots.push(cur.toFormat('yyyy-MM'));
      cur = cur.plus({ months: 1 });
    }
  } else {
    let cur = DateTime.fromJSDate(range.startUtc, { zone: timeZone }).startOf('day');
    const end = DateTime.fromJSDate(range.end, { zone: timeZone }).startOf('day');
    while (cur <= end) {
      slots.push(cur.toFormat('yyyy-MM-dd'));
      cur = cur.plus({ days: 1 });
    }
  }
  return slots;
}

export function getDateMatch(range: ParsedDateRange, dateField = 'createdAt'): Record<string, unknown> {
  if (range.preset === 'all_time') {
    return {};
  }
  return {
    [dateField]: { $gte: range.startUtc, $lt: range.endExclusiveUtc },
  };
}

export function getDateMatchWithFallback(
  range: ParsedDateRange,
  primaryField: string,
  fallbackField = 'createdAt'
): Record<string, unknown> {
  if (range.preset === 'all_time') {
    return {};
  }
  return {
    $or: [
      { [primaryField]: { $gte: range.startUtc, $lt: range.endExclusiveUtc } },
      {
        [primaryField]: { $in: [null, undefined] },
        [fallbackField]: { $gte: range.startUtc, $lt: range.endExclusiveUtc },
      },
    ],
  };
}

function calcChange(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

function buildBaseFilter(tenantId: string, branchId?: string, supportsBranch: boolean = true): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(tenantId),
  };
  if (supportsBranch && branchId && mongoose.isValidObjectId(branchId)) {
    filter.branchId = new mongoose.Types.ObjectId(branchId);
  }
  return filter;
}

export async function getDashboardStats(tenantId: string, branchId?: string, dateFilter?: DateRangeFilter) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const range = parseDateRange(dateFilter);
  const dateMatch = getDateMatch(range);
  const leadBase = buildBaseFilter(tenantId, branchId, true);
  const dealBase = buildBaseFilter(tenantId, branchId, true);
  const ticketBase = buildBaseFilter(tenantId, branchId, true);
  const woBase = buildBaseFilter(tenantId, branchId, true);

  const [
    channelBreakdown,
    dailyRaw,
    prevDailyRaw,
    allLeadsCount,
    newLeadsCurr,
    newLeadsPrev,
    convertedLeadsCurr,
    convertedLeadsPrev,
    dealStats,
    prevDealStats,
    openTicketsCount,
    prevOpenTicketsCount,
    overdueTicketsCount,
    slaBreachTicketsCount,
    totalTicketsCount,
    allTicketsCount,
    resolvedTicketsCount,
    openWOCount,
    completedWOCount,
    customersCount,
    companiesCount,
    contactsCount,
    meetingsUpcomingCount,
    dealTimelineRaw,
    ticketTimelineRaw,
    woTimelineRaw,
    ticketStatusRaw,
    dealStagesRaw,
    automationFlowStats,
  ] = await Promise.all([
    // Channel breakdown (current range)
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    // Daily leads current range
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: range.dateFormat, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Daily leads prev range count
    Lead.countDocuments({ ...leadBase, createdAt: { $gte: range.prevStart, $lte: range.prevEnd } }),
    // Total leads ever
    Lead.countDocuments(leadBase),
    // New leads in period
    Lead.countDocuments({ ...leadBase, ...dateMatch }),
    // New leads in prev period
    Lead.countDocuments({ ...leadBase, createdAt: { $gte: range.prevStart, $lte: range.prevEnd } }),
    // Converted leads in period
    Lead.countDocuments({ ...leadBase, isConverted: true, ...dateMatch }),
    // Converted leads in prev period
    Lead.countDocuments({ ...leadBase, isConverted: true, createdAt: { $gte: range.prevStart, $lte: range.prevEnd } }),
    // Deals aggregation
    Deal.aggregate([
      { $match: { ...dealBase, ...dateMatch } },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          openCount: {
            $sum: {
              $cond: [{ $in: ['$stage', ['won', 'closed_won', 'lost', 'closed_lost']] }, 0, 1],
            },
          },
          openPipelineValue: {
            $sum: {
              $cond: [{ $in: ['$stage', ['won', 'closed_won', 'lost', 'closed_lost']] }, 0, { $ifNull: ['$amount', 0] }],
            },
          },
          wonCount: {
            $sum: {
              $cond: [{ $in: ['$stage', ['won', 'closed_won']] }, 1, 0],
            },
          },
          wonRevenue: {
            $sum: {
              $cond: [{ $in: ['$stage', ['won', 'closed_won']] }, { $ifNull: ['$amount', 0] }, 0],
            },
          },
        },
      },
    ]),
    // Prev deals aggregation
    Deal.aggregate([
      { $match: { ...dealBase, createdAt: { $gte: range.prevStart, $lte: range.prevEnd } } },
      {
        $group: {
          _id: null,
          wonRevenue: {
            $sum: {
              $cond: [{ $in: ['$stage', ['won', 'closed_won']] }, { $ifNull: ['$amount', 0] }, 0],
            },
          },
        },
      },
    ]),
    // Open tickets
    Ticket.countDocuments({ ...ticketBase, ticketStatus: { $nin: ['resolved', 'closed'] }, ...dateMatch }),
    // Prev open tickets
    Ticket.countDocuments({
      ...ticketBase,
      ticketStatus: { $nin: ['resolved', 'closed'] },
      createdAt: { $gte: range.prevStart, $lte: range.prevEnd },
    }),
    // Overdue tickets
    Ticket.countDocuments({
      ...ticketBase,
      ticketStatus: { $nin: ['resolved', 'closed'] },
      resolutionDueAt: { $lt: new Date() },
      ...dateMatch,
    }),
    // SLA Breached tickets
    Promise.all([
      Ticket.countDocuments({
        ...ticketBase,
        ticketStatus: { $nin: ['resolved', 'closed'] },
        resolutionDueAt: { $lt: new Date() },
        ...dateMatch,
      }),
      Ticket.countDocuments({
        ...ticketBase,
        resolvedAt: { $exists: true },
        resolutionDueAt: { $exists: true },
        $expr: { $gt: ['$resolvedAt', '$resolutionDueAt'] },
        ...dateMatch,
      }),
    ]).then(([openBreached, resolvedLate]) => openBreached + resolvedLate),
    // Total tickets in period
    Ticket.countDocuments({ ...ticketBase, ...dateMatch }),
    // All-time total tickets
    Ticket.countDocuments(ticketBase),
    // Resolved or closed tickets in period
    Ticket.countDocuments({ ...ticketBase, ticketStatus: { $in: ['resolved', 'closed'] }, ...dateMatch }),
    // Open work orders
    NativeWorkorder.countDocuments({ ...woBase, status: { $in: ['draft', 'scheduled', 'in_progress'] }, ...dateMatch }),
    // Completed work orders in period
    NativeWorkorder.countDocuments({ ...woBase, status: 'completed', ...getDateMatchWithFallback(range, 'completedDate', 'createdAt') }),
    // Customers count
    NativeCustomer.countDocuments({ ...buildBaseFilter(tenantId, branchId, true), ...dateMatch }),
    // Companies count
    Company.countDocuments({ ...buildBaseFilter(tenantId, branchId, false), ...dateMatch }),
    // Contacts count
    Contact.countDocuments({ ...buildBaseFilter(tenantId, branchId, true), ...dateMatch }),
    // Upcoming meetings
    Meeting.countDocuments({
      tenantId: tid,
      meetingStatus: 'scheduled',
      ...getDateMatchWithFallback(range, 'startDate', 'createdAt'),
    }),
    // Deals timeline
    Deal.aggregate([
      { $match: { ...dealBase, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: range.dateFormat, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
    ]),
    // Tickets timeline
    Ticket.aggregate([
      { $match: { ...ticketBase, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: range.dateFormat, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
    ]),
    // Work orders timeline
    NativeWorkorder.aggregate([
      { $match: { ...woBase, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: range.dateFormat, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
    ]),
    // Ticket status distribution
    Ticket.aggregate([
      { $match: { ...ticketBase, ...dateMatch } },
      { $group: { _id: '$ticketStatus', count: { $sum: 1 } } },
    ]),
    // Deal stages distribution
    Deal.aggregate([
      { $match: { ...dealBase, ...dateMatch } },
      { $group: { _id: '$stage', count: { $sum: 1 }, value: { $sum: { $ifNull: ['$amount', 0] } } } },
    ]),
    // Automation runs summary
    AutomationFlowRun.aggregate([
      { $match: { tenantId: tid, ...dateMatch } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const byChannel = Object.fromEntries(channelBreakdown.map((r) => [r._id || 'unspecified', r.count as number]));

  const currentDeal = dealStats[0] || { totalCount: 0, openCount: 0, openPipelineValue: 0, wonCount: 0, wonRevenue: 0 };
  const prevDeal = prevDealStats[0] || { wonRevenue: 0 };

  const convRateCurr = newLeadsCurr > 0 ? Math.round((convertedLeadsCurr / newLeadsCurr) * 1000) / 10 : null;
  const convRatePrev = newLeadsPrev > 0 ? Math.round((convertedLeadsPrev / newLeadsPrev) * 1000) / 10 : null;

  const autoRuns = automationFlowStats[0] || { total: 0, completed: 0, failed: 0 };
  const autoSuccessRate = autoRuns.total > 0 ? Math.round((autoRuns.completed / autoRuns.total) * 1000) / 10 : null;

  // Build unified continuous date timeline with all interval slots
  const slots = generateIntervalSlots(range);
  const dateMap: Record<string, { date: string; leads: number; deals: number; tickets: number; workOrders: number }> = {};
  slots.forEach((s) => {
    dateMap[s] = { date: s, leads: 0, deals: 0, tickets: 0, workOrders: 0 };
  });

  dailyRaw.forEach((d) => {
    if (!dateMap[d._id]) dateMap[d._id] = { date: d._id, leads: 0, deals: 0, tickets: 0, workOrders: 0 };
    dateMap[d._id].leads = d.count;
  });
  dealTimelineRaw.forEach((d) => {
    if (!dateMap[d._id]) dateMap[d._id] = { date: d._id, leads: 0, deals: 0, tickets: 0, workOrders: 0 };
    dateMap[d._id].deals = d.count;
  });
  ticketTimelineRaw.forEach((d) => {
    if (!dateMap[d._id]) dateMap[d._id] = { date: d._id, leads: 0, deals: 0, tickets: 0, workOrders: 0 };
    dateMap[d._id].tickets = d.count;
  });
  woTimelineRaw.forEach((d) => {
    if (!dateMap[d._id]) dateMap[d._id] = { date: d._id, leads: 0, deals: 0, tickets: 0, workOrders: 0 };
    dateMap[d._id].workOrders = d.count;
  });

  const activityTimeline = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  const dailyLeads = slots.map((s) => ({ date: s, count: dateMap[s]?.leads || 0 }));

  return {
    // Legacy backward-compatibility
    dailyLeads,
    byChannel,

    // Enterprise Overview Metrics
    kpis: {
      totalLeads: {
        value: range.preset === 'all_time' ? allLeadsCount : newLeadsCurr,
        allTime: allLeadsCount,
        newInPeriod: newLeadsCurr,
        change: calcChange(newLeadsCurr, newLeadsPrev),
      },
      conversionRate: {
        value: convRateCurr,
        convertedCount: convertedLeadsCurr,
        totalCount: newLeadsCurr,
        hasData: newLeadsCurr > 0,
        formula: 'Converted Leads / Total New Leads in Period',
        change: convRatePrev !== null && convRateCurr !== null ? calcChange(convRateCurr, convRatePrev) : 0,
      },
      pipelineValue: {
        value: currentDeal.openPipelineValue,
        openDeals: currentDeal.openCount,
      },
      wonRevenue: {
        value: currentDeal.wonRevenue,
        wonDeals: currentDeal.wonCount,
        change: calcChange(currentDeal.wonRevenue, prevDeal.wonRevenue),
      },
      openTickets: {
        value: openTicketsCount,
        open: openTicketsCount,
        totalInPeriod: totalTicketsCount,
        allTime: allTicketsCount,
        resolvedOrClosed: resolvedTicketsCount,
        change: calcChange(openTicketsCount, prevOpenTicketsCount),
      },
      overdueTickets: {
        value: overdueTicketsCount,
        slaBreaches: slaBreachTicketsCount,
      },
      workOrders: {
        open: openWOCount,
        completedInPeriod: completedWOCount,
      },
      crmEntities: {
        customers: customersCount,
        companies: companiesCount,
        contacts: contactsCount,
        upcomingMeetings: meetingsUpcomingCount,
      },
      automation: {
        successRate: autoSuccessRate,
        failures: autoRuns.failed,
        totalRuns: autoRuns.total,
        hasData: autoRuns.total > 0,
      },
    },
    activityTimeline,
    ticketStatusDistribution: Object.fromEntries(ticketStatusRaw.map((r) => [r._id || 'open', r.count])),
    dealsByStage: Object.fromEntries(dealStagesRaw.map((r) => [r._id || 'prospect', { count: r.count, value: r.value }])),
    dateRange: {
      preset: range.preset,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      localStartDate: range.localStartDate,
      localEndDate: range.localEndDate,
      localPeriodLabel: range.localPeriodLabel,
      shortPeriodLabel: range.shortPeriodLabel,
      timeZone: range.timeZone,
      intervalType: range.intervalType,
    },
    lastUpdated: new Date().toISOString(),
  };
}

export async function getLeadsAndSalesAnalytics(tenantId: string, branchId?: string, dateFilter?: DateRangeFilter) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const range = parseDateRange(dateFilter);
  const dateMatch = getDateMatch(range);
  const leadBase = buildBaseFilter(tenantId, branchId, true);
  const dealBase = buildBaseFilter(tenantId, branchId, true);

  const [
    leadsTimeline,
    leadsBySource,
    leadsByStatus,
    leadsByRating,
    leadConversionStats,
    dealPipelineRaw,
    dealsWonLostRaw,
    quotationStats,
    invoiceStats,
    receiptStats,
    topStaffLeads,
  ] = await Promise.all([
    // Lead timeline
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: range.dateFormat, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Leads by source
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    // Leads by status
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    // Leads by rating
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch } },
      { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]),
    // Lead conversion stages for funnel
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          contacted: { $sum: { $cond: [{ $in: ['$status', ['contacted', 'qualified', 'proposal_sent', 'won', 'meeting_scheduled']] }, 1, 0] } },
          qualified: { $sum: { $cond: [{ $in: ['$status', ['qualified', 'proposal_sent', 'won', 'meeting_scheduled']] }, 1, 0] } },
          converted: { $sum: { $cond: ['$isConverted', 1, 0] } },
        },
      },
    ]),
    // Deal pipeline by stage
    Deal.aggregate([
      { $match: { ...dealBase, ...dateMatch } },
      {
        $group: {
          _id: '$stage',
          count: { $sum: 1 },
          totalValue: { $sum: { $ifNull: ['$amount', 0] } },
        },
      },
      { $sort: { totalValue: -1 } },
    ]),
    // Won vs Lost deals
    Deal.aggregate([
      { $match: { ...dealBase, ...dateMatch } },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          wonCount: { $sum: { $cond: [{ $in: ['$stage', ['won', 'closed_won']] }, 1, 0] } },
          wonValue: { $sum: { $cond: [{ $in: ['$stage', ['won', 'closed_won']] }, { $ifNull: ['$amount', 0] }, 0] } },
          lostCount: { $sum: { $cond: [{ $in: ['$stage', ['lost', 'closed_lost']] }, 1, 0] } },
          lostValue: { $sum: { $cond: [{ $in: ['$stage', ['lost', 'closed_lost']] }, { $ifNull: ['$amount', 0] }, 0] } },
          openCount: { $sum: { $cond: [{ $in: ['$stage', ['won', 'closed_won', 'lost', 'closed_lost']] }, 0, 1] } },
          openValue: { $sum: { $cond: [{ $in: ['$stage', ['won', 'closed_won', 'lost', 'closed_lost']] }, 0, { $ifNull: ['$amount', 0] }] } },
        },
      },
    ]),
    // Quotations total
    NativeQuotation.aggregate([
      { $match: { ...buildBaseFilter(tenantId, branchId, true), ...dateMatch } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalQuoted: { $sum: { $ifNull: ['$servicesAmountWithTax', 0] } },
        },
      },
    ]),
    // Invoices total
    NativeInvoice.aggregate([
      { $match: { ...buildBaseFilter(tenantId, branchId, true), ...dateMatch } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalInvoiced: { $sum: { $ifNull: ['$servicesAmountWithTax', 0] } },
          totalPaid: { $sum: { $ifNull: ['$paidAmount', 0] } },
        },
      },
    ]),
    // Receipts total collected
    NativeReceipt.aggregate([
      { $match: { ...buildBaseFilter(tenantId, branchId, true), ...getDateMatchWithFallback(range, 'paymentDate', 'createdAt') } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalCollected: { $sum: { $ifNull: ['$amount', 0] } },
        },
      },
    ]),
    // Top staff assignment
    Lead.aggregate([
      { $match: { ...leadBase, ...dateMatch, leadOwnerStaffId: { $exists: true, $ne: '' } } },
      { $group: { _id: '$leadOwnerStaffId', name: { $first: '$leadOwner' }, leadCount: { $sum: 1 } } },
      { $sort: { leadCount: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const funnelData = leadConversionStats[0] || { total: 0, contacted: 0, qualified: 0, converted: 0 };
  const wonLost = dealsWonLostRaw[0] || { wonCount: 0, wonValue: 0, lostCount: 0, lostValue: 0, openCount: 0, openValue: 0, totalCount: 0 };
  const closedCount = wonLost.wonCount + wonLost.lostCount;
  const winRate = closedCount > 0 ? Math.round((wonLost.wonCount / closedCount) * 1000) / 10 : null;

  const quoteInfo = quotationStats[0] || { count: 0, totalQuoted: 0 };
  const invInfo = invoiceStats[0] || { count: 0, totalInvoiced: 0, totalPaid: 0 };
  const receiptInfo = receiptStats[0] || { count: 0, totalCollected: 0 };

  const slots = generateIntervalSlots(range);
  const leadTimelineMap: Record<string, number> = {};
  slots.forEach((s) => { leadTimelineMap[s] = 0; });
  leadsTimeline.forEach((r) => { leadTimelineMap[r._id] = r.count; });
  const leadVolumeTimeline = slots.map((s) => ({ date: s, count: leadTimelineMap[s] || 0 }));

  return {
    leadVolumeTimeline,
    leadsBySource: Object.fromEntries(leadsBySource.map((r) => [r._id || 'unknown', r.count])),
    leadsByStatus: Object.fromEntries(leadsByStatus.map((r) => [r._id || 'new', r.count])),
    leadsByRating: Object.fromEntries(leadsByRating.map((r) => [r._id || 'unrated', r.count])),
    conversionFunnel: [
      { stage: 'Total Leads', count: funnelData.total },
      { stage: 'Contacted', count: funnelData.contacted },
      { stage: 'Qualified', count: funnelData.qualified },
      { stage: 'Converted to Deal/Customer', count: funnelData.converted },
      { stage: 'Won Deals', count: wonLost.wonCount },
    ],
    dealPipeline: dealPipelineRaw.map((r) => ({ stage: r._id || 'prospect', count: r.count, totalValue: r.totalValue })),
    dealsWonLost: {
      ...wonLost,
      closedCount,
      winRate,
      hasData: closedCount > 0,
      formula: 'Won Deals / Closed Deals (Won + Lost)',
    },
    financialFlow: {
      openPipelineValue: wonLost.openValue,
      totalQuoted: quoteInfo.totalQuoted,
      quotationCount: quoteInfo.count,
      totalInvoiced: invInfo.totalInvoiced,
      invoiceCount: invInfo.count,
      totalCollected: receiptInfo.totalCollected || invInfo.totalPaid,
      receiptCount: receiptInfo.count,
    },
    topStaffPerformance: topStaffLeads.map((r) => ({
      staffId: r._id,
      staffName: r.name || r._id,
      leadCount: r.leadCount,
    })),
    dateRange: {
      preset: range.preset,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      localStartDate: range.localStartDate,
      localEndDate: range.localEndDate,
      localPeriodLabel: range.localPeriodLabel,
      shortPeriodLabel: range.shortPeriodLabel,
      timeZone: range.timeZone,
      intervalType: range.intervalType,
    },
    lastUpdated: new Date().toISOString(),
  };
}

export async function getCrmAnalytics(tenantId: string, branchId?: string, dateFilter?: DateRangeFilter) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const range = parseDateRange(dateFilter);
  const dateMatch = getDateMatch(range);
  const crmBase = buildBaseFilter(tenantId, branchId, true);
  const compBase = buildBaseFilter(tenantId, branchId, false);

  const [
    contactsCount,
    companiesCount,
    customersCount,
    taskStats,
    meetingStats,
    callStats,
    upcomingMeetings,
    recentCallOutcomes,
  ] = await Promise.all([
    Contact.countDocuments({ ...crmBase, ...dateMatch }),
    Company.countDocuments({ ...compBase, ...dateMatch }),
    NativeCustomer.countDocuments({ ...crmBase, ...dateMatch }),
    // Task breakdown
    Task.aggregate([
      { $match: { ...crmBase, ...getDateMatchWithFallback(range, 'dueDate', 'createdAt') } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $in: ['$taskStatus', ['completed', 'done']] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $in: ['$taskStatus', ['completed', 'done']] }, 0, 1] } },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: [{ $in: ['$taskStatus', ['completed', 'done']] }] },
                    { $lt: ['$dueDate', new Date()] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    // Meetings breakdown
    Meeting.aggregate([
      { $match: { ...crmBase, ...getDateMatchWithFallback(range, 'startDate', 'createdAt') } },
      {
        $group: {
          _id: '$meetingStatus',
          count: { $sum: 1 },
        },
      },
    ]),
    // Calls breakdown
    Call.aggregate([
      { $match: { ...crmBase, ...getDateMatchWithFallback(range, 'date', 'createdAt') } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$callStatus', 'completed'] }, 1, 0] } },
          missed: { $sum: { $cond: [{ $eq: ['$callStatus', 'missed'] }, 1, 0] } },
          totalDurationMinutes: { $sum: { $divide: [{ $ifNull: ['$duration', 0] }, 60] } },
        },
      },
    ]),
    // Upcoming meetings list
    Meeting.find({ ...crmBase, meetingStatus: 'scheduled', startDate: { $gte: new Date() }, ...getDateMatchWithFallback(range, 'startDate', 'createdAt') })
      .sort({ startDate: 1 })
      .limit(5)
      .select('title startDate location assignedStaffName')
      .lean(),
    // Call statuses
    Call.aggregate([
      { $match: { ...crmBase, ...getDateMatchWithFallback(range, 'date', 'createdAt') } },
      { $group: { _id: '$callStatus', count: { $sum: 1 } } },
    ]),
  ]);

  const tasks = taskStats[0] || { total: 0, completed: 0, pending: 0, overdue: 0 };
  const calls = callStats[0] || { total: 0, inbound: 0, outbound: 0, completed: 0, missed: 0, totalDurationMinutes: 0 };

  return {
    counts: {
      contacts: contactsCount,
      companies: companiesCount,
      customers: customersCount,
      tasks: tasks.total,
      calls: calls.total,
    },
    tasks: {
      ...tasks,
      completionRate: tasks.total > 0 ? Math.round((tasks.completed / tasks.total) * 1000) / 10 : 0,
    },
    meetings: {
      byStatus: Object.fromEntries(meetingStats.map((r) => [r._id || 'scheduled', r.count])),
      upcoming: upcomingMeetings,
    },
    calls: {
      ...calls,
      totalDurationMinutes: Math.round(calls.totalDurationMinutes),
      byStatus: Object.fromEntries(recentCallOutcomes.map((r) => [r._id || 'planned', r.count])),
    },
    dateRange: {
      preset: range.preset,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      localStartDate: range.localStartDate,
      localEndDate: range.localEndDate,
      localPeriodLabel: range.localPeriodLabel,
      shortPeriodLabel: range.shortPeriodLabel,
      timeZone: range.timeZone,
      intervalType: range.intervalType,
    },
    lastUpdated: new Date().toISOString(),
  };
}

export async function getSupportAnalytics(tenantId: string, branchId?: string, dateFilter?: DateRangeFilter) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const range = parseDateRange(dateFilter);
  const dateMatch = getDateMatch(range);
  const ticketBase = buildBaseFilter(tenantId, branchId, true);
  const now = new Date();

  const [
    ticketCountsRaw,
    priorityBreakdown,
    statusBreakdown,
    ticketsTimeline,
    overdueCount,
    slaBreachCount,
    slaWarningCount,
    agingRaw,
  ] = await Promise.all([
    // Ticket general counts
    Ticket.aggregate([
      { $match: { ...ticketBase, ...dateMatch } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          open: { $sum: { $cond: [{ $in: ['$ticketStatus', ['open', 'new']] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $in: ['$ticketStatus', ['in_progress', 'working', 'pending']] }, 1, 0] } },
          resolved: { $sum: { $cond: [{ $eq: ['$ticketStatus', 'resolved'] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ['$ticketStatus', 'closed'] }, 1, 0] } },
        },
      },
    ]),
    // Tickets by priority
    Ticket.aggregate([
      { $match: { ...ticketBase, ...dateMatch } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]),
    // Tickets by status
    Ticket.aggregate([
      { $match: { ...ticketBase, ...dateMatch } },
      { $group: { _id: '$ticketStatus', count: { $sum: 1 } } },
    ]),
    // Creation & resolution timeline
    Ticket.aggregate([
      { $match: { ...ticketBase, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          created: { $sum: 1 },
          resolved: { $sum: { $cond: [{ $in: ['$ticketStatus', ['resolved', 'closed']] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Overdue tickets
    Ticket.countDocuments({
      ...ticketBase,
      ticketStatus: { $nin: ['resolved', 'closed'] },
      resolutionDueAt: { $lt: now },
      ...dateMatch,
    }),
    // SLA breaches
    Promise.all([
      Ticket.countDocuments({
        ...ticketBase,
        ticketStatus: { $nin: ['resolved', 'closed'] },
        resolutionDueAt: { $lt: now },
        ...dateMatch,
      }),
      Ticket.countDocuments({
        ...ticketBase,
        resolvedAt: { $exists: true },
        resolutionDueAt: { $exists: true },
        $expr: { $gt: ['$resolvedAt', '$resolutionDueAt'] },
        ...dateMatch,
      }),
    ]).then(([openBreached, resolvedLate]) => openBreached + resolvedLate),
    // SLA warnings
    Ticket.countDocuments({
      ...ticketBase,
      ticketStatus: { $nin: ['resolved', 'closed'] },
      resolutionWarningAt: { $lte: now },
      resolutionDueAt: { $gt: now },
      ...dateMatch,
    }),
    // Open tickets aging
    Ticket.find({ ...ticketBase, ticketStatus: { $nin: ['resolved', 'closed'] }, ...dateMatch })
      .select('createdAt')
      .lean(),
  ]);

  const counts = ticketCountsRaw[0] || { total: 0, open: 0, inProgress: 0, resolved: 0, closed: 0 };
  const totalClosedOrResolved = counts.resolved + counts.closed;
  const hasSlaData = counts.total > 0;
  const slaCompliance = hasSlaData ? Math.round(((counts.total - slaBreachCount) / counts.total) * 1000) / 10 : null;

  // Compute aging buckets for open tickets
  const agingBuckets = { '< 24 Hours': 0, '1 - 3 Days': 0, '3 - 7 Days': 0, '> 7 Days': 0 };
  agingRaw.forEach((t) => {
    const ageHours = (now.getTime() - new Date(t.createdAt).getTime()) / 3600000;
    if (ageHours < 24) agingBuckets['< 24 Hours']++;
    else if (ageHours < 72) agingBuckets['1 - 3 Days']++;
    else if (ageHours < 168) agingBuckets['3 - 7 Days']++;
    else agingBuckets['> 7 Days']++;
  });

  return {
    ticketCounts: {
      ...counts,
      overdue: overdueCount,
      slaBreaches: slaBreachCount,
      slaWarnings: slaWarningCount,
      slaComplianceRate: slaCompliance,
      hasSlaData,
    },
    byPriority: Object.fromEntries(priorityBreakdown.map((r) => [r._id || 'medium', r.count])),
    byStatus: Object.fromEntries(statusBreakdown.map((r) => [r._id || 'open', r.count])),
    ticketsTimeline: ticketsTimeline.map((r) => ({ date: r._id, created: r.created, resolved: r.resolved })),
    agingBuckets,
    dateRange: {
      preset: range.preset,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      localStartDate: range.localStartDate,
      localEndDate: range.localEndDate,
      localPeriodLabel: range.localPeriodLabel,
      shortPeriodLabel: range.shortPeriodLabel,
      timeZone: range.timeZone,
      intervalType: range.intervalType,
    },
    lastUpdated: new Date().toISOString(),
  };
}

export async function getFieldServiceAnalytics(tenantId: string, branchId?: string, dateFilter?: DateRangeFilter) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const range = parseDateRange(dateFilter);
  const dateMatch = getDateMatch(range);
  const woBase = buildBaseFilter(tenantId, branchId, true);
  const now = new Date();

  const [
    woCountsRaw,
    priorityBreakdown,
    statusBreakdown,
    woTimeline,
    overdueCount,
    financialSummary,
  ] = await Promise.all([
    // Work order counts
    NativeWorkorder.aggregate([
      { $match: { ...woBase, ...dateMatch } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
          scheduled: { $sum: { $cond: [{ $eq: ['$status', 'scheduled'] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        },
      },
    ]),
    // Work orders by priority
    NativeWorkorder.aggregate([
      { $match: { ...woBase, ...dateMatch } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]),
    // Work orders by status
    NativeWorkorder.aggregate([
      { $match: { ...woBase, ...dateMatch } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    // Work order creation/completion timeline
    NativeWorkorder.aggregate([
      { $match: { ...woBase, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          scheduled: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Overdue work orders
    NativeWorkorder.countDocuments({
      ...woBase,
      status: { $in: ['draft', 'scheduled', 'in_progress'] },
      scheduledDate: { $lt: now },
      ...dateMatch,
    }),
    // Financial flow
    Promise.all([
      NativeQuotation.aggregate([
        { $match: { ...woBase, ...dateMatch } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: { $ifNull: ['$servicesAmountWithTax', 0] } } } },
      ]),
      NativeInvoice.aggregate([
        { $match: { ...woBase, ...dateMatch } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: { $ifNull: ['$servicesAmountWithTax', 0] } }, paid: { $sum: { $ifNull: ['$paidAmount', 0] } } } },
      ]),
      NativeReceipt.aggregate([
        { $match: { ...woBase, ...getDateMatchWithFallback(range, 'paymentDate', 'createdAt') } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: { $ifNull: ['$amount', 0] } } } },
      ]),
    ]),
  ]);

  const counts = woCountsRaw[0] || { total: 0, draft: 0, scheduled: 0, inProgress: 0, completed: 0, cancelled: 0 };
  const completionRate = counts.total > 0 ? Math.round((counts.completed / counts.total) * 1000) / 10 : 0;

  const [quoteAgg, invAgg, recAgg] = financialSummary;
  const quoteTotal = quoteAgg[0]?.total || 0;
  const invTotal = invAgg[0]?.total || 0;
  const collectedTotal = recAgg[0]?.total || invAgg[0]?.paid || 0;

  return {
    workOrderCounts: {
      ...counts,
      overdue: overdueCount,
      completionRate,
      activeJobs: counts.scheduled + counts.inProgress,
    },
    byPriority: Object.fromEntries(priorityBreakdown.map((r) => [r._id || 'medium', r.count])),
    byStatus: Object.fromEntries(statusBreakdown.map((r) => [r._id || 'scheduled', r.count])),
    workOrderTimeline: woTimeline.map((r) => ({ date: r._id, scheduled: r.scheduled, completed: r.completed })),
    financialSummary: {
      totalQuoted: quoteTotal,
      totalInvoiced: invTotal,
      totalCollected: collectedTotal,
    },
    dateRange: {
      preset: range.preset,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      localStartDate: range.localStartDate,
      localEndDate: range.localEndDate,
      localPeriodLabel: range.localPeriodLabel,
      shortPeriodLabel: range.shortPeriodLabel,
      timeZone: range.timeZone,
      intervalType: range.intervalType,
    },
    lastUpdated: new Date().toISOString(),
  };
}

export async function getAutomationAnalytics(tenantId: string, branchId?: string, dateFilter?: DateRangeFilter) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const range = parseDateRange(dateFilter);
  const dateMatch = getDateMatch(range);

  const [
    flowRunsAgg,
    runsTimeline,
    failingFlows,
    rulesCount,
    flowsCount,
    connectorsList,
    campaignsList,
  ] = await Promise.all([
    // Advanced Flow Runs breakdown
    AutomationFlowRun.aggregate([
      { $match: { tenantId: tid, ...dateMatch } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          running: { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
          paused: { $sum: { $cond: [{ $eq: ['$status', 'paused'] }, 1, 0] } },
        },
      },
    ]),
    // Execution timeline
    AutomationFlowRun.aggregate([
      { $match: { tenantId: tid, ...dateMatch } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          success: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Most frequently failing flows
    AutomationFlowRun.aggregate([
      { $match: { tenantId: tid, status: 'failed', ...dateMatch } },
      {
        $group: {
          _id: '$flowName',
          failCount: { $sum: 1 },
          lastError: { $last: '$error' },
        },
      },
      { $sort: { failCount: -1 } },
      { $limit: 5 },
    ]),
    // Rules count
    Promise.all([
      AutomationRule.countDocuments({ tenantId: tid }),
      AutomationRule.countDocuments({ tenantId: tid, enabled: true }),
    ]),
    // Flows count
    Promise.all([
      AutomationFlow.countDocuments({ tenantId: tid }),
      AutomationFlow.countDocuments({ tenantId: tid, enabled: true }),
    ]),
    // Connectors status
    Connector.find({ tenantId: tid })
      .select('name type isActive syncStatus lastSyncAt syncError')
      .lean(),
    // Campaigns status & telemetry
    Campaign.find({ tenantId: tid })
      .select('name channel status stats')
      .lean(),
  ]);

  const flowRuns = flowRunsAgg[0] || { total: 0, completed: 0, failed: 0, running: 0, paused: 0 };
  const failureRate = flowRuns.total > 0 ? Math.round((flowRuns.failed / flowRuns.total) * 1000) / 10 : 0;

  const [totalRules, activeRules] = rulesCount;
  const [totalFlows, activeFlows] = flowsCount;

  const connectorSyncMap: Record<string, number> = {};
  connectorsList.forEach((c) => {
    const s = c.syncStatus || 'idle';
    connectorSyncMap[s] = (connectorSyncMap[s] || 0) + 1;
  });

  const campaignTotals = campaignsList.reduce(
    (acc, curr) => {
      acc.sent += curr.stats?.sent || 0;
      acc.delivered += curr.stats?.delivered || 0;
      acc.opened += curr.stats?.opened || 0;
      acc.clicked += curr.stats?.clicked || 0;
      return acc;
    },
    { sent: 0, delivered: 0, opened: 0, clicked: 0 }
  );

  return {
    runsSummary: {
      ...flowRuns,
      failureRate: flowRuns.total > 0 ? failureRate : null,
      successRate: flowRuns.total > 0 ? Math.round((flowRuns.completed / flowRuns.total) * 1000) / 10 : null,
      hasData: flowRuns.total > 0,
    },
    rulesSummary: {
      totalRules,
      activeRules,
      totalFlows,
      activeFlows,
    },
    executionTimeline: runsTimeline.map((r) => ({ date: r._id, success: r.success, failed: r.failed })),
    failingWorkflows: failingFlows.map((r) => ({ name: r._id || 'Unnamed Workflow', failCount: r.failCount, lastError: r.lastError })),
    connectors: {
      total: connectorsList.length,
      active: connectorsList.filter((c) => c.isActive).length,
      bySyncStatus: connectorSyncMap,
      list: connectorsList,
    },
    campaigns: {
      total: campaignsList.length,
      active: campaignsList.filter((c) => c.status === 'running').length,
      stats: campaignTotals,
    },
    dateRange: {
      preset: range.preset,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      localStartDate: range.localStartDate,
      localEndDate: range.localEndDate,
      localPeriodLabel: range.localPeriodLabel,
      shortPeriodLabel: range.shortPeriodLabel,
      timeZone: range.timeZone,
      intervalType: range.intervalType,
    },
    lastUpdated: new Date().toISOString(),
  };
}

export async function getAnalyticsExport(tenantId: string, branchId?: string, section?: string, dateFilter?: DateRangeFilter): Promise<string> {
  const currentSection = section || 'overview';

  if (currentSection === 'leads' || currentSection === 'sales') {
    const data = await getLeadsAndSalesAnalytics(tenantId, branchId, dateFilter);
    let csv = 'Lead & Sales Analytics Export\n\n';
    csv += 'Metric,Value\n';
    csv += `Win Rate,${data.dealsWonLost.winRate}%\n`;
    csv += `Won Deals Count,${data.dealsWonLost.wonCount}\n`;
    csv += `Won Value,$${data.dealsWonLost.wonValue}\n`;
    csv += `Lost Deals Count,${data.dealsWonLost.lostCount}\n`;
    csv += `Open Pipeline Value,$${data.dealsWonLost.openValue}\n`;
    csv += `Total Quoted,$${data.financialFlow.totalQuoted}\n`;
    csv += `Total Invoiced,$${data.financialFlow.totalInvoiced}\n`;
    csv += `Total Collected,$${data.financialFlow.totalCollected}\n\n`;

    csv += 'Lead Source,Count\n';
    Object.entries(data.leadsBySource).forEach(([src, count]) => {
      csv += `"${src}",${count}\n`;
    });
    csv += '\nDeal Stage,Count,Total Value\n';
    data.dealPipeline.forEach((dp) => {
      csv += `"${dp.stage}",${dp.count},${dp.totalValue}\n`;
    });
    return csv;
  }

  if (currentSection === 'support') {
    const data = await getSupportAnalytics(tenantId, branchId, dateFilter);
    let csv = 'Support & Ticket Analytics Export\n\n';
    csv += 'Metric,Value\n';
    csv += `Total Tickets,${data.ticketCounts.total}\n`;
    csv += `Open Tickets,${data.ticketCounts.open}\n`;
    csv += `In Progress Tickets,${data.ticketCounts.inProgress}\n`;
    csv += `Resolved Tickets,${data.ticketCounts.resolved}\n`;
    csv += `Closed Tickets,${data.ticketCounts.closed}\n`;
    csv += `Overdue Tickets,${data.ticketCounts.overdue}\n`;
    csv += `SLA Breaches,${data.ticketCounts.slaBreaches}\n`;
    csv += `SLA Compliance Rate,${data.ticketCounts.slaComplianceRate}%\n\n`;

    csv += 'Priority,Count\n';
    Object.entries(data.byPriority).forEach(([pri, count]) => {
      csv += `"${pri}",${count}\n`;
    });
    return csv;
  }

  if (currentSection === 'field-service') {
    const data = await getFieldServiceAnalytics(tenantId, branchId, dateFilter);
    let csv = 'Field Service Analytics Export\n\n';
    csv += 'Metric,Value\n';
    csv += `Total Work Orders,${data.workOrderCounts.total}\n`;
    csv += `Scheduled,${data.workOrderCounts.scheduled}\n`;
    csv += `In Progress,${data.workOrderCounts.inProgress}\n`;
    csv += `Completed,${data.workOrderCounts.completed}\n`;
    csv += `Overdue Jobs,${data.workOrderCounts.overdue}\n`;
    csv += `Completion Rate,${data.workOrderCounts.completionRate}%\n`;
    csv += `Total Invoiced,$${data.financialSummary.totalInvoiced}\n`;
    csv += `Total Collected,$${data.financialSummary.totalCollected}\n\n`;

    csv += 'Status,Count\n';
    Object.entries(data.byStatus).forEach(([st, count]) => {
      csv += `"${st}",${count}\n`;
    });
    return csv;
  }

  // Default Overview
  const data = await getDashboardStats(tenantId, branchId, dateFilter);
  let csv = 'Executive Analytics Overview Export\n\n';
  csv += 'KPI Metric,Current Value,Change (%)\n';
  csv += `Total Leads,${data.kpis.totalLeads.value},${data.kpis.totalLeads.change}%\n`;
  csv += `Lead Conversion Rate,${data.kpis.conversionRate.value}%,${data.kpis.conversionRate.change}%\n`;
  csv += `Open Pipeline Value,$${data.kpis.pipelineValue.value},N/A\n`;
  csv += `Won Revenue,$${data.kpis.wonRevenue.value},${data.kpis.wonRevenue.change}%\n`;
  csv += `Open Tickets,${data.kpis.openTickets.value},${data.kpis.openTickets.change}%\n`;
  csv += `Overdue Tickets,${data.kpis.overdueTickets.value},N/A\n`;
  csv += `Open Work Orders,${data.kpis.workOrders.open},N/A\n`;
  csv += `Total Customers,${data.kpis.crmEntities.customers},N/A\n`;
  csv += `Total Contacts,${data.kpis.crmEntities.contacts},N/A\n`;
  csv += `Total Companies,${data.kpis.crmEntities.companies},N/A\n`;
  csv += `Automation Success Rate,${data.kpis.automation.successRate}%,N/A\n\n`;

  csv += 'Daily Activity Timeline (Date, Leads, Deals, Tickets, WorkOrders)\n';
  data.activityTimeline.forEach((t) => {
    csv += `${t.date},${t.leads},${t.deals},${t.tickets},${t.workOrders}\n`;
  });
  return csv;
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
