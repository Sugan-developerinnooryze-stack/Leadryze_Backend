import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getAutomationSettings, setAutomationsPaused } from './automation-settings.service';
import { logAuditEvent } from '../../logs/audit-log.model';

export async function get(req: AuthRequest, res: Response) {
  try {
    const settings = await getAutomationSettings(req.tenantId!);
    sendSuccess(res, settings);
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to fetch automation settings', 500);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    if (typeof req.body?.automationsPaused !== 'boolean') {
      return sendError(res, 'automationsPaused (boolean) is required', 400);
    }
    const paused = req.body.automationsPaused as boolean;
    const previous = await getAutomationSettings(req.tenantId!);
    await setAutomationsPaused(req.tenantId!, paused);

    // Mandatory audit trail for this action — reuses the existing
    // audit-log infrastructure verbatim (same call shape as the existing
    // workflow.enabled/workflow.disabled site in automation-flow.controller.ts).
    // Awaited here (unlike that fire-and-forget precedent) only because the
    // re-read just below depends on this write having landed — logAuditEvent
    // itself never throws (internal try/catch logs-and-swallows), so this
    // still can't break the pause/resume operation, which already succeeded
    // above regardless of what happens here.
    await logAuditEvent(paused ? 'automation.kill_switch.pause' : 'automation.kill_switch.resume',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
      { tenantId: req.tenantId!, target: 'Tenant', targetId: req.tenantId!, detail: { previousState: previous.automationsPaused, newState: paused } },
    );

    // Re-read (rather than hand-assemble) so the response shape is always
    // byte-identical to GET's — including lastChangedBy/lastChangedAt off
    // the audit entry just written above.
    const settings = await getAutomationSettings(req.tenantId!);
    sendSuccess(res, settings);
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to update automation settings', 400);
  }
}
