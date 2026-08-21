import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getOrCreateSlaPolicy, updateSlaPolicy } from './ticket-sla-policy.service';

export async function get(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await getOrCreateSlaPolicy(req.tenantId!)); }
  catch { sendError(res, 'Failed to fetch SLA policy', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const { enabled, warningPercent, policies } = req.body ?? {};
    const doc = await updateSlaPolicy(req.tenantId!, { enabled, warningPercent, policies });
    sendSuccess(res, doc, 'SLA policy updated');
  } catch (err: any) { sendError(res, err.message ?? 'Failed to update SLA policy', 500); }
}
