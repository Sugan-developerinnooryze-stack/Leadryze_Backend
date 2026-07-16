import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listLeads, getLeadById, createLead, updateLead,
  updateLeadStage, deleteLead, getLeadRaw,
} from './lead.service';
import { getSettings } from '../fs-settings/fs-settings.service';
import { transformPIIResponse } from '../../../platform/pii/pii.service';

async function getPIIViewRoles(tenantId: string, branchId?: string | null): Promise<string[]> {
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  return (settings as any)?.piiConfig?.find((p: any) => p.module === 'leads')?.viewRoles ?? [];
}
import { Lead }            from './lead.model';
import { NativeCustomer }  from '../customers/customer.model';
import { NativeTimeline }  from '../timeline/timeline.model';
import {
  convertLeadToContact,
  convertLeadToOpportunity,
  convertLeadToCustomer as convertLeadToCustomerSvc,
} from './lead-conversion.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listLeads(req.tenantId!, req.query as any, req.branchId);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItems = transformPIIResponse(items, 'leads', req.user!.role, viewRoles);
    sendPaginated(res, safeItems, total, page, Number(req.query.limit ?? 50));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getLeadById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Lead not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    sendSuccess(res, transformPIIResponse(item, 'leads', req.user!.role, viewRoles));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createLead({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
      lastActivityAt: new Date(),
    });
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    await NativeTimeline.create({
      tenantId:     tid,
      entityModule: 'leads',
      entityId:     item._id.toString(),
      action:       'created',
      description:  `Lead ${item.leadId} created`,
      performedBy:  req.user?.userId,
    });
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await getLeadRaw(req.params.id, req.tenantId!);
    const item = await updateLead(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Lead not found', 404);

    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    if (prev && req.body.status && req.body.status !== prev.status) {
      await NativeTimeline.create({
        tenantId:     tid,
        entityModule: 'leads',
        entityId:     item._id.toString(),
        action:       'status_changed',
        description:  `Status changed from ${prev.status} → ${req.body.status}`,
        performedBy:  req.user?.userId,
        metadata:     { from: prev.status, to: req.body.status },
      });
    } else {
      await NativeTimeline.create({
        tenantId:     tid,
        entityModule: 'leads',
        entityId:     item._id.toString(),
        action:       'updated',
        description:  'Lead details updated',
        performedBy:  req.user?.userId,
      });
    }
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function updateStage(req: AuthRequest, res: Response) {
  try {
    const prev = await getLeadRaw(req.params.id, req.tenantId!);
    const item = await updateLeadStage(req.params.id, req.tenantId!, req.body.status);
    if (!item) return sendError(res, 'Lead not found', 404);

    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    await NativeTimeline.create({
      tenantId:     tid,
      entityModule: 'leads',
      entityId:     item._id.toString(),
      action:       'status_changed',
      description:  `Pipeline stage moved: ${prev?.status ?? '?'} → ${req.body.status}`,
      performedBy:  req.user?.userId,
      metadata:     { from: prev?.status, to: req.body.status },
    });
    if (req.body.status === 'won') {
      autoLockIfConfigured(req.tenantId!, 'leads', item._id.toString(), 'won', req.user?.userId ?? 'system').catch(() => {});
    }
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteLead(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Lead not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function stats(req: AuthRequest, res: Response) {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const [pipeline, total, converted] = await Promise.all([
      Lead.aggregate([
        { $match: { tenantId: tid } },
        { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: '$expectedRevenue' } } },
      ]),
      Lead.countDocuments({ tenantId: tid }),
      Lead.countDocuments({ tenantId: tid, isConverted: true }),
    ]);
    const totalRevenue    = (pipeline as any[]).reduce((s: number, p: any) => s + (p.revenue ?? 0), 0);
    const conversionRate  = total > 0 ? Math.round((converted / total) * 100) : 0;
    sendSuccess(res, { pipeline, total, converted, totalRevenue, conversionRate });
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function convertToContact(req: AuthRequest, res: Response) {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const result = await convertLeadToContact(tid, req.params.id, req.user?.userId ?? '');
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function convertToOpportunity(req: AuthRequest, res: Response) {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const result = await convertLeadToOpportunity(tid, req.params.id, req.user?.userId ?? '');
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function convertToCustomer(req: AuthRequest, res: Response) {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const result = await convertLeadToCustomerSvc(tid, req.params.id, req.user?.userId ?? '');
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function getConversions(req: AuthRequest, res: Response) {
  try {
    const lead = await getLeadById(req.params.id, req.tenantId!);
    if (!lead) return sendError(res, 'Lead not found', 404);
    sendSuccess(res, (lead as any).conversionHistory ?? []);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function convertLead(req: AuthRequest, res: Response) {
  try {
    const tid  = new mongoose.Types.ObjectId(req.tenantId!);
    const lead = await getLeadRaw(req.params.id, req.tenantId!);
    if (!lead) return sendError(res, 'Lead not found', 404);
    if (lead.isConverted) return sendError(res, 'Lead is already converted', 400);

    const customer = await NativeCustomer.create({
      tenantId:    tid,
      name:        [lead.firstName, lead.lastName].filter(Boolean).join(' '),
      company:     lead.company,
      designation: lead.designation,
      email:       lead.email,
      phone:       lead.phone,
      mobile:      lead.mobile,
      website:     lead.website,
      address:     lead.address,
      city:        lead.city,
      state:       lead.state,
      country:     lead.country,
      postcode:    lead.postalCode,
      notes:       `Converted from Lead ${lead.leadId}`,
      tags:        lead.tags ?? [],
      status:      'active',
      createdBy:   req.user?.userId,
    });

    lead.isConverted         = true;
    lead.convertedCustomerId = customer.customerId;
    lead.convertedAt         = new Date();
    lead.status              = 'won';
    lead.lastActivityAt      = new Date();
    await lead.save();

    await NativeTimeline.create({
      tenantId:     tid,
      entityModule: 'leads',
      entityId:     lead._id.toString(),
      action:       'status_changed',
      description:  `Lead converted to Customer ${customer.customerId}`,
      performedBy:  req.user?.userId,
      metadata:     { customerId: customer.customerId, customerObjectId: customer._id },
    });

    sendSuccess(res, { lead, customer });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
