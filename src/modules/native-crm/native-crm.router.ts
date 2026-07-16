import { Router, Response } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';

import contactRoutes  from './contacts/contact.routes';
import companyRoutes  from './companies/company.routes';
import dealRoutes     from './deals/deal.routes';
import taskRoutes     from './tasks/task.routes';
import ticketRoutes   from './tickets/ticket.routes';
import callRoutes     from './calls/call.routes';
import meetingRoutes  from './meetings/meeting.routes';

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
import pdfRoutes        from './pdf/pdf.routes';

/* ── Field-service modules (Phase 4) ─────────────────────────────────────── */
import fsSettingsRoutes from './fs-settings/fs-settings.routes';
import productRoutes    from './products/product.routes';
import assetRoutes      from './assets/asset.routes';
import vehicleRoutes    from './vehicles/vehicle.routes';
import timelineRoutes   from './timeline/timeline.routes';
import customFieldRoutes    from './custom-fields/custom-field.routes';
import customTemplateRoutes from './custom-templates/custom-template.routes';
import leadRoutes           from './leads/lead.routes';
import recordLockRoutes    from './record-lock/record-lock.routes';
import branchRoutes        from './branches/branch.routes';
import workflowTemplateRoutes    from './workflow/workflow-template.routes';
import customFormTemplateRoutes  from './custom-fields/custom-form-template.routes';
import { fsCounts }         from './fs-counts.controller';
import { nativeCrmLog }     from '../../middlewares/native-crm-log.middleware';
import nativeLogRoutes      from './native-logs/native-crm-log.routes';

import { Contact }  from './contacts/contact.model';
import { Company }  from './companies/company.model';
import { Deal }     from './deals/deal.model';
import { Task }     from './tasks/task.model';
import { Ticket }   from './tickets/ticket.model';
import { Call }     from './calls/call.model';
import { Meeting }  from './meetings/meeting.model';
import mongoose from 'mongoose';

const router = Router();
router.use(authenticate, requireTenant, resolveBranch);
router.use(nativeCrmLog);

/* ── Native CRM logs ─────────────────────────────────────────────────────── */
router.use('/native-logs', nativeLogRoutes);

/* ── CRM sub-routers ──────────────────────────────────────────────────────── */
router.use('/contacts',  contactRoutes);
router.use('/companies', companyRoutes);
router.use('/deals',     dealRoutes);
router.use('/tasks',     taskRoutes);
router.use('/tickets',   ticketRoutes);
router.use('/calls',     callRoutes);
router.use('/meetings',  meetingRoutes);

/* ── Field-service sub-routers ────────────────────────────────────────────── */
router.use('/categories', categoryRoutes);
router.use('/services',   serviceRoutes);
router.use('/teams',      teamRoutes);
router.use('/staffs',     staffRoutes);
router.use('/customers',  customerRoutes);
router.use('/sites',      siteRoutes);
router.use('/parts',      partRoutes);

/* ── Phase 2 sub-routers ──────────────────────────────────────────────────── */
router.use('/quotations', quotationRoutes);
router.use('/workorders', workorderRoutes);
router.use('/contracts',  contractRoutes);
router.use('/invoices',   invoiceRoutes);
router.use('/receipts',   receiptRoutes);

/* ── Phase 3 sub-routers ──────────────────────────────────────────────────── */
router.use('/expenses',   expenseRoutes);
router.use('/activities', activityRoutes);
router.use('/pdf',        pdfRoutes);

/* ── Phase 4 sub-routers ──────────────────────────────────────────────────── */
router.use('/fs-settings',   fsSettingsRoutes);
router.use('/products',      productRoutes);
router.use('/assets',        assetRoutes);
router.use('/vehicles',      vehicleRoutes);
router.use('/timeline',      timelineRoutes);
router.use('/custom-fields',       customFieldRoutes);
router.use('/custom-templates',    customTemplateRoutes);
router.use('/leads',               leadRoutes);
router.use('/record-lock',         recordLockRoutes);
router.use('/branches',            branchRoutes);
router.use('/workflow-templates',       workflowTemplateRoutes);
router.use('/custom-form-templates',   customFormTemplateRoutes);

/* ── GET /fs-counts — field service module record counts ─────────────────── */
router.get('/fs-counts', fsCounts);

/* ── GET /stats — all module counts for sidebar badges ───────────────────── */
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const [contacts, companies, deals, tasks, tickets, calls, meetings] = await Promise.all([
      Contact.countDocuments({ tenantId: tid }),
      Company.countDocuments({ tenantId: tid }),
      Deal.countDocuments({ tenantId: tid }),
      Task.countDocuments({ tenantId: tid }),
      Ticket.countDocuments({ tenantId: tid }),
      Call.countDocuments({ tenantId: tid }),
      Meeting.countDocuments({ tenantId: tid }),
    ]);
    sendSuccess(res, { contacts, companies, deals, tasks, tickets, calls, meetings });
  } catch {
    sendError(res, 'Failed to fetch stats', 500);
  }
});

export default router;
