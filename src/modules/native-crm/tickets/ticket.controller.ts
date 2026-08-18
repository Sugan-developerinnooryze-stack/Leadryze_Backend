import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './ticket.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, relatedModule, relatedId } = req.query as Record<string, string>;
    const result = await svc.listTickets(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
      relatedModule, relatedId,
    }, resolveEffectiveScope(req, 'tickets'));
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch tickets', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getTicketById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tickets'));
    if (!record) return void sendError(res, 'Ticket not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch ticket', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createTicket(req.tenantId!, req.body);
    runAutomationsOnCreate(req.tenantId!, 'ticket', record as any).catch(() => {});
    sendCreated(res, record, 'Ticket created');
  } catch { sendError(res, 'Failed to create ticket', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await svc.getTicketById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tickets'));
    const record = await svc.updateTicket(req.tenantId!, req.params.id, req.body, resolveEffectiveScope(req, 'tickets'));
    if (!record) return void sendError(res, 'Ticket not found', 404);
    if (req.body.ticketStatus) runAutomations(req.tenantId!, 'ticket', record as any, req.body.ticketStatus).catch(() => {});
    if (prev) runAutomationsOnUpdate(req.tenantId!, 'ticket', prev, record as any).catch(() => {});
    sendSuccess(res, record, 'Ticket updated');
  } catch { sendError(res, 'Failed to update ticket', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const record = await svc.deleteTicket(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tickets'));
    if (!record) return void sendError(res, 'Ticket not found', 404);
    runAutomationsOnDelete(req.tenantId!, 'ticket', record as any).catch(() => {});
    sendSuccess(res, null, 'Ticket deleted');
  } catch { sendError(res, 'Failed to delete ticket', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getTicketStats(req.tenantId!, resolveEffectiveScope(req, 'tickets'))); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
