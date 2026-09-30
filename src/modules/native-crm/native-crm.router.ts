import { Router, Response } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { requireModuleEnabled } from '../../middlewares/module-access.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';
import { resolveDataScopeMiddleware, applyDataScopeToFilter, applyDataScopeToCreatedByFilter, resolveEffectiveScope } from './shared/data-scope';
import { resolveDateRange, applyDateRangeToFilter } from './shared/date-range';
import { getOutcomeStageKey } from './pipeline-config/pipeline-config.service';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';

import contactRoutes  from './contacts/contact.routes';
import companyRoutes  from './companies/company.routes';
import dealRoutes     from './deals/deal.routes';
import taskRoutes     from './tasks/task.routes';
import ticketRoutes   from './tickets/ticket.routes';
import ticketSlaPolicyRoutes from './tickets/ticket-sla-policy.routes';
import callRoutes     from './calls/call.routes';
import meetingRoutes  from './meetings/meeting.routes';
import datasetRoutes  from './datasets/dataset.routes';

/* ── Field-service modules (Phase 1) ─────────────────────────────────────── */
import categoryRoutes from './categories/category.routes';
import serviceRoutes  from './services/service.routes';
import teamRoutes     from './teams/team.routes';
import staffRoutes    from './staffs/staff.routes';
import customerRoutes from './customers/customer.routes';
import siteRoutes     from './sites/site.routes';
import partRoutes     from './parts/part.routes';

/* ── Field-service modules (Phase 2) ─────────────────────────────────────── */
import quotationRoutes from './quotations/quotation.routes';
import workorderRoutes from './workorders/workorder.routes';
import contractRoutes  from './contracts/contract.routes';
import invoiceRoutes   from './invoices/invoice.routes';
import receiptRoutes   from './receipts/receipt.routes';

/* ── Field-service modules (Phase 3) ─────────────────────────────────────── */
import expenseRoutes    from './expenses/expense.routes';
import activityRoutes   from './activities/activity.routes';
import activityFeedRoutes from './activity-feed/activity-feed.routes';
import pdfRoutes        from './pdf/pdf.routes';

/* ── Field-service modules (Phase 4) ─────────────────────────────────────── */
import fsSettingsRoutes from './fs-settings/fs-settings.routes';
import productRoutes    from './products/product.routes';
import catalogRoutes    from './catalog/catalog-item.routes';
import assetRoutes      from './assets/asset.routes';
import vehicleRoutes    from './vehicles/vehicle.routes';
import timelineRoutes   from './timeline/timeline.routes';
import customFieldRoutes    from './custom-fields/custom-field.routes';
import customTemplateRoutes from './custom-templates/custom-template.routes';
import templateAssetRoutes  from './custom-templates/template-asset.routes';
import templateAnalysisRoutes from './custom-templates/template-analysis.routes';
import leadRoutes           from './leads/lead.routes';
import leadCaptureRoutes    from './lead-capture/lead-capture.routes';
import recordLockRoutes    from './record-lock/record-lock.routes';
import branchRoutes        from './branches/branch.routes';
import workflowTemplateRoutes    from './workflow/workflow-template.routes';
import customFormTemplateRoutes  from './custom-fields/custom-form-template.routes';
import { fsCounts }         from './fs-counts.controller';
import { nativeCrmLog }     from '../../middlewares/native-crm-log.middleware';
import nativeLogRoutes      from './native-logs/native-crm-log.routes';
import notificationSettingsRoutes from './notification-settings/notification-settings.routes';
import { emailLogRoutes }   from '../notifications';
import pipelineConfigRoutes from './pipeline-config/pipeline-config.routes';
import automationRuleRoutes from './automation-rules/automation-rule.routes';
import automationFlowRoutes from './automation-flows/automation-flow.routes';
import automationTemplateRoutes from './automation-templates/automation-template.routes';
import automationSettingsRoutes from './automation-settings/automation-settings.routes';

import { Contact }  from './contacts/contact.model';
import { Company }  from './companies/company.model';
import { Deal }     from './deals/deal.model';
import { Task }     from './tasks/task.model';
import { Ticket }   from './tickets/ticket.model';
import { Call }     from './calls/call.model';
import { Meeting }  from './meetings/meeting.model';
import { Lead }     from './leads/lead.model';
import mongoose from 'mongoose';

const router = Router();
router.use(authenticate, requireTenant, resolveBranch);
router.use(resolveDataScopeMiddleware);
router.use(nativeCrmLog);

/* ── Native CRM logs ─────────────────────────────────────────────────────── */
router.use('/native-logs', nativeLogRoutes);

/* ── CRM sub-routers ──────────────────────────────────────────────────────── */
// Gated by tenant-level module flags (§3 of the Tenant Access Management
// plan) — in addition to, not instead of, the per-role RBAC permission
// checks each of these route files already does internally. SUPER_ADMIN
// bypasses inside requireModuleEnabled itself.
router.use('/contacts',  requireModuleEnabled('native_contacts'),  contactRoutes);
router.use('/companies', requireModuleEnabled('native_companies'), companyRoutes);
router.use('/deals',     requireModuleEnabled('native_deals'),     dealRoutes);
router.use('/tasks',     requireModuleEnabled('native_tasks'),     taskRoutes);
// Registered BEFORE '/tickets' — ticketRoutes has a GET/PUT '/:id' catch-all
// that would otherwise swallow '/tickets/sla-policy' as if 'sla-policy' were
// a ticket id (Express matches router.use() calls in registration order).
router.use('/tickets/sla-policy', requireModuleEnabled('native_tickets'), ticketSlaPolicyRoutes);
router.use('/tickets',   requireModuleEnabled('native_tickets'),  ticketRoutes);
router.use('/calls',     requireModuleEnabled('native_calls'),    callRoutes);
router.use('/meetings',  requireModuleEnabled('native_meetings'), meetingRoutes);
router.use('/datasets',  datasetRoutes);

/* ── Field-service sub-routers ────────────────────────────────────────────── */
router.use('/categories', requireModuleEnabled('fs_categories'), categoryRoutes);
router.use('/services',   requireModuleEnabled('fs_services'),   serviceRoutes);
router.use('/teams',      requireModuleEnabled('fs_teams'),      teamRoutes);
router.use('/staffs',     requireModuleEnabled('fs_staffs'),     staffRoutes);
router.use('/customers',  requireModuleEnabled('fs_customers'),  customerRoutes);
router.use('/sites',      requireModuleEnabled('fs_sites'),      siteRoutes);
router.use('/parts',      requireModuleEnabled('fs_parts'),      partRoutes);

/* ── Phase 2 sub-routers ──────────────────────────────────────────────────── */
router.use('/quotations', requireModuleEnabled('fs_quotations'), quotationRoutes);
router.use('/workorders', requireModuleEnabled('fs_workorders'), workorderRoutes);
router.use('/contracts',  requireModuleEnabled('fs_contracts'),  contractRoutes);
router.use('/invoices',   requireModuleEnabled('fs_invoices'),   invoiceRoutes);
router.use('/receipts',   requireModuleEnabled('fs_receipts'),   receiptRoutes);

/* ── Phase 3 sub-routers ──────────────────────────────────────────────────── */
router.use('/expenses',   requireModuleEnabled('fs_expenses'),   expenseRoutes);
router.use('/activities', requireModuleEnabled('fs_activities'), activityRoutes);
router.use('/activity-feed', activityFeedRoutes);
router.use('/pdf',        pdfRoutes);

/* ── Phase 4 sub-routers ──────────────────────────────────────────────────── */
router.use('/fs-settings',   requireModuleEnabled('config_fsSettings'),    fsSettingsRoutes);
router.use('/products',      requireModuleEnabled('fs_products'),          productRoutes);
router.use('/catalog',       catalogRoutes);
router.use('/assets',        requireModuleEnabled('fs_assets'),            assetRoutes);
router.use('/vehicles',      requireModuleEnabled('fs_vehicles'),          vehicleRoutes);
router.use('/timeline',      timelineRoutes);
router.use('/custom-fields',       requireModuleEnabled('config_customFields'), customFieldRoutes);
router.use('/custom-templates',    customTemplateRoutes);
router.use('/template-assets',     templateAssetRoutes);
router.use('/template-analysis',   templateAnalysisRoutes);
router.use('/leads',               requireModuleEnabled('fs_leads'), leadRoutes);
router.use('/lead-capture',        leadCaptureRoutes);
router.use('/record-lock',         recordLockRoutes);
router.use('/branches',            branchRoutes);
router.use('/workflow-templates',       workflowTemplateRoutes);
router.use('/custom-form-templates',   customFormTemplateRoutes);
router.use('/notification-settings',   notificationSettingsRoutes);
router.use('/email-logs',              emailLogRoutes);
router.use('/pipeline-config',         pipelineConfigRoutes);
router.use('/automation-rules',        automationRuleRoutes);
router.use('/automation-flows',        automationFlowRoutes);
router.use('/automation-templates',    automationTemplateRoutes);
router.use('/automation-settings',     automationSettingsRoutes);

/* ── GET /fs-counts — field service module record counts ─────────────────── */
router.get('/fs-counts', fsCounts);

/* ── GET /stats — all module counts for sidebar badges. Respects the same
   per-module Data Visibility toggle every list/stats endpoint already does
   — without this, a Manager/Agent's sidebar showed the raw tenant-wide
   count even when the module's own page correctly showed their scoped
   subset (e.g. "Meetings 7" in the sidebar with 0 actually visible). ───── */
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const createdByAnchored = (moduleKey: string) => {
      const f: Record<string, unknown> = { tenantId: tid };
      applyDataScopeToCreatedByFilter(f, resolveEffectiveScope(req, moduleKey));
      return f;
    };
    const staffAnchored = (moduleKey: string, field: string) => {
      const f: Record<string, unknown> = { tenantId: tid };
      applyDataScopeToFilter(f, resolveEffectiveScope(req, moduleKey), field);
      return f;
    };
    const [contacts, companies, deals, tasks, tickets, calls, meetings] = await Promise.all([
      Contact.countDocuments(createdByAnchored('contacts')),
      Company.countDocuments(createdByAnchored('companies')),
      Deal.countDocuments(staffAnchored('deals', 'assignedStaffId')),
      Task.countDocuments(createdByAnchored('tasks')),
      Ticket.countDocuments(createdByAnchored('tickets')),
      Call.countDocuments(createdByAnchored('calls')),
      Meeting.countDocuments(staffAnchored('meetings', 'assignedStaffId')),
    ]);
    sendSuccess(res, { contacts, companies, deals, tasks, tickets, calls, meetings });
  } catch {
    sendError(res, 'Failed to fetch stats', 500);
  }
});

/* ── GET /dashboard-stats — role-scoped Lead/Meeting summary for the main
   landing Dashboard. Reuses req.dataScope exactly like Lead.stats()/
   Meeting.stats() already do — a MANAGER sees only their own team's
   numbers here, an AGENT only their own, SUPER_ADMIN/TENANT_ADMIN see the
   full tenant. Deliberately separate from Lead's own /leads/stats (which
   is shaped for the Leads pipeline page) — this is a different, broader
   shape combining Leads + Meetings for one summary view. ────────────── */
router.get('/dashboard-stats', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Base filters (no date range) — newToday/appointmentsToday are always
    // real-time "today" signals, independent of the range switcher, same
    // rule applied to Tasks'/Work Orders' overdue/dueToday fields.
    const leadFilterBase: Record<string, unknown> = { tenantId: tid };
    // Real, confirmed bug this fixes: every other Lead-scoped endpoint
    // (lead.service.ts's own list/stats) already applies req.branchId —
    // this dashboard summary was the one place that never did, so switching
    // branches left it silently showing tenant-wide numbers. Meeting has no
    // branchId field at all yet (a separate, larger gap — not scoped here).
    if (req.branchId) leadFilterBase.branchId = new mongoose.Types.ObjectId(req.branchId);
    applyDataScopeToFilter(leadFilterBase, resolveEffectiveScope(req, 'leads'), 'leadOwnerStaffId');
    const meetingFilter: Record<string, unknown> = { tenantId: tid };
    applyDataScopeToFilter(meetingFilter, resolveEffectiveScope(req, 'meetings'), 'assignedStaffId');

    const leadFilter = { ...leadFilterBase };
    applyDateRangeToFilter(leadFilter, 'createdAt', resolveDateRange(
      req.query.range as string | undefined,
      req.query.customFrom as string | undefined,
      req.query.customTo as string | undefined,
    ));

    // "Won" here means the lead has actually reached this tenant's Won
    // pipeline stage — same fix already applied to lead.controller.ts's own
    // /leads/stats earlier this session, ported here since this endpoint had
    // its own separate, still-buggy isConverted:true count feeding the
    // exact same "Conversion" KPI the dashboard displays.
    const wonKey = await getOutcomeStageKey(req.tenantId!, 'lead', 'won', 'won');

    const [totalLeads, newToday, converted, appointments, appointmentsToday, sourceAgg, statusAgg] = await Promise.all([
      Lead.countDocuments(leadFilter),
      Lead.countDocuments({ ...leadFilterBase, createdAt: { $gte: today } }),
      Lead.countDocuments({ ...leadFilter, status: wonKey }),
      Meeting.countDocuments(meetingFilter),
      Meeting.countDocuments({ ...meetingFilter, startDate: { $gte: today, $lte: todayEnd } }),
      Lead.aggregate([{ $match: leadFilter }, { $group: { _id: '$source', count: { $sum: 1 } } }]),
      Lead.aggregate([{ $match: leadFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    const bySource: Record<string, number> = {};
    (sourceAgg as any[]).forEach((r) => { bySource[r._id ?? 'other'] = r.count; });
    const byStatus: Record<string, number> = {};
    (statusAgg as any[]).forEach((r) => { byStatus[r._id ?? 'new'] = r.count; });

    const conversionRate = totalLeads > 0 ? (converted / totalLeads) * 100 : 0;

    sendSuccess(res, { totalLeads, newToday, appointments, appointmentsToday, conversionRate, bySource, byStatus });
  } catch {
    sendError(res, 'Failed to fetch dashboard stats', 500);
  }
});

export default router;
