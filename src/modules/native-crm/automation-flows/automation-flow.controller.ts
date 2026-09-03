import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listFlows, getFlowById, createFlow, updateFlow, deleteFlow, listFlowRuns, getFlowRunById, getFlowRunStats, decideApproval,
  publishFlow, discardDraft, dryRunFlow,
} from './automation-flow.service';
import { logAuditEvent } from '../../logs/audit-log.model';

// Everyone Error Branch's own 'tenant_admin' recipient already covers, PLUS
// 'manager' — a Manager deciding their own Approval gate is the whole point
// of this endpoint, and the two admin roles can decide on a Manager's
// behalf, same as every other admin-can-do-anything precedent in this app.
const APPROVAL_DECISION_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER'];

export async function list(req: AuthRequest, res: Response) {
  try {
    const items = await listFlows(req.tenantId!);
    sendSuccess(res, items);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getFlowById(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Automation flow not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createFlow(req.tenantId!, { ...req.body, createdBy: req.user?.userId });
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateFlow(req.tenantId!, req.params.id, req.body);
    if (!item) return sendError(res, 'Automation flow not found', 404);
    if (req.body.enabled !== undefined) {
      logAuditEvent(req.body.enabled ? 'workflow.enabled' : 'workflow.disabled',
        { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
        { tenantId: req.tenantId!, target: 'AutomationFlow', targetId: req.params.id, detail: { flowId: req.params.id, flowName: (item as any).name } },
      );
    }
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteFlow(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Automation flow not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

// GET /api/v1/native-crm/automation-flows/runs?flowId=&status=&page=&limit=
// Read-only — a run is only ever created by executeFlow() itself.
export async function listRuns(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listFlowRuns(req.tenantId!, {
      flowId: req.query.flowId as string | undefined,
      status: req.query.status as string | undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getStats(req: AuthRequest, res: Response) {
  try {
    const stats = await getFlowRunStats(req.tenantId!);
    sendSuccess(res, stats);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOneRun(req: AuthRequest, res: Response) {
  try {
    const item = await getFlowRunById(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Flow run not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function publish(req: AuthRequest, res: Response) {
  try {
    const item = await publishFlow(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Automation flow not found', 404);
    logAuditEvent('workflow.published',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
      { tenantId: req.tenantId!, target: 'AutomationFlow', targetId: req.params.id, detail: { flowId: req.params.id, flowName: (item as any).name, after: { version: (item as any).version } } },
    );
    sendSuccess(res, item, 'Flow published');
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function discardDraftHandler(req: AuthRequest, res: Response) {
  try {
    const item = await discardDraft(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Automation flow not found', 404);
    logAuditEvent('workflow.draft_discarded',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
      { tenantId: req.tenantId!, target: 'AutomationFlow', targetId: req.params.id, detail: { flowId: req.params.id, flowName: (item as any).name } },
    );
    sendSuccess(res, item, 'Draft discarded');
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function dryRun(req: AuthRequest, res: Response) {
  try {
    const result = await dryRunFlow(req.tenantId!, req.params.id, req.body.sampleModule, req.body.sampleRecordId);
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

// PATCH /automation-flows/runs/:id/decision — resolves a paused Approval
// node. Role-gated beyond the router's blanket authenticate/requireTenant
// (see APPROVAL_DECISION_ROLES above) since an AGENT deciding their own
// approval gate would defeat the entire point of the node.
export async function decide(req: AuthRequest, res: Response) {
  if (!APPROVAL_DECISION_ROLES.includes(req.user?.role ?? '')) {
    return sendError(res, 'Only a Manager or Tenant Admin can decide on a pending approval', 403);
  }
  try {
    const result = await decideApproval(req.tenantId!, req.params.id, req.body.decision, req.user?.userId);
    if (!result.ok) return sendError(res, result.reason ?? 'No pending approval found for this run', 404);
    sendSuccess(res, null, 'Decision recorded');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
