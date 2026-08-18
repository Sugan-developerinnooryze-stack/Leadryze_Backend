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
import { NativeTimeline }  from '../timeline/timeline.model';
import {
  convertLeadToContact,
  convertLeadToOpportunity,
  convertLeadToCustomer as convertLeadToCustomerSvc,
} from './lead-conversion.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { resolveTeamFromStaffId, resolveSupervisorName } from '../shared/team-resolution';
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listLeads(req.tenantId!, req.query as any, req.branchId, resolveEffectiveScope(req, 'leads'));
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
    const items = await listLeadsForExport(req.tenantId!, req.query as any, req.branchId, resolveEffectiveScope(req, 'leads'));
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
    const item = await getLeadById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'leads'));
    if (!item) return sendError(res, 'Lead not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItem = transformPIIResponse(item, 'leads', req.user!.role, viewRoles) as Record<string, unknown>;
    // Live-resolved, never stored — same rule as the Meeting detail response
    // (a team's manager can change independently of any given Lead).
    safeItem.supervisorName = await resolveSupervisorName(req.tenantId!, (item as any).teamId);
    sendSuccess(res, safeItem);
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
    const prev = await getLeadRaw(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'leads'));

    // A real staff-owner reassignment (Manager/Admin picking a different
    // owner) — resolve the new teamId/teamName server-side, same authority
    // rule as the Meeting reassignment path, before the update is applied.
    const isReassignment = prev && req.body.leadOwnerStaffId !== undefined
      && req.body.leadOwnerStaffId !== prev.leadOwnerStaffId;
    if (isReassignment) {
      const { teamId, teamName } = await resolveTeamFromStaffId(req.tenantId!, req.body.leadOwnerStaffId);
      req.body.teamId = teamId ?? undefined;
      req.body.teamName = teamName ?? undefined;
    }

    const item = await updateLead(req.params.id, req.tenantId!, req.body, resolveEffectiveScope(req, 'leads'));
    if (!item) return sendError(res, 'Lead not found', 404);

    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    if (isReassignment) {
      const prevOwner = prev!.leadOwner || prev!.leadOwnerStaffId || 'Unassigned';
      const newOwner = item.leadOwner || req.body.leadOwnerStaffId || 'Unassigned';
      await NativeTimeline.create({
        tenantId:     tid,
        entityModule: 'leads',
        entityId:     item._id.toString(),
        action:       'reassigned',
        description:  `Reassigned from ${prevOwner} to ${newOwner} by ${req.user?.userId ?? 'system'}`,
        performedBy:  req.user?.userId,
        metadata:     { previousStaffId: prev!.leadOwnerStaffId, newStaffId: req.body.leadOwnerStaffId, teamId: req.body.teamId, teamName: req.body.teamName },
      });
    }
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
    const prev = await getLeadRaw(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'leads'));
    const item = await updateLeadStage(req.params.id, req.tenantId!, req.body.status, resolveEffectiveScope(req, 'leads'));
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
    const item = await deleteLead(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'leads'));
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
    const matchFilter: Record<string, unknown> = { tenantId: tid };
    applyDataScopeToFilter(matchFilter, resolveEffectiveScope(req, 'leads'), 'leadOwnerStaffId');
    const [pipeline, total, converted] = await Promise.all([
      Lead.aggregate([
        { $match: matchFilter },
        { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: '$expectedRevenue' } } },
      ]),
      Lead.countDocuments(matchFilter),
      Lead.countDocuments({ ...matchFilter, isConverted: true }),
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
    const lead = await getLeadById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'leads'));
    if (!lead) return sendError(res, 'Lead not found', 404);
    sendSuccess(res, (lead as any).conversionHistory ?? []);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

/** Same canonical path as convertToCustomer below — this route used to have
 * its own separate, incomplete inline implementation (set the Lead's stage
 * to "won" but never recorded the Customer's back-references, while the
 * dedicated /:id/convert/customer route did the reverse). Now a thin
 * wrapper delegating to the one, fixed convertLeadToCustomerSvc — kept as
 * its own exported controller function only because lead.routes.ts still
 * exposes this legacy path separately from /:id/convert/customer. */
export async function convertLead(req: AuthRequest, res: Response) {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const result = await convertLeadToCustomerSvc(tid, req.params.id, req.user?.userId ?? '');
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
