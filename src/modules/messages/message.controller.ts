import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as messageService from './message.service';
import { sendSuccess, sendPaginated } from '../../utils/response';

export async function getMessages(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { messages, total, page, limit } = await messageService.getMessages(req.tenantId!, req.query as Record<string, unknown>);
    sendPaginated(res, messages, total, page, limit);
  } catch (err) { next(err); }
}

export async function getConversation(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const messages = await messageService.getConversationHistory(req.tenantId!, req.params.sessionId);
    sendSuccess(res, messages, 'Conversation fetched');
  } catch (err) { next(err); }
}
