import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listLeads, listLeadsForExport, getLeadById, createLead, updateLead,
  updateLeadStage, deleteLead, getLeadRaw,
} from './lead.service';
import { NativeCustomField } from '../custom-fields/custom-field.model';
import { rowsToCsv, sendCsvResponse, CsvColumn } from '../../../utils/csv-export.util';
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
import { getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';

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

const LEAD_EXPORT_COLUMNS: CsvColumn[] = [
  { key: 'leadId',          label: 'Lead ID' },
  { key: 'firstName',       label: 'First Name' },
  { key: 'lastName',        label: 'Last Name' },
  { key: 'company',         label: 'Company' },
  { key: 'designation',     label: 'Designation' },
  { key: 'email',           label: 'Email' },
  { key: 'phone',           label: 'Phone' },
  { key: 'mobile',          label: 'Mobile' },
  { key: 'status',          label: 'Status' },
  { key: 'source',          label: 'Source' },
  { key: 'rating',          label: 'Rating' },
  { key: 'priority',        label: 'Priority' },
  { key: 'leadOwner',       label: 'Owner' },
  { key: 'city',            label: 'City' },
  { key: 'state',           label: 'State' },
  { key: 'country',         label: 'Country' },
  { key: 'expectedRevenue', label: 'Expected Revenue' },
  { key: 'tags',            label: 'Tags' },
  { key: 'isConverted',     label: 'Converted' },
  { key: 'createdAt',       label: 'Created At' },
];

/** GET /leads/export — same filters as the list endpoint, but every
 * matching record rather than one page, rendered to a downloadable CSV.
 * Reuses the exact PII masking the list endpoint applies, so an export
 * can never leak a field the requesting role isn't allowed to see. */
export async function exportCsv(req: AuthRequest, res: Response) {
  try {
    const items = await listLeadsForExport(req.tenantId!, req.query as any, req.branchId);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItems = transformPIIResponse(items, 'leads', req.user!.role, viewRoles) as any[];

    const customFields = await NativeCustomField
      .find({ tenantId: req.tenantId!, module: 'leads', isActive: true })
      .sort({ order: 1 })
      .lean();
    const columns: CsvColumn[] = [
      ...LEAD_EXPORT_COLUMNS,
      ...customFields.map((f) => ({ key: `customFields.${f.fieldKey}`, label: f.label })),
    ];

    const csv = rowsToCsv(safeItems, columns);
    sendCsvResponse(res, `leads-export-${new Date().toISOString().slice(0, 10)}.csv`, csv);
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
    runAutomationsOnCreate(req.tenantId!, 'lead', item.toObject()).catch(() => {});
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
      runAutomations(req.tenantId!, 'lead', item.toObject(), req.body.status).catch(() => {});
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
    if (prev) {
      runAutomationsOnUpdate(req.tenantId!, 'lead', prev.toObject(), item.toObject()).catch(() => {});
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
    const wonKey = await getOutcomeStageKey(req.tenantId!, 'lead', 'won', 'won');
    if (req.body.status === wonKey) {
      autoLockIfConfigured(req.tenantId!, 'leads', item._id.toString(), wonKey, req.user?.userId ?? 'system').catch(() => {});
    }
    runAutomations(req.tenantId!, 'lead', item.toObject(), req.body.status).catch(() => {});
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteLead(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Lead not found', 404);
    runAutomationsOnDelete(req.tenantId!, 'lead', item.toObject()).catch(() => {});
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
    lead.status              = await getOutcomeStageKey(req.tenantId!, 'lead', 'won', 'won');
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

    runAutomations(req.tenantId!, 'lead', lead.toObject(), lead.status).catch(() => {});
    sendSuccess(res, { lead, customer });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
