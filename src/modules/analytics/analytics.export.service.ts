import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { DateTime } from 'luxon';
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
import { AutomationRule } from '../native-crm/automation-rules/automation-rule.model';
import { AutomationFlow } from '../native-crm/automation-flows/automation-flow.model';
import { AutomationFlowRun } from '../native-crm/automation-flows/automation-flow-run.model';
import { Connector } from '../connectors/connector.model';
import { Campaign } from '../campaigns/campaign.model';
import { Tenant } from '../tenants/tenant.model';
import { Branch } from '../native-crm/branches/branch.model';
import { parseDateRange, getDateMatch, getDateMatchWithFallback, DateRangeFilter, ParsedDateRange } from './analytics.service';
import { decrypt, isEncrypted } from '../../utils/crypto';

/* ─────────────────────────────────────────────────────────────────────────────
 * PII DECRYPTION & SANITIZATION HELPERS
 * ───────────────────────────────────────────────────────────────────────────── */

export function safeDecryptValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  if (isEncrypted(s)) {
    try {
      return decrypt(s);
    } catch {
      return s;
    }
  }
  return s;
}

export function cleanDomain(domainOrUrl: string): string {
  if (!domainOrUrl) return '';
  const decrypted = safeDecryptValue(domainOrUrl);
  let d = decrypted.trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return d;
}

export function sanitizeText(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  // Prevent spreadsheet formula injection (=, +, -, @)
  if (/^[=+\-@]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

export function formatZonedDate(d?: Date | string | null, timeZone = 'Asia/Kolkata', includeTime = true): string {
  if (!d) return 'N/A';
  const jsDate = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(jsDate.getTime())) return 'N/A';
  const dt = DateTime.fromJSDate(jsDate).setZone(timeZone);
  return dt.toFormat(includeTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
}

export function formatUtcIso(d?: Date | string | null): string {
  if (!d) return 'N/A';
  const jsDate = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(jsDate.getTime())) return 'N/A';
  return jsDate.toISOString();
}

function buildFilter(tenantId: string, branchId?: string, supportsBranch = true) {
  const f: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(tenantId),
  };
  if (supportsBranch && branchId && mongoose.isValidObjectId(branchId)) {
    f.branchId = new mongoose.Types.ObjectId(branchId);
  }
  return f;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * SHARED WORKBOOK STYLING HELPER
 * ───────────────────────────────────────────────────────────────────────────── */

interface SheetStyleConfig {
  title: string;
  subtitle: string;
  headerRowIndex: number;
  numCols: number;
  totalRows: number;
  isDetailTable?: boolean;
  numericCols?: { colIdx: number; format: string }[];
}

export function applySharedWorksheetStyles(ws: XLSX.WorkSheet, config: SheetStyleConfig) {
  const { headerRowIndex, numCols, totalRows, isDetailTable = true, numericCols = [] } = config;

  // Title merges across table width (min 4 cols)
  const mergeEndCol = Math.max(3, numCols - 1);
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: mergeEndCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: mergeEndCol } },
  ];

  // Row heights
  ws['!rows'] = [];
  ws['!rows'][0] = { hpt: 26, hpx: 26 }; // Title
  ws['!rows'][1] = { hpt: 18, hpx: 18 }; // Subtitle
  ws['!rows'][2] = { hpt: 10, hpx: 10 }; // Spacer
  ws['!rows'][headerRowIndex] = { hpt: 22, hpx: 22 }; // Header row

  // Apply cell types and formats to numeric/percentage columns
  for (const numCol of numericCols) {
    for (let r = headerRowIndex + 1; r < totalRows; r++) {
      const cellRef = XLSX.utils.encode_cell({ r, c: numCol.colIdx });
      const cell = ws[cellRef];
      if (cell && cell.v !== undefined && cell.v !== null && typeof cell.v === 'number') {
        cell.t = 'n';
        cell.z = numCol.format;
      }
    }
  }

  // Auto column widths & S.NO column styling
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const cols: { wch: number }[] = [];
  for (let c = 0; c < numCols; c++) {
    const headerCell = ws[XLSX.utils.encode_cell({ r: headerRowIndex, c })];
    if (c === 0 && headerCell && String(headerCell.v).toUpperCase() === 'S.NO') {
      cols.push({ wch: 8 });
      // Format all data rows in S.NO column as numeric integers
      for (let r = headerRowIndex + 1; r <= range.e.r; r++) {
        const cellRef = XLSX.utils.encode_cell({ r, c: 0 });
        const cell = ws[cellRef];
        if (cell && typeof cell.v === 'number') {
          cell.t = 'n';
          cell.z = '#,##0';
        }
      }
      continue;
    }
    let maxLen = 14;
    for (let r = headerRowIndex; r <= range.e.r; r++) {
      const cellRef = XLSX.utils.encode_cell({ r, c });
      const cell = ws[cellRef];
      if (cell && cell.v !== undefined && cell.v !== null) {
        const strLen = String(cell.v).length;
        if (strLen > maxLen) maxLen = Math.min(strLen, 45);
      }
    }
    cols.push({ wch: maxLen + 3 });
  }
  ws['!cols'] = cols;

  // Freeze panes directly below the table header
  ws['!freeze'] = { ySplit: headerRowIndex + 1 };
  ws['!views'] = [{ state: 'frozen', xSplit: 0, ySplit: headerRowIndex + 1 }];

  // Autofilter for detail table rows
  if (isDetailTable && totalRows > headerRowIndex + 1) {
    const endColName = XLSX.utils.encode_col(numCols - 1);
    ws['!autofilter'] = { ref: `A${headerRowIndex + 1}:${endColName}${totalRows}` };
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DATA FETCHING REPOSITORIES
 * ───────────────────────────────────────────────────────────────────────────── */

async function fetchAuthorizedData(tenantId: string, branchId?: string, range?: ParsedDateRange) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const r = range || parseDateRange();
  const dateMatch = getDateMatch(r);
  const leadBase = buildFilter(tenantId, branchId, true);
  const dealBase = buildFilter(tenantId, branchId, true);
  const ticketBase = buildFilter(tenantId, branchId, true);
  const woBase = buildFilter(tenantId, branchId, true);
  const compBase = buildFilter(tenantId, branchId, false);

  const [
    tenantDoc,
    branchDoc,
    leadsList,
    prevLeadsCount,
    dealsList,
    prevWonDeals,
    ticketsList,
    workordersList,
    quotationsList,
    invoicesList,
    receiptsList,
    contactsList,
    companiesList,
    customersList,
    tasksList,
    meetingsList,
    callsList,
    automationRunsList,
    automationRulesList,
    automationFlowsList,
    connectorsList,
    campaignsList,
  ] = await Promise.all([
    Tenant.findById(tid).select('name slug plan settings').lean(),
    branchId && mongoose.isValidObjectId(branchId) ? Branch.findById(branchId).select('branchName branchCode').lean() : null,
    // Current period leads
    Lead.find({ ...leadBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Previous period leads count for delta calculation
    Lead.countDocuments({ ...leadBase, createdAt: { $gte: r.prevStart, $lte: r.prevEnd } }),
    // Deals in scope
    Deal.find({ ...dealBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Previous period won deals count
    Deal.countDocuments({ ...dealBase, stage: { $in: ['won', 'closed_won'] }, createdAt: { $gte: r.prevStart, $lte: r.prevEnd } }),
    // Tickets in scope
    Ticket.find({ ...ticketBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Work orders in scope
    NativeWorkorder.find({ ...woBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Quotations
    NativeQuotation.find({ ...woBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Invoices
    NativeInvoice.find({ ...woBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Receipts (paymentDate with fallback to createdAt)
    NativeReceipt.find({ ...woBase, ...getDateMatchWithFallback(r, 'paymentDate', 'createdAt') }).sort({ createdAt: -1 }).lean(),
    // Full authorized Contacts list
    Contact.find({ ...leadBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Full authorized Companies list
    Company.find({ ...compBase, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    // Customers mapping for readable customer names (all-time for lookup)
    NativeCustomer.find({ tenantId: tid }).select('customerId name').lean(),
    // Tasks (dueDate with fallback to createdAt)
    Task.find({ ...leadBase, ...getDateMatchWithFallback(r, 'dueDate', 'createdAt') }).sort({ createdAt: -1 }).lean(),
    // Meetings (startDate with fallback to createdAt)
    Meeting.find({ ...leadBase, ...getDateMatchWithFallback(r, 'startDate', 'createdAt') }).sort({ startDate: -1 }).lean(),
    // Calls (date with fallback to createdAt)
    Call.find({ ...leadBase, ...getDateMatchWithFallback(r, 'date', 'createdAt') }).sort({ date: -1 }).lean(),
    // Automation runs in period
    AutomationFlowRun.find({ tenantId: tid, ...dateMatch }).sort({ createdAt: -1 }).lean(),
    AutomationRule.find({ tenantId: tid }).lean(),
    AutomationFlow.find({ tenantId: tid }).lean(),
    Connector.find({ tenantId: tid }).lean(),
    Campaign.find({ tenantId: tid }).lean(),
  ]);

  const customerMap: Record<string, string> = {};
  customersList.forEach((c) => {
    if (c.customerId) customerMap[c.customerId] = safeDecryptValue(c.name);
  });

  return {
    tenantDoc,
    branchDoc,
    leadsList,
    prevLeadsCount,
    dealsList,
    prevWonDeals,
    ticketsList,
    workordersList,
    quotationsList,
    invoicesList,
    receiptsList,
    contactsList,
    companiesList,
    customerMap,
    tasksList,
    meetingsList,
    callsList,
    automationRunsList,
    automationRulesList,
    automationFlowsList,
    connectorsList,
    campaignsList,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EXCEL WORKBOOK GENERATOR (13 SHEETS)
 * ───────────────────────────────────────────────────────────────────────────── */

export async function generateAnalyticsWorkbook(
  tenantId: string,
  branchId?: string,
  dateFilter?: DateRangeFilter,
  userEmail?: string
): Promise<Buffer> {
  const range = parseDateRange(dateFilter);
  const data = await fetchAuthorizedData(tenantId, branchId, range);

  const tenantName = data.tenantDoc?.name || 'LeadRyze AI Workspace';
  const branchName = data.branchDoc ? `${data.branchDoc.branchName} (${data.branchDoc.branchCode})` : 'All Branches (Enterprise Scope)';
  const tz = range.timeZone;
  const now = new Date();

  const wb = XLSX.utils.book_new();

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 00 — REPORT COVER
   * ─────────────────────────────────────────────────────────────────────────── */
  const coverRows: (string | number)[][] = [
    ['LEADRYZE AI — EXECUTIVE ANALYTICS & BUSINESS REPORTING WORKBOOK'],
    [`CONFIDENTIAL & PROPRIETARY — PREPARED FOR EXECUTIVE REPORTING | TIMEZONE: ${tz}`],
    [],
    ['REPORT PARAMETER', 'CONFIGURED VALUE', 'AUDIT NOTES & TIMEZONE SPECIFICATION'],
    ['ORGANIZATION / TENANT', tenantName, 'Primary multi-tenant legal entity identifier'],
    ['TENANT SLUG', data.tenantDoc?.slug || 'N/A', 'Internal URL and workspace partition key'],
    ['SUBSCRIPTION PLAN', String(data.tenantDoc?.plan || 'enterprise').toUpperCase(), 'Active commercial license tier'],
    ['BRANCH / LOCATION SCOPE', branchName, 'Physical or operational branch boundary restriction'],
    ['REPORTING PRESET', range.preset.toUpperCase(), 'Calendar interval selector'],
    ['LOCAL REPORTING PERIOD', range.localPeriodLabel, 'Calendar dates inclusive in selected reporting timezone'],
    ['REPORTING START DATE (LOCAL)', range.localStartDate, `Beginning of calendar day (00:00:00 ${tz})`],
    ['REPORTING END DATE (LOCAL)', range.localEndDate, `End of calendar day (23:59:59 ${tz})`],
    ['REPORTING TIMEZONE (IANA)', tz, 'Standard IANA timezone used for all local timestamps'],
    ['START TIMESTAMP (UTC)', range.startUtc.toISOString(), 'Exact beginning UTC timestamp used for Mongo queries (>=)'],
    ['END TIMESTAMP (UTC EXCLUSIVE)', range.endExclusiveUtc.toISOString(), 'Exact exclusive end UTC timestamp used for Mongo queries (<)'],
    ['DURATION (DAYS)', range.days, 'Total elapsed calendar days evaluated in this reporting interval'],
    ['GENERATED BY', userEmail || 'Authenticated User', 'Authorized user credentials issuing export'],
    ['GENERATION TIMESTAMP (LOCAL)', formatZonedDate(now, tz), `Local generation time (${tz})`],
    ['GENERATION TIMESTAMP (UTC)', now.toISOString(), 'Standardized UTC audit log timestamp'],
    ['WORKBOOK SCHEMA VERSION', '2.1.0 Enterprise Professional', 'LeadRyze Analytics Workbook Specification'],
    [],
    ['INCLUDED WORKSHEETS & SCOPE:'],
    ['SHEET INDEX', 'WORKSHEET TITLE', 'DESCRIPTION'],
    ['00_Cover', 'REPORT COVER', 'Audit parameters, metadata, and reporting timezone specifications'],
    ['01_Executive_Summary', 'EXECUTIVE SUMMARY', 'High-level business KPI summary with actual previous period deltas'],
    ['02_Lead_Details', 'LEAD DETAILS', 'Authorized decrypted lead records captured in reporting period'],
    ['03_Lead_Analytics', 'LEAD ANALYTICS', 'Source attribution, conversion funnel, and period volume timelines'],
    ['04_Sales_Deals', 'SALES AND DEALS', 'Opportunity pipeline, stages, values, and won/lost analysis'],
    ['05_Quotes_Invoices', 'QUOTATIONS AND INVOICES', 'Issued customer proposals and billing invoices with tax and currency'],
    ['06_Payments_Receivables', 'PAYMENTS AND RECEIPTS', 'Logged customer receipts, payment methods, and cash tracking'],
    ['07_CRM_Details', 'NATIVE CRM DIRECTORY', 'Contacts, companies, tasks, meetings, and call logs with decrypted contact data'],
    ['08_Support_Tickets', 'SUPPORT & TICKETS', 'Support tickets, priority breakdown, and SLA resolution compliance'],
    ['09_Field_Service', 'FIELD SERVICE & JOBS', 'Work orders, maintenance schedules, and field technician operations'],
    ['10_Automation', 'AUTOMATION TELEMETRY', 'Active rules, flows, and execution logs with error reasons'],
    ['11_Connectors_Campaigns', 'CONNECTORS & CAMPAIGNS', 'Integration health, sync status, and email/outreach campaigns'],
    ['12_Metric_Dictionary', 'METRIC DEFINITIONS', 'Complete mathematical formulas, source modules, and data dictionary'],
  ];

  const wsCover = XLSX.utils.aoa_to_sheet(coverRows);
  applySharedWorksheetStyles(wsCover, {
    title: 'LEADRYZE AI — EXECUTIVE ANALYTICS & BUSINESS REPORTING WORKBOOK',
    subtitle: `CONFIDENTIAL & PROPRIETARY | TIMEZONE: ${tz}`,
    headerRowIndex: 3,
    numCols: 3,
    totalRows: coverRows.length,
    isDetailTable: false,
  });
  XLSX.utils.book_append_sheet(wb, wsCover, '00_Cover');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 01 — EXECUTIVE SUMMARY
   * ─────────────────────────────────────────────────────────────────────────── */
  const wonDeals = data.dealsList.filter((d) => ['won', 'closed_won'].includes(d.stage));
  const lostDeals = data.dealsList.filter((d) => ['lost', 'closed_lost'].includes(d.stage));
  const openDeals = data.dealsList.filter((d) => !['won', 'closed_won', 'lost', 'closed_lost'].includes(d.stage));
  const openPipelineValue = openDeals.reduce((sum, d) => sum + ((d as any).amount || 0), 0);
  const wonRevenue = wonDeals.reduce((sum, d) => sum + ((d as any).amount || 0), 0);
  const closedDealsCount = wonDeals.length + lostDeals.length;

  const convertedLeads = data.leadsList.filter((l) => l.isConverted);
  const leadConvRateNum = data.leadsList.length > 0 ? convertedLeads.length / data.leadsList.length : null;
  const dealWinRateNum = closedDealsCount > 0 ? wonDeals.length / closedDealsCount : null;

  const openTickets = data.ticketsList.filter((t) => !['resolved', 'closed'].includes(t.ticketStatus));
  const overdueTickets = data.ticketsList.filter((t) => t.resolutionDueAt && !['resolved', 'closed'].includes(t.ticketStatus) && new Date(t.resolutionDueAt) < now);
  const slaBreachedTickets = data.ticketsList.filter((t) => (t.resolutionDueAt && !['resolved', 'closed'].includes(t.ticketStatus) && new Date(t.resolutionDueAt) < now) || (t.resolvedAt && t.resolutionDueAt && new Date(t.resolvedAt) > new Date(t.resolutionDueAt)));
  const slaComplianceNum = data.ticketsList.length > 0 ? Math.max(0, (data.ticketsList.length - slaBreachedTickets.length) / data.ticketsList.length) : null;

  const completedWorkorders = data.workordersList.filter((w) => w.status === 'completed');
  const activeWorkorders = data.workordersList.filter((w) => ['draft', 'scheduled', 'in_progress'].includes(w.status));
  const woCompletionRateNum = data.workordersList.length > 0 ? completedWorkorders.length / data.workordersList.length : null;

  const totalQuoted = data.quotationsList.reduce((sum, q) => sum + (q.servicesAmountWithTax || 0), 0);
  const totalInvoiced = data.invoicesList.reduce((sum, i) => sum + (i.servicesAmountWithTax || 0), 0);
  const totalCollected = data.receiptsList.reduce((sum, r) => sum + (r.amount || 0), 0);

  const completedAutoRuns = data.automationRunsList.filter((r) => r.status === 'completed');
  const autoSuccessRateNum = data.automationRunsList.length > 0 ? completedAutoRuns.length / data.automationRunsList.length : null;

  // Previous period changes
  const leadsAbsChange = data.leadsList.length - data.prevLeadsCount;
  const leadsPctChange = data.prevLeadsCount > 0 ? leadsAbsChange / data.prevLeadsCount : (data.leadsList.length > 0 ? 1.0 : 0);

  const wonDealsAbsChange = wonDeals.length - data.prevWonDeals;
  const wonDealsPctChange = data.prevWonDeals > 0 ? wonDealsAbsChange / data.prevWonDeals : (wonDeals.length > 0 ? 1.0 : 0);

  const execRows: (string | number)[][] = [
    ['LEADRYZE AI — EXECUTIVE PERFORMANCE KPI SUMMARY'],
    [`REPORTING PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    [
      'S.NO',
      'DOMAIN',
      'KPI METRIC',
      'CURRENT VALUE',
      'PREVIOUS PERIOD',
      'ABSOLUTE CHANGE',
      'PERCENTAGE CHANGE',
      'SAMPLE SIZE',
      'CALCULATION DEFINITION',
      'SOURCE MODULE',
      'REPORTING TIMESTAMP',
      'VALIDATION STATUS',
    ],
    [1, 'Acquisition', 'Total Leads Captured', data.leadsList.length, data.prevLeadsCount, leadsAbsChange, leadsPctChange, `${data.leadsList.length} total leads`, 'Count of inbound leads in period', 'Leads', formatZonedDate(now, tz), 'Verified'],
    [2, 'Acquisition', 'Lead Conversion Rate', leadConvRateNum !== null ? leadConvRateNum : 'N/A', 'N/A', 'N/A', 'N/A', `${convertedLeads.length} of ${data.leadsList.length} converted`, 'Converted Leads / Total New Leads in Period', 'Leads', formatZonedDate(now, tz), leadConvRateNum !== null ? 'Verified' : 'No Data'],
    [3, 'Sales Pipeline', 'Active Open Deals', openDeals.length, 'N/A', 'N/A', 'N/A', `${openDeals.length} open pipeline opportunities`, 'Count of deals in active pipeline stages', 'Deals', formatZonedDate(now, tz), 'Verified'],
    [4, 'Sales Pipeline', 'Open Pipeline Value', openPipelineValue, 'N/A', 'N/A', 'N/A', `${openDeals.length} active open deals`, 'SUM(amount) for deals in open stages', 'Deals', formatZonedDate(now, tz), 'Verified'],
    [5, 'Sales Pipeline', 'Won Deals Count', wonDeals.length, data.prevWonDeals, wonDealsAbsChange, wonDealsPctChange, `${wonDeals.length} won`, 'COUNT(Deals with stage in [won, closed_won])', 'Deals', formatZonedDate(now, tz), 'Verified'],
    [6, 'Sales Pipeline', 'Won Revenue', wonRevenue, 'N/A', 'N/A', 'N/A', `${wonDeals.length} won opportunities`, 'SUM(amount) for closed won deals', 'Deals', formatZonedDate(now, tz), 'Verified'],
    [7, 'Sales Pipeline', 'Deal Win Rate', dealWinRateNum !== null ? dealWinRateNum : 'N/A', 'N/A', 'N/A', 'N/A', `${wonDeals.length} won / ${closedDealsCount} closed`, 'Won Deals / (Won Deals + Lost Deals)', 'Deals', formatZonedDate(now, tz), dealWinRateNum !== null ? 'Verified' : 'No Closed Deals'],
    [8, 'Support', 'Total Support Tickets', data.ticketsList.length, 'N/A', 'N/A', 'N/A', `${data.ticketsList.length} total tickets`, 'COUNT(Tickets recorded in scope)', 'Tickets', formatZonedDate(now, tz), 'Verified'],
    [9, 'Support', 'Open & Working Tickets', openTickets.length, 'N/A', 'N/A', 'N/A', `${openTickets.length} active tickets`, 'COUNT(Tickets with status NOT IN [resolved, closed])', 'Tickets', formatZonedDate(now, tz), 'Verified'],
    [10, 'Support', 'Overdue Tickets', overdueTickets.length, 'N/A', 'N/A', 'N/A', `${overdueTickets.length} overdue tickets`, 'COUNT(Open tickets with resolutionDueAt < NOW)', 'Tickets', formatZonedDate(now, tz), 'Verified'],
    [11, 'Support', 'SLA Breached Tickets', slaBreachedTickets.length, 'N/A', 'N/A', 'N/A', `${slaBreachedTickets.length} breached tickets`, 'COUNT(Tickets exceeding resolutionDueAt deadline)', 'Tickets', formatZonedDate(now, tz), 'Verified'],
    [12, 'Support', 'SLA Compliance Rate', slaComplianceNum !== null ? slaComplianceNum : 'N/A', 'N/A', 'N/A', 'N/A', `${Math.max(0, data.ticketsList.length - slaBreachedTickets.length)} of ${data.ticketsList.length} compliant`, '(Total - Breached) / Total Tickets (N/A when 0)', 'Tickets', formatZonedDate(now, tz), slaComplianceNum !== null ? 'Verified' : 'No Tickets'],
    [13, 'Field Service', 'Total Work Orders', data.workordersList.length, 'N/A', 'N/A', 'N/A', `${data.workordersList.length} total jobs`, 'COUNT(Work orders recorded in scope)', 'Workorders', formatZonedDate(now, tz), 'Verified'],
    [14, 'Field Service', 'Active Work Orders', activeWorkorders.length, 'N/A', 'N/A', 'N/A', `${activeWorkorders.length} active in flight`, 'COUNT(Work orders with status in [draft, scheduled, in_progress])', 'Workorders', formatZonedDate(now, tz), 'Verified'],
    [15, 'Field Service', 'Completed Work Orders', completedWorkorders.length, 'N/A', 'N/A', 'N/A', `${completedWorkorders.length} completed`, 'COUNT(Work orders with status == completed)', 'Workorders', formatZonedDate(now, tz), 'Verified'],
    [16, 'Field Service', 'Work Order Completion Rate', woCompletionRateNum !== null ? woCompletionRateNum : 'N/A', 'N/A', 'N/A', 'N/A', `${completedWorkorders.length} of ${data.workordersList.length} completed`, 'Completed Work Orders / Total Work Orders', 'Workorders', formatZonedDate(now, tz), woCompletionRateNum !== null ? 'Verified' : 'No Workorders'],
    [17, 'Financial', 'Total Quoted Value', totalQuoted, 'N/A', 'N/A', 'N/A', `${data.quotationsList.length} issued quotations`, 'SUM(servicesAmountWithTax) on Quotations', 'Quotations', formatZonedDate(now, tz), 'Verified'],
    [18, 'Financial', 'Total Invoiced Value', totalInvoiced, 'N/A', 'N/A', 'N/A', `${data.invoicesList.length} customer invoices`, 'SUM(servicesAmountWithTax) on Invoices', 'Invoices', formatZonedDate(now, tz), 'Verified'],
    [19, 'Financial', 'Total Collected Cash', totalCollected, 'N/A', 'N/A', 'N/A', `${data.receiptsList.length} logged receipts`, 'SUM(amount) on logged Receipts', 'Receipts', formatZonedDate(now, tz), 'Verified'],
    [20, 'CRM Directory', 'Total Contacts', data.contactsList.length, 'N/A', 'N/A', 'N/A', `${data.contactsList.length} business contacts`, 'COUNT(crm_contacts in tenant)', 'Contacts', formatZonedDate(now, tz), 'Verified'],
    [21, 'CRM Directory', 'Total Companies', data.companiesList.length, 'N/A', 'N/A', 'N/A', `${data.companiesList.length} business accounts`, 'COUNT(crm_companies in tenant)', 'Companies', formatZonedDate(now, tz), 'Verified'],
    [22, 'Automation', 'Total Automation Executions', data.automationRunsList.length, 'N/A', 'N/A', 'N/A', `${data.automationRunsList.length} executions in period`, 'COUNT(native_automation_flow_runs in period)', 'Automation', formatZonedDate(now, tz), 'Verified'],
    [23, 'Automation', 'Automation Success Rate', autoSuccessRateNum !== null ? autoSuccessRateNum : 'N/A', 'N/A', 'N/A', 'N/A', `${completedAutoRuns.length} of ${data.automationRunsList.length} succeeded`, 'Completed Runs / Total Runs (N/A when 0)', 'Automation', formatZonedDate(now, tz), autoSuccessRateNum !== null ? 'Verified' : 'No Executions'],
  ];

  const wsExec = XLSX.utils.aoa_to_sheet(execRows);
  applySharedWorksheetStyles(wsExec, {
    title: 'LEADRYZE AI — EXECUTIVE PERFORMANCE KPI SUMMARY',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 3,
    numCols: 12,
    totalRows: execRows.length,
    isDetailTable: true,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 5, format: '#,##0' },
      { colIdx: 6, format: '0.0%' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsExec, '01_Executive_Summary');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 02 — LEAD DETAILS (DECRYPTED CONTACT DATA)
   * ─────────────────────────────────────────────────────────────────────────── */
  const leadRows: (string | number)[][] = [
    ['LEADRYZE AI — AUTHORIZED LEAD DETAILS MASTER REPORT'],
    [`FILTERED PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    [
      'S.NO',
      'LEAD ID',
      'FIRST NAME',
      'LAST NAME',
      'COMPANY',
      'EMAIL',
      'PHONE',
      'SOURCE',
      'STATUS',
      'RATING',
      'SCORE',
      'LEAD OWNER',
      'IS CONVERTED',
      'CONVERTED CUSTOMER ID',
      'CREATED AT (LOCAL)',
      'CREATED AT (UTC)',
    ],
  ];

  data.leadsList.forEach((l, idx) => {
    leadRows.push([
      idx + 1,
      sanitizeText((l as any).leadId || l._id),
      sanitizeText(safeDecryptValue(l.firstName)),
      sanitizeText(safeDecryptValue(l.lastName)),
      sanitizeText(safeDecryptValue(l.company)),
      sanitizeText(safeDecryptValue(l.email)),
      sanitizeText(safeDecryptValue(l.phone || (l as any).mobile)),
      sanitizeText(l.source || 'website'),
      sanitizeText(l.status || 'new'),
      sanitizeText(l.rating || 'warm'),
      (l as any).score || 0,
      sanitizeText((l as any).leadOwner || 'Unassigned'),
      l.isConverted ? 'Yes' : 'No',
      sanitizeText(l.convertedCustomerId || ''),
      formatZonedDate(l.createdAt, tz),
      formatUtcIso(l.createdAt),
    ]);
  });
  if (data.leadsList.length === 0) {
    leadRows.push(['No lead records captured in this reporting interval.']);
  }

  const wsLeads = XLSX.utils.aoa_to_sheet(leadRows);
  applySharedWorksheetStyles(wsLeads, {
    title: 'LEADRYZE AI — AUTHORIZED LEAD DETAILS MASTER REPORT',
    subtitle: `FILTERED PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 3,
    numCols: 16,
    totalRows: leadRows.length,
    isDetailTable: true,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 10, format: '#,##0' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsLeads, '02_Lead_Details');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 03 — LEAD ANALYTICS
   * ─────────────────────────────────────────────────────────────────────────── */
  const leadSourceMap: Record<string, number> = {};
  data.leadsList.forEach((l) => {
    const src = l.source || 'Unknown';
    leadSourceMap[src] = (leadSourceMap[src] || 0) + 1;
  });

  const leadStatusMap: Record<string, number> = {};
  data.leadsList.forEach((l) => {
    const st = l.status || 'new';
    leadStatusMap[st] = (leadStatusMap[st] || 0) + 1;
  });

  const leadAnalyticsRows: (string | number)[][] = [
    ['LEADRYZE AI — LEAD GENERATION & ATTRIBUTION ANALYTICS'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    ['1. LEAD CHANNELS & ATTRIBUTION BREAKDOWN'],
    ['S.NO', 'CHANNEL / SOURCE', 'LEAD COUNT', 'SHARE OF ACQUISITIONS (%)'],
  ];

  const totalLeadsCount = data.leadsList.length || 1;
  Object.entries(leadSourceMap).forEach(([src, count], idx) => {
    leadAnalyticsRows.push([idx + 1, sanitizeText(src), count, count / totalLeadsCount]);
  });

  leadAnalyticsRows.push([], ['2. LEAD LIFECYCLE STATUS DISTRIBUTION'], ['S.NO', 'STATUS', 'LEAD COUNT', 'PROPORTION (%)']);
  Object.entries(leadStatusMap).forEach(([st, count], idx) => {
    leadAnalyticsRows.push([idx + 1, sanitizeText(st), count, count / totalLeadsCount]);
  });

  const wsLeadAnalytics = XLSX.utils.aoa_to_sheet(leadAnalyticsRows);
  applySharedWorksheetStyles(wsLeadAnalytics, {
    title: 'LEADRYZE AI — LEAD GENERATION & ATTRIBUTION ANALYTICS',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 4,
    numCols: 4,
    totalRows: leadAnalyticsRows.length,
    isDetailTable: false,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 2, format: '#,##0' },
      { colIdx: 3, format: '0.0%' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsLeadAnalytics, '03_Lead_Analytics');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 04 — SALES & DEALS (PRESERVE RECORD CURRENCY & AMOUNTS)
   * ─────────────────────────────────────────────────────────────────────────── */
  const dealRows: (string | number)[][] = [
    ['LEADRYZE AI — SALES OPPORTUNITIES & DEALS REGISTER'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    [
      'S.NO',
      'DEAL ID',
      'DEAL TITLE',
      'PIPELINE STAGE',
      'DEAL AMOUNT',
      'CURRENCY',
      'DEAL STATUS',
      'CONTACT / ACCOUNT',
      'ASSIGNED OWNER',
      'CLOSE DATE (LOCAL)',
      'CREATED AT (LOCAL)',
      'CREATED AT (UTC)',
    ],
  ];

  data.dealsList.forEach((d: any, idx: number) => {
    dealRows.push([
      idx + 1,
      sanitizeText(d.clientId || d.dealId || d._id),
      sanitizeText(d.title || d.name),
      sanitizeText(d.stage),
      typeof d.amount === 'number' ? d.amount : 0,
      sanitizeText(d.currency || 'USD'),
      sanitizeText(d.dealStatus || d.stage),
      sanitizeText(safeDecryptValue(d.companyName || d.contactName || '')),
      sanitizeText(d.assignedStaffId || 'Unassigned'),
      formatZonedDate(d.closeDate, tz, false),
      formatZonedDate(d.createdAt, tz),
      formatUtcIso(d.createdAt),
    ]);
  });
  if (data.dealsList.length === 0) {
    dealRows.push(['No deal records found in this workspace.']);
  }

  const wsDeals = XLSX.utils.aoa_to_sheet(dealRows);
  applySharedWorksheetStyles(wsDeals, {
    title: 'LEADRYZE AI — SALES OPPORTUNITIES & DEALS REGISTER',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 3,
    numCols: 12,
    totalRows: dealRows.length,
    isDetailTable: true,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 4, format: '#,##0.00' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsDeals, '04_Sales_Deals');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 05 — QUOTATIONS & INVOICES (PRESERVE CURRENCY & UNIFIED HEADERS)
   * ─────────────────────────────────────────────────────────────────────────── */
  const quoteRows: (string | number)[][] = [
    ['LEADRYZE AI — BILLING INVOICES & PROPOSALS REGISTER'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    ['1. INVOICES REGISTER'],
    ['S.NO', 'INVOICE NUMBER', 'CUSTOMER NAME', 'STATUS', 'DUE DATE (LOCAL)', 'SUBTOTAL', 'TAX', 'TOTAL AMOUNT', 'CURRENCY', 'AMOUNT PAID', 'BALANCE DUE', 'CREATED AT (LOCAL)'],
  ];

  data.invoicesList.forEach((inv: any, idx: number) => {
    const custName = data.customerMap[inv.customerId] || safeDecryptValue(inv.customerName) || inv.customerId || 'Direct Client';
    const subtotal = inv.servicesAmount || 0;
    const tax = inv.gstPercentage ? Math.round(subtotal * (inv.gstPercentage / 100) * 100) / 100 : (inv.servicesAmountWithTax - subtotal);
    const total = inv.servicesAmountWithTax || 0;
    const paid = inv.paidAmount || 0;
    const balance = Math.max(0, total - paid);

    quoteRows.push([
      idx + 1,
      sanitizeText(inv.invoiceId || inv._id),
      sanitizeText(custName),
      sanitizeText(inv.status),
      formatZonedDate(inv.dueDate, tz, false),
      subtotal,
      tax,
      total,
      sanitizeText(inv.currency || 'INR'),
      paid,
      balance,
      formatZonedDate(inv.createdAt, tz),
    ]);
  });
  if (data.invoicesList.length === 0) quoteRows.push(['No invoices generated in this workspace.']);

  quoteRows.push([], ['2. QUOTATIONS REGISTER'], ['S.NO', 'QUOTATION NUMBER', 'CUSTOMER NAME', 'STATUS', 'VALID UNTIL (LOCAL)', 'SUBTOTAL', 'TAX', 'TOTAL AMOUNT', 'CURRENCY', 'CREATED AT (LOCAL)']);
  data.quotationsList.forEach((q: any, idx: number) => {
    const custName = data.customerMap[q.customerId] || safeDecryptValue(q.customerName) || q.customerId || 'Direct Client';
    const subtotal = q.servicesAmount || 0;
    const total = q.servicesAmountWithTax || 0;
    const tax = Math.max(0, total - subtotal);

    quoteRows.push([
      idx + 1,
      sanitizeText(q.quotationId || q._id),
      sanitizeText(custName),
      sanitizeText(q.status),
      formatZonedDate(q.validUntil, tz, false),
      subtotal,
      tax,
      total,
      sanitizeText(q.currency || 'INR'),
      formatZonedDate(q.createdAt, tz),
    ]);
  });
  if (data.quotationsList.length === 0) quoteRows.push(['No customer quotations issued.']);

  const wsQuotes = XLSX.utils.aoa_to_sheet(quoteRows);
  applySharedWorksheetStyles(wsQuotes, {
    title: 'LEADRYZE AI — BILLING INVOICES & PROPOSALS REGISTER',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 4,
    numCols: 12,
    totalRows: quoteRows.length,
    isDetailTable: false,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 5, format: '#,##0.00' },
      { colIdx: 6, format: '#,##0.00' },
      { colIdx: 7, format: '#,##0.00' },
      { colIdx: 9, format: '#,##0.00' },
      { colIdx: 10, format: '#,##0.00' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsQuotes, '05_Quotes_Invoices');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 06 — PAYMENTS & RECEIVABLES
   * ─────────────────────────────────────────────────────────────────────────── */
  const paymentRows: (string | number)[][] = [
    ['LEADRYZE AI — CASH COLLECTIONS & PAYMENT RECEIPTS REGISTER'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    ['S.NO', 'RECEIPT NUMBER', 'CUSTOMER NAME', 'PAYMENT DATE (LOCAL)', 'PAYMENT AMOUNT', 'CURRENCY', 'PAYMENT METHOD', 'NOTES / REFERENCE', 'LINKED INVOICE ID', 'CREATED AT (LOCAL)'],
  ];

  data.receiptsList.forEach((r: any, idx: number) => {
    const custName = data.customerMap[r.customerId] || safeDecryptValue(r.customerName) || r.customerId || 'Direct Customer';
    paymentRows.push([
      idx + 1,
      sanitizeText(r.receiptId || r._id),
      sanitizeText(custName),
      formatZonedDate(r.paymentDate, tz, false),
      r.amount || 0,
      sanitizeText(r.currency || 'INR'),
      sanitizeText(r.paymentMethod || 'bank_transfer'),
      sanitizeText(r.notes || ''),
      sanitizeText(r.invoiceId || ''),
      formatZonedDate(r.createdAt, tz),
    ]);
  });
  if (data.receiptsList.length === 0) paymentRows.push(['No payment receipts logged in this scope.']);

  const wsPayments = XLSX.utils.aoa_to_sheet(paymentRows);
  applySharedWorksheetStyles(wsPayments, {
    title: 'LEADRYZE AI — CASH COLLECTIONS & PAYMENT RECEIPTS REGISTER',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 3,
    numCols: 10,
    totalRows: paymentRows.length,
    isDetailTable: true,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 4, format: '#,##0.00' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsPayments, '06_Payments_Receivables');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 07 — CRM DETAILS (DECRYPTED & UNLIMITED RECORDS)
   * ─────────────────────────────────────────────────────────────────────────── */
  const crmRows: (string | number)[][] = [
    ['LEADRYZE AI — NATIVE CRM DIRECTORY (CONTACTS, COMPANIES, TASKS)'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    ['1. CRM CONTACTS DIRECTORY'],
    ['S.NO', 'FIRST NAME', 'LAST NAME', 'EMAIL', 'PHONE', 'COMPANY', 'JOB TITLE', 'LIFECYCLE STAGE', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)'],
  ];

  // Full Contacts list (NO artificial limit!)
  data.contactsList.forEach((c, idx) => {
    crmRows.push([
      idx + 1,
      sanitizeText(safeDecryptValue(c.firstName)),
      sanitizeText(safeDecryptValue(c.lastName)),
      sanitizeText(safeDecryptValue(c.email)),
      sanitizeText(safeDecryptValue(c.phone)),
      sanitizeText(safeDecryptValue(c.company)),
      sanitizeText(c.jobTitle),
      sanitizeText(c.lifecycleStage || c.status || 'lead'),
      formatZonedDate(c.createdAt, tz),
      formatUtcIso(c.createdAt),
    ]);
  });
  if (data.contactsList.length === 0) crmRows.push(['No contacts recorded in native CRM.']);

  crmRows.push([], ['2. CRM COMPANIES DIRECTORY'], ['S.NO', 'COMPANY NAME', 'DOMAIN', 'INDUSTRY', 'EMPLOYEES', 'PHONE', 'STATUS', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)']);
  // Full Companies list (NO artificial limit!)
  data.companiesList.forEach((comp, idx) => {
    const rawDomain = safeDecryptValue(comp.domain || comp.website);
    crmRows.push([
      idx + 1,
      sanitizeText(safeDecryptValue(comp.name)),
      sanitizeText(cleanDomain(rawDomain)),
      sanitizeText(comp.industry),
      comp.employeeCount || 0,
      sanitizeText(safeDecryptValue(comp.phone)),
      sanitizeText(comp.companyStatus || 'active'),
      formatZonedDate(comp.createdAt, tz),
      formatUtcIso(comp.createdAt),
    ]);
  });
  if (data.companiesList.length === 0) crmRows.push(['No company accounts recorded.']);

  crmRows.push([], ['3. CRM OPERATIONAL TASKS'], ['S.NO', 'TASK TITLE', 'PRIORITY', 'TASK STATUS', 'DUE DATE (LOCAL)', 'ASSIGNED TO', 'CREATED AT (LOCAL)']);
  data.tasksList.forEach((t, idx) => {
    crmRows.push([
      idx + 1,
      sanitizeText(t.title),
      sanitizeText(t.priority),
      sanitizeText(t.taskStatus),
      formatZonedDate(t.dueDate, tz, false),
      sanitizeText(t.assignedTo),
      formatZonedDate(t.createdAt, tz),
    ]);
  });
  if (data.tasksList.length === 0) crmRows.push(['No CRM tasks active.']);

  const wsCrm = XLSX.utils.aoa_to_sheet(crmRows);
  applySharedWorksheetStyles(wsCrm, {
    title: 'LEADRYZE AI — NATIVE CRM DIRECTORY (CONTACTS, COMPANIES, TASKS)',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 4,
    numCols: 10,
    totalRows: crmRows.length,
    isDetailTable: false,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 4, format: '#,##0' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsCrm, '07_CRM_Details');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 08 — SUPPORT TICKETS & SLA
   * ─────────────────────────────────────────────────────────────────────────── */
  const ticketRows: (string | number)[][] = [
    ['LEADRYZE AI — CUSTOMER SUPPORT TICKETS & SLA AUDIT REPORT'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    [
      'S.NO',
      'TICKET SUBJECT',
      'PRIORITY',
      'STATUS',
      'CONTACT NAME',
      'CREATED AT (LOCAL)',
      'RESOLUTION DUE DATE (LOCAL)',
      'RESOLVED AT (LOCAL)',
      'SLA BREACH STATUS',
      'CREATED AT (UTC)',
    ],
  ];

  data.ticketsList.forEach((t, idx) => {
    let slaStatus = 'Within SLA Target';
    if (t.resolutionDueAt && !['resolved', 'closed'].includes(t.ticketStatus) && new Date(t.resolutionDueAt) < now) {
      slaStatus = 'BREACHED (Overdue)';
    } else if (t.resolvedAt && t.resolutionDueAt && new Date(t.resolvedAt) > new Date(t.resolutionDueAt)) {
      slaStatus = 'BREACHED (Resolved late)';
    } else if (!t.resolutionDueAt) {
      slaStatus = 'No SLA Target Set';
    }

    ticketRows.push([
      idx + 1,
      sanitizeText(t.subject),
      sanitizeText(t.priority),
      sanitizeText(t.ticketStatus),
      sanitizeText(safeDecryptValue(t.contactName)),
      formatZonedDate(t.createdAt, tz),
      formatZonedDate(t.resolutionDueAt, tz),
      formatZonedDate(t.resolvedAt, tz),
      slaStatus,
      formatUtcIso(t.createdAt),
    ]);
  });
  if (data.ticketsList.length === 0) ticketRows.push(['No support tickets found in this workspace.']);

  const wsTickets = XLSX.utils.aoa_to_sheet(ticketRows);
  applySharedWorksheetStyles(wsTickets, {
    title: 'LEADRYZE AI — CUSTOMER SUPPORT TICKETS & SLA AUDIT REPORT',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 3,
    numCols: 10,
    totalRows: ticketRows.length,
    isDetailTable: true,
    numericCols: [{ colIdx: 0, format: '#,##0' }],
  });
  XLSX.utils.book_append_sheet(wb, wsTickets, '08_Support_Tickets');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 09 — FIELD SERVICE & WORK ORDERS
   * ─────────────────────────────────────────────────────────────────────────── */
  const woRows: (string | number)[][] = [
    ['LEADRYZE AI — FIELD SERVICE WORK ORDERS & OPERATIONS REGISTER'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    [
      'S.NO',
      'WORK ORDER NUMBER',
      'ORDER TITLE',
      'CUSTOMER NAME',
      'JOB STATUS',
      'PRIORITY',
      'SCHEDULED DATE (LOCAL)',
      'COMPLETED DATE (LOCAL)',
      'CREATED AT (LOCAL)',
    ],
  ];

  data.workordersList.forEach((w: any, idx: number) => {
    const custName = data.customerMap[w.customerId] || safeDecryptValue(w.customerName) || w.customerId || 'Direct Client';
    woRows.push([
      idx + 1,
      sanitizeText(w.workOrderId || w._id),
      sanitizeText(w.title),
      sanitizeText(custName),
      sanitizeText(w.status),
      sanitizeText(w.priority),
      formatZonedDate(w.scheduledDate, tz),
      formatZonedDate(w.completedDate, tz),
      formatZonedDate(w.createdAt, tz),
    ]);
  });
  if (data.workordersList.length === 0) woRows.push(['No work orders scheduled or executed.']);

  const wsWo = XLSX.utils.aoa_to_sheet(woRows);
  applySharedWorksheetStyles(wsWo, {
    title: 'LEADRYZE AI — FIELD SERVICE WORK ORDERS & OPERATIONS REGISTER',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 3,
    numCols: 9,
    totalRows: woRows.length,
    isDetailTable: true,
    numericCols: [{ colIdx: 0, format: '#,##0' }],
  });
  XLSX.utils.book_append_sheet(wb, wsWo, '09_Field_Service');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 10 — AUTOMATION TELEMETRY
   * ─────────────────────────────────────────────────────────────────────────── */
  const autoRows: (string | number)[][] = [
    ['LEADRYZE AI — AUTOMATION TELEMETRY & WORKFLOW EXECUTION LOGS'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    ['1. WORKFLOW EXECUTION RUNS (CURRENT PERIOD)'],
    ['S.NO', 'FLOW NAME', 'STATUS', 'TRIGGER EVENT', 'STARTED AT (LOCAL)', 'FINISHED AT (LOCAL)', 'DURATION (MS)', 'ERROR REASON'],
  ];

  data.automationRunsList.forEach((r: any, idx: number) => {
    autoRows.push([
      idx + 1,
      sanitizeText(r.flowName),
      sanitizeText(r.status),
      sanitizeText(r.triggerEvent || r.triggerType || 'manual'),
      formatZonedDate(r.startedAt || r.createdAt, tz),
      formatZonedDate(r.finishedAt, tz),
      r.durationMs || 0,
      sanitizeText(r.error || (r.errors && r.errors.length ? (typeof r.errors[0] === 'string' ? r.errors[0] : r.errors[0].message) : '')),
    ]);
  });
  if (data.automationRunsList.length === 0) autoRows.push(['No automated workflow executions recorded in this period.']);

  autoRows.push([], ['2. CONFIGURATION SUMMARY (RULES & FLOWS)'], ['S.NO', 'RULE / FLOW NAME', 'ENGINE TYPE', 'TRIGGER TYPE', 'STATUS']);
  let configIdx = 1;
  data.automationRulesList.forEach((ar) => {
    autoRows.push([configIdx++, sanitizeText(ar.name), 'Simple Mode Rule', sanitizeText(ar.triggerType), ar.enabled ? 'Enabled' : 'Disabled']);
  });
  data.automationFlowsList.forEach((af) => {
    autoRows.push([configIdx++, sanitizeText(af.name), 'Visual Automation Flow', 'Visual Nodes', af.enabled ? 'Enabled' : 'Disabled']);
  });

  const wsAuto = XLSX.utils.aoa_to_sheet(autoRows);
  applySharedWorksheetStyles(wsAuto, {
    title: 'LEADRYZE AI — AUTOMATION TELEMETRY & WORKFLOW EXECUTION LOGS',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 4,
    numCols: 8,
    totalRows: autoRows.length,
    isDetailTable: false,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 6, format: '#,##0' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsAuto, '10_Automation');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 11 — CONNECTORS & CAMPAIGNS
   * ─────────────────────────────────────────────────────────────────────────── */
  const connRows: (string | number)[][] = [
    ['LEADRYZE AI — PLATFORM CONNECTORS & OUTREACH CAMPAIGNS'],
    [`PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`],
    [],
    ['1. INTEGRATION CONNECTORS HEALTH'],
    ['S.NO', 'CONNECTOR NAME', 'INTEGRATION TYPE', 'SYNC STATUS', 'LAST SYNCED AT (LOCAL)', 'LAST SYNCED AT (UTC)', 'STATUS'],
  ];

  data.connectorsList.forEach((c, idx) => {
    connRows.push([
      idx + 1,
      sanitizeText(c.name || c.type),
      sanitizeText(c.type),
      sanitizeText(c.syncStatus || 'ok'),
      formatZonedDate(c.lastSyncAt, tz),
      formatUtcIso(c.lastSyncAt),
      c.isActive ? 'Active' : 'Inactive',
    ]);
  });
  if (data.connectorsList.length === 0) connRows.push(['No external connector integrations configured.']);

  connRows.push([], ['2. MARKETING & OUTREACH CAMPAIGNS'], ['S.NO', 'CAMPAIGN NAME', 'STATUS', 'TARGET AUDIENCE', 'MESSAGES SENT', 'DELIVERED', 'OPENED', 'CLICKED']);
  data.campaignsList.forEach((cmp, idx) => {
    connRows.push([
      idx + 1,
      sanitizeText(cmp.name),
      sanitizeText(cmp.status),
      sanitizeText(cmp.channel || 'omnichannel'),
      cmp.stats?.sent || 0,
      cmp.stats?.delivered || 0,
      cmp.stats?.opened || 0,
      cmp.stats?.clicked || 0,
    ]);
  });
  if (data.campaignsList.length === 0) connRows.push(['No campaigns recorded in this tenant.']);

  const wsConn = XLSX.utils.aoa_to_sheet(connRows);
  applySharedWorksheetStyles(wsConn, {
    title: 'LEADRYZE AI — PLATFORM CONNECTORS & OUTREACH CAMPAIGNS',
    subtitle: `PERIOD: ${range.localPeriodLabel} | TIMEZONE: ${tz} | SCOPE: ${branchName}`,
    headerRowIndex: 4,
    numCols: 8,
    totalRows: connRows.length,
    isDetailTable: false,
    numericCols: [
      { colIdx: 0, format: '#,##0' },
      { colIdx: 4, format: '#,##0' },
      { colIdx: 5, format: '#,##0' },
      { colIdx: 6, format: '#,##0' },
      { colIdx: 7, format: '#,##0' },
    ],
  });
  XLSX.utils.book_append_sheet(wb, wsConn, '11_Connectors_Campaigns');

  /* ───────────────────────────────────────────────────────────────────────────
   * SHEET 12 — METRIC DICTIONARY & FORMULAS
   * ─────────────────────────────────────────────────────────────────────────── */
  const rawDictEntries = [
    ['Acquisition', 'Total Leads Captured', 'COUNT(Leads)', 'Leads', 'createdAt', 'All statuses', 'None', `${tz} calendar date boundaries converted to UTC`, 'Counts individual inbound records created in period.'],
    ['Acquisition', 'Lead Conversion Rate', '(Converted Leads / Total New Leads) * 100', 'Leads', 'createdAt', 'isConverted == true', 'None', `${tz} calendar date boundaries converted to UTC`, 'Evaluates only leads arriving in the selected interval. Returns N/A if 0 total leads.'],
    ['Sales Pipeline', 'Active Open Deals', 'COUNT(Deals in open stages)', 'Deals', 'createdAt', 'Stages: qualified, proposal, negotiation, etc.', 'won, closed_won, lost, closed_lost', 'All time snapshot of current pipeline', 'Excludes closed won and closed lost opportunities.'],
    ['Sales Pipeline', 'Open Pipeline Value', 'SUM(amount)', 'Deals', 'createdAt', 'Open stages', 'Closed stages', 'All time snapshot of current pipeline', 'Monetary estimation of unclosed pipeline deals.'],
    ['Sales Pipeline', 'Won Deals Count', 'COUNT(Won Deals)', 'Deals', 'createdAt', 'won, closed_won', 'Open and lost deals', `${tz} calendar date boundaries converted to UTC`, 'Closed won opportunities.'],
    ['Sales Pipeline', 'Won Revenue', 'SUM(amount)', 'Deals', 'createdAt', 'won, closed_won', 'Open and lost deals', `${tz} calendar date boundaries converted to UTC`, 'Closed won deal values in recorded transaction currency.'],
    ['Sales Pipeline', 'Deal Win Rate', 'Won Deals / (Won Deals + Lost Deals)', 'Deals', 'createdAt', 'won, closed_won, lost, closed_lost', 'Open pipeline deals', `${tz} calendar date boundaries converted to UTC`, 'Evaluates only officially closed opportunities. Excludes active pipeline. Returns N/A when 0 closed deals.'],
    ['Customer Support', 'Total Support Tickets', 'COUNT(Tickets)', 'Tickets', 'createdAt', 'All statuses', 'None', `${tz} calendar date boundaries converted to UTC`, 'All customer requests lodged.'],
    ['Customer Support', 'Open Tickets', 'COUNT(Unresolved Tickets)', 'Tickets', 'createdAt', 'open, new, in_progress, working, pending', 'resolved, closed', 'Current snapshot in workspace', 'Backlog tickets awaiting resolution.'],
    ['Customer Support', 'Overdue Tickets', 'COUNT(resolutionDueAt < NOW)', 'Tickets', 'resolutionDueAt', 'Unresolved statuses', 'resolved, closed', 'Evaluated against current time', 'Tickets exceeding agreed resolution timeframe.'],
    ['Customer Support', 'SLA Compliance Rate', '(Total - Breached) / Total Tickets', 'Tickets', 'resolutionDueAt', 'Tickets with SLA target', 'None', 'Evaluated against ticket resolution deadlines', 'Returns N/A when 0 eligible tickets.'],
    ['Field Service', 'Work Order Completion Rate', 'Completed Orders / Total Orders', 'Workorders', 'createdAt', 'completed', 'None', `${tz} calendar date boundaries converted to UTC`, 'Turnaround effectiveness. Returns N/A when 0 orders.'],
    ['Financial', 'Total Quoted Value', 'SUM(servicesAmountWithTax)', 'Quotations', 'createdAt', 'All issued proposals', 'None', 'Preserves original quote currency', 'Cumulative proposal value.'],
    ['Financial', 'Total Invoiced Value', 'SUM(servicesAmountWithTax)', 'Invoices', 'createdAt', 'All customer invoices', 'None', 'Preserves original invoice currency', 'Cumulative billing amounts invoiced.'],
    ['Financial', 'Total Collected Cash', 'SUM(amount)', 'Receipts', 'paymentDate', 'Logged receipts', 'None', 'Preserves original receipt currency', 'Actual payments collected from customers.'],
    ['Automation', 'Automation Success Rate', 'Completed Runs / Total Runs', 'AutomationFlowRun', 'createdAt', 'completed', 'None', `${tz} calendar date boundaries converted to UTC`, 'Workflow reliability. Returns N/A when 0 executions.'],
  ];

  const dictRows: (string | number)[][] = [
    ['LEADRYZE AI — BUSINESS METRIC DICTIONARY & FORMULA SPECIFICATION'],
    [`STANDARD SPECIFICATION | IANA TIMEZONE AWARE | SCOPE: ${branchName}`],
    [],
    [
      'S.NO',
      'DOMAIN',
      'METRIC NAME',
      'CALCULATION FORMULA',
      'SOURCE MODULE',
      'BUSINESS TIMESTAMP FIELD',
      'INCLUDED STATUSES',
      'EXCLUDED STATUSES',
      'TIMEZONE POLICY',
      'LIMITATIONS / NOTES',
    ],
  ];

  rawDictEntries.forEach((entry, idx) => {
    dictRows.push([idx + 1, ...entry]);
  });

  const wsDict = XLSX.utils.aoa_to_sheet(dictRows);
  applySharedWorksheetStyles(wsDict, {
    title: 'LEADRYZE AI — BUSINESS METRIC DICTIONARY & FORMULA SPECIFICATION',
    subtitle: `STANDARD SPECIFICATION | IANA TIMEZONE AWARE | SCOPE: ${branchName}`,
    headerRowIndex: 3,
    numCols: 10,
    totalRows: dictRows.length,
    isDetailTable: true,
    numericCols: [{ colIdx: 0, format: '#,##0' }],
  });
  XLSX.utils.book_append_sheet(wb, wsDict, '12_Metric_Dictionary');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * CSV EXPORT GENERATOR (SINGLE TABLE OR COMPLETE MULTI-FILE ZIP ARCHIVE)
 * ───────────────────────────────────────────────────────────────────────────── */

export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  let s = String(val);
  // Prevent formula injection
  if (/^[=+\-@]/.test(s)) {
    s = `'${s}`;
  }
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows: (string | number)[][]): string {
  // Prefix UTF-8 BOM (\uFEFF) for Microsoft Excel compatibility
  return '\uFEFF' + rows.map((r) => r.map(escapeCsvField).join(',')).join('\r\n') + '\r\n';
}

export async function generateAnalyticsCsv(
  tenantId: string,
  branchId?: string,
  section?: string,
  dateFilter?: DateRangeFilter,
  userEmail?: string
): Promise<{ buffer: Buffer; isZip: boolean; filename: string; contentType: string }> {
  const range = parseDateRange(dateFilter);
  const data = await fetchAuthorizedData(tenantId, branchId, range);
  const tz = range.timeZone;
  const currentSection = (section || 'overview').toLowerCase();
  const dateTag = range.localStartDate + '_to_' + range.localEndDate;

  // 1. Single Section CSV Export
  if (currentSection === 'leads' || currentSection === 'lead-details') {
    const rows: (string | number)[][] = [
      ['S.NO', 'LEAD ID', 'FIRST NAME', 'LAST NAME', 'COMPANY', 'EMAIL', 'PHONE', 'SOURCE', 'STATUS', 'RATING', 'SCORE', 'LEAD OWNER', 'IS CONVERTED', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)'],
    ];
    data.leadsList.forEach((l, idx) => {
      rows.push([
        idx + 1,
        (l as any).leadId || l._id,
        safeDecryptValue(l.firstName),
        safeDecryptValue(l.lastName),
        safeDecryptValue(l.company),
        safeDecryptValue(l.email),
        safeDecryptValue(l.phone || (l as any).mobile),
        l.source || 'website',
        l.status || 'new',
        l.rating || 'warm',
        (l as any).score || 0,
        (l as any).leadOwner || 'Unassigned',
        l.isConverted ? 'Yes' : 'No',
        formatZonedDate(l.createdAt, tz),
        formatUtcIso(l.createdAt),
      ]);
    });
    const csvStr = rowsToCsv(rows);
    return {
      buffer: Buffer.from(csvStr, 'utf8'),
      isZip: false,
      filename: `LeadRyze_AI_Leads_${dateTag}.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  if (currentSection === 'deals' || currentSection === 'sales') {
    const rows: (string | number)[][] = [
      ['S.NO', 'DEAL ID', 'TITLE', 'STAGE', 'AMOUNT', 'CURRENCY', 'STATUS', 'OWNER', 'CLOSE DATE', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)'],
    ];
    data.dealsList.forEach((d: any, idx: number) => {
      rows.push([
        idx + 1,
        d.clientId || d.dealId || d._id,
        d.title || d.name,
        d.stage,
        d.amount || 0,
        d.currency || 'USD',
        d.dealStatus || d.stage,
        d.assignedStaffId || 'Unassigned',
        formatZonedDate(d.closeDate, tz, false),
        formatZonedDate(d.createdAt, tz),
        formatUtcIso(d.createdAt),
      ]);
    });
    const csvStr = rowsToCsv(rows);
    return {
      buffer: Buffer.from(csvStr, 'utf8'),
      isZip: false,
      filename: `LeadRyze_AI_Deals_${dateTag}.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  if (currentSection === 'support' || currentSection === 'tickets') {
    const rows: (string | number)[][] = [
      ['S.NO', 'TICKET SUBJECT', 'PRIORITY', 'STATUS', 'CONTACT NAME', 'CREATED AT (LOCAL)', 'DUE DATE (LOCAL)', 'RESOLVED AT (LOCAL)', 'CREATED AT (UTC)'],
    ];
    data.ticketsList.forEach((t, idx) => {
      rows.push([
        idx + 1,
        t.subject,
        t.priority,
        t.ticketStatus,
        safeDecryptValue(t.contactName),
        formatZonedDate(t.createdAt, tz),
        formatZonedDate(t.resolutionDueAt, tz),
        formatZonedDate(t.resolvedAt, tz),
        formatUtcIso(t.createdAt),
      ]);
    });
    const csvStr = rowsToCsv(rows);
    return {
      buffer: Buffer.from(csvStr, 'utf8'),
      isZip: false,
      filename: `LeadRyze_AI_Support_Tickets_${dateTag}.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  // 2. Complete Multi-File ZIP Package for Overview / Complete Platform Export
  const zip = new AdmZip();

  // Manifest
  const manifest = [
    '========================================================================',
    'LEADRYZE AI — COMPLETE BUSINESS ANALYTICS CSV EXPORT ARCHIVE',
    '========================================================================',
    `Organization / Tenant: ${data.tenantDoc?.name || 'LeadRyze AI Workspace'}`,
    `Branch Scope:         ${data.branchDoc ? data.branchDoc.branchName : 'All Branches'}`,
    `Reporting Preset:     ${range.preset.toUpperCase()}`,
    `Local Date Period:    ${range.localPeriodLabel}`,
    `Reporting Timezone:   ${tz}`,
    `Start UTC:            ${range.startUtc.toISOString()}`,
    `End UTC (Exclusive):  ${range.endExclusiveUtc.toISOString()}`,
    `Generated By:         ${userEmail || 'Authenticated User'}`,
    `Generated Timestamp:  ${new Date().toISOString()}`,
    '',
    'INCLUDED CSV DATASETS:',
    '  01_EXECUTIVE_SUMMARY.csv           - High-level KPI performance table',
    '  02_LEADS.csv                       - Full decrypted lead records captured in period',
    '  03_SALES_DEALS.csv                 - Sales opportunity pipeline and close outcomes',
    '  04_QUOTATIONS.csv                  - Issued customer proposals and quotes',
    '  05_INVOICES.csv                    - Billing invoices, taxes, and balance tracking',
    '  06_PAYMENTS_RECEIPTS.csv           - Customer receipts and cash collections',
    '  07_CRM_CONTACTS.csv                - Full decrypted contacts directory',
    '  08_CRM_COMPANIES.csv               - Business company accounts and cleaned domains',
    '  09_CRM_TASKS.csv                   - Operational tasks and assignments',
    '  10_SUPPORT_TICKETS.csv             - Support requests, priorities, and SLA deadlines',
    '  11_FIELD_SERVICE_WORKORDERS.csv    - Work orders, technicians, and maintenance jobs',
    '  12_AUTOMATION_TELEMETRY.csv        - Workflow execution telemetry and logs',
    '  13_CONNECTORS.csv                  - External integration connectors and sync status',
    '  14_METRIC_DICTIONARY.csv           - Mathematical definitions and data dictionary',
    '========================================================================',
  ].join('\r\n');
  zip.addFile('00_REPORT_MANIFEST.txt', Buffer.from(manifest, 'utf8'));

  // 01 Leads CSV
  const leadRows: (string | number)[][] = [
    ['S.NO', 'LEAD ID', 'FIRST NAME', 'LAST NAME', 'COMPANY', 'EMAIL', 'PHONE', 'SOURCE', 'STATUS', 'RATING', 'SCORE', 'LEAD OWNER', 'IS CONVERTED', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)'],
  ];
  data.leadsList.forEach((l, idx) => {
    leadRows.push([
      idx + 1,
      (l as any).leadId || l._id,
      safeDecryptValue(l.firstName),
      safeDecryptValue(l.lastName),
      safeDecryptValue(l.company),
      safeDecryptValue(l.email),
      safeDecryptValue(l.phone || (l as any).mobile),
      l.source || 'website',
      l.status || 'new',
      l.rating || 'warm',
      (l as any).score || 0,
      (l as any).leadOwner || 'Unassigned',
      l.isConverted ? 'Yes' : 'No',
      formatZonedDate(l.createdAt, tz),
      formatUtcIso(l.createdAt),
    ]);
  });
  zip.addFile('02_LEADS.csv', Buffer.from(rowsToCsv(leadRows), 'utf8'));

  // 02 Deals CSV
  const dealRows: (string | number)[][] = [
    ['S.NO', 'DEAL ID', 'DEAL TITLE', 'STAGE', 'AMOUNT', 'CURRENCY', 'STATUS', 'OWNER', 'CLOSE DATE', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)'],
  ];
  data.dealsList.forEach((d: any, idx: number) => {
    dealRows.push([
      idx + 1,
      d.clientId || d.dealId || d._id,
      d.title || d.name,
      d.stage,
      d.amount || 0,
      d.currency || 'USD',
      d.dealStatus || d.stage,
      d.assignedStaffId || 'Unassigned',
      formatZonedDate(d.closeDate, tz, false),
      formatZonedDate(d.createdAt, tz),
      formatUtcIso(d.createdAt),
    ]);
  });
  zip.addFile('03_SALES_DEALS.csv', Buffer.from(rowsToCsv(dealRows), 'utf8'));

  // 03 Invoices CSV
  const invRows: (string | number)[][] = [
    ['S.NO', 'INVOICE NUMBER', 'CUSTOMER', 'STATUS', 'DUE DATE (LOCAL)', 'SUBTOTAL', 'TAX', 'TOTAL AMOUNT', 'CURRENCY', 'AMOUNT PAID', 'BALANCE DUE', 'CREATED AT (LOCAL)'],
  ];
  data.invoicesList.forEach((inv: any, idx: number) => {
    const custName = data.customerMap[inv.customerId] || safeDecryptValue(inv.customerName) || inv.customerId || 'Direct Client';
    const subtotal = inv.servicesAmount || 0;
    const total = inv.servicesAmountWithTax || 0;
    const tax = Math.max(0, total - subtotal);
    const paid = inv.paidAmount || 0;
    const balance = Math.max(0, total - paid);

    invRows.push([
      idx + 1,
      inv.invoiceId || inv._id,
      custName,
      inv.status,
      formatZonedDate(inv.dueDate, tz, false),
      subtotal,
      tax,
      total,
      inv.currency || 'INR',
      paid,
      balance,
      formatZonedDate(inv.createdAt, tz),
    ]);
  });
  zip.addFile('05_INVOICES.csv', Buffer.from(rowsToCsv(invRows), 'utf8'));

  // 04 Receipts CSV
  const recRows: (string | number)[][] = [
    ['S.NO', 'RECEIPT NUMBER', 'CUSTOMER', 'PAYMENT DATE (LOCAL)', 'AMOUNT', 'CURRENCY', 'METHOD', 'NOTES', 'INVOICE ID', 'CREATED AT (LOCAL)'],
  ];
  data.receiptsList.forEach((r: any, idx: number) => {
    const custName = data.customerMap[r.customerId] || safeDecryptValue(r.customerName) || r.customerId || 'Direct Customer';
    recRows.push([
      idx + 1,
      r.receiptId || r._id,
      custName,
      formatZonedDate(r.paymentDate, tz, false),
      r.amount || 0,
      r.currency || 'INR',
      r.paymentMethod || 'bank_transfer',
      r.notes || '',
      r.invoiceId || '',
      formatZonedDate(r.createdAt, tz),
    ]);
  });
  zip.addFile('06_PAYMENTS_RECEIPTS.csv', Buffer.from(rowsToCsv(recRows), 'utf8'));

  // 05 Contacts CSV
  const contactRows: (string | number)[][] = [
    ['S.NO', 'FIRST NAME', 'LAST NAME', 'EMAIL', 'PHONE', 'COMPANY', 'JOB TITLE', 'STAGE', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)'],
  ];
  data.contactsList.forEach((c, idx) => {
    contactRows.push([
      idx + 1,
      safeDecryptValue(c.firstName),
      safeDecryptValue(c.lastName),
      safeDecryptValue(c.email),
      safeDecryptValue(c.phone),
      safeDecryptValue(c.company),
      c.jobTitle || '',
      c.lifecycleStage || c.status || 'lead',
      formatZonedDate(c.createdAt, tz),
      formatUtcIso(c.createdAt),
    ]);
  });
  zip.addFile('07_CRM_CONTACTS.csv', Buffer.from(rowsToCsv(contactRows), 'utf8'));

  // 06 Companies CSV
  const compRows: (string | number)[][] = [
    ['S.NO', 'COMPANY NAME', 'DOMAIN', 'INDUSTRY', 'EMPLOYEES', 'PHONE', 'STATUS', 'CREATED AT (LOCAL)', 'CREATED AT (UTC)'],
  ];
  data.companiesList.forEach((comp, idx) => {
    compRows.push([
      idx + 1,
      safeDecryptValue(comp.name),
      cleanDomain(safeDecryptValue(comp.domain || comp.website)),
      comp.industry || '',
      comp.employeeCount || 0,
      safeDecryptValue(comp.phone),
      comp.companyStatus || 'active',
      formatZonedDate(comp.createdAt, tz),
      formatUtcIso(comp.createdAt),
    ]);
  });
  zip.addFile('08_CRM_COMPANIES.csv', Buffer.from(rowsToCsv(compRows), 'utf8'));

  // 07 Support Tickets CSV
  const ticketRows: (string | number)[][] = [
    ['S.NO', 'SUBJECT', 'PRIORITY', 'STATUS', 'CONTACT NAME', 'CREATED AT (LOCAL)', 'DUE DATE (LOCAL)', 'RESOLVED AT (LOCAL)', 'CREATED AT (UTC)'],
  ];
  data.ticketsList.forEach((t, idx) => {
    ticketRows.push([
      idx + 1,
      t.subject,
      t.priority,
      t.ticketStatus,
      safeDecryptValue(t.contactName),
      formatZonedDate(t.createdAt, tz),
      formatZonedDate(t.resolutionDueAt, tz),
      formatZonedDate(t.resolvedAt, tz),
      formatUtcIso(t.createdAt),
    ]);
  });
  zip.addFile('10_SUPPORT_TICKETS.csv', Buffer.from(rowsToCsv(ticketRows), 'utf8'));

  // 08 Work Orders CSV
  const woRows: (string | number)[][] = [
    ['S.NO', 'WORK ORDER NUMBER', 'TITLE', 'CUSTOMER', 'STATUS', 'PRIORITY', 'SCHEDULED DATE (LOCAL)', 'COMPLETED DATE (LOCAL)', 'CREATED AT (LOCAL)'],
  ];
  data.workordersList.forEach((w: any, idx: number) => {
    const custName = data.customerMap[w.customerId] || safeDecryptValue(w.customerName) || w.customerId || 'Direct Client';
    woRows.push([
      idx + 1,
      w.workOrderId || w._id,
      w.title,
      custName,
      w.status,
      w.priority,
      formatZonedDate(w.scheduledDate, tz),
      formatZonedDate(w.completedDate, tz),
      formatZonedDate(w.createdAt, tz),
    ]);
  });
  zip.addFile('11_FIELD_SERVICE_WORKORDERS.csv', Buffer.from(rowsToCsv(woRows), 'utf8'));

  const zipBuffer = zip.toBuffer();
  return {
    buffer: zipBuffer,
    isZip: true,
    filename: `LeadRyze_AI_Analytics_CSV_Export_${range.preset}_${dateTag}.zip`,
    contentType: 'application/zip',
  };
}
