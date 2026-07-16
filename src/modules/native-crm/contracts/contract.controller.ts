import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listContracts,
  getContractById,
  createContract,
  updateContract,
  deleteContract,
  updateVisitStatus,
  generateWorkordersForVisits,
} from './contract.service';
import { generateVisits, summarizeVisits } from './schedule.engine';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listContracts(req.tenantId!, req.query, req.branchId);
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getContractById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Contract not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createContract({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
    });
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateContract(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Contract not found', 404);
    if (req.body.status === 'active') {
      autoLockIfConfigured(req.tenantId!, 'contracts', String(item._id), 'active', req.user?.userId ?? 'system').catch(() => {});
    }
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteContract(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Contract not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

/** POST /schedule-preview — dry-run the schedule engine for the form preview. */
export async function schedulePreview(req: AuthRequest, res: Response) {
  try {
    const { services, startDate, endDate } = req.body ?? {};
    if (!Array.isArray(services) || !startDate || !endDate) {
      return sendError(res, 'services, startDate and endDate are required', 400);
    }
    const visits  = generateVisits(services, startDate, endDate);
    const summary = summarizeVisits(visits, startDate, endDate);
    sendSuccess(res, { summary, visits });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

/** PATCH /:id/visit-status — update one generated visit. */
export async function visitStatus(req: AuthRequest, res: Response) {
  try {
    const { visitNumber, status, workOrderId, woId, notes } = req.body ?? {};
    if (!visitNumber) return sendError(res, 'visitNumber is required', 400);
    if (status && !['planned', 'scheduled', 'completed', 'cancelled'].includes(status)) {
      return sendError(res, 'Invalid status', 400);
    }
    const item = await updateVisitStatus(req.params.id, req.tenantId!, Number(visitNumber), {
      status, workOrderId, woId, notes,
    });
    if (!item) return sendError(res, 'Contract or visit not found', 404);
    sendSuccess(res, item, 'Visit updated');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

/** POST /:id/generate-workorders — create WOs for planned visits. */
export async function generateWorkorders(req: AuthRequest, res: Response) {
  try {
    const { visitNumbers } = req.body ?? {};
    const result = await generateWorkordersForVisits(req.params.id, req.tenantId!, {
      visitNumbers: Array.isArray(visitNumbers) ? visitNumbers.map(Number) : undefined,
      createdBy:    req.user?.userId ?? 'system',
    });
    if (result.error) return sendError(res, result.error, 404);
    sendSuccess(res, result, `${result.created} work order(s) created`);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
