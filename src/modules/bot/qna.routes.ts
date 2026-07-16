import { Router, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import { QnAPair } from './qna.model';
import { AIAction } from './ai-action.model';
import { ChatSession } from './chat-session.model';
import { handleCrmChat } from './crm-chat';

const router = Router();
router.use(authenticate, requireTenant);

// GET /api/v1/bot/qna — list all Q&A pairs for this tenant
router.get('/qna', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const pairs = await QnAPair.find({ tenantId: req.tenantId }).sort({ createdAt: -1 });
    sendSuccess(res, pairs);
  } catch (err) { next(err); }
});

// POST /api/v1/bot/qna — create a new Q&A pair
router.post('/qna', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { question, answer, category } = req.body as { question: string; answer: string; category?: string };
    if (!question?.trim() || !answer?.trim()) {
      sendError(res, 'question and answer are required', 400);
      return;
    }
    const pair = await QnAPair.create({ tenantId: req.tenantId, question: question.trim(), answer: answer.trim(), category: category || 'general' });
    sendSuccess(res, pair, 'Q&A pair created');
  } catch (err) { next(err); }
});

// PUT /api/v1/bot/qna/:id — update
router.put('/qna/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { question, answer, category, isActive } = req.body as { question?: string; answer?: string; category?: string; isActive?: boolean };
    const pair = await QnAPair.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { $set: { question, answer, category, isActive } },
      { new: true, runValidators: true }
    );
    if (!pair) { sendError(res, 'Not found', 404); return; }
    sendSuccess(res, pair, 'Q&A pair updated');
  } catch (err) { next(err); }
});

// DELETE /api/v1/bot/qna/:id
router.delete('/qna/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const pair = await QnAPair.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!pair) { sendError(res, 'Not found', 404); return; }
    sendSuccess(res, null, 'Deleted');
  } catch (err) { next(err); }
});

// GET /api/v1/bot/chat-history — list chat sessions
router.get('/chat-history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page as string || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));
    const [sessions, total] = await Promise.all([
      ChatSession.find({ tenantId: req.tenantId })
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('sessionId visitorName visitorEmail channel escalated messages createdAt updatedAt'),
      ChatSession.countDocuments({ tenantId: req.tenantId }),
    ]);
    sendSuccess(res, { sessions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// GET /api/v1/bot/chat-history/:sessionId — single session detail
router.get('/chat-history/:sessionId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const session = await ChatSession.findOne({ sessionId: req.params.sessionId, tenantId: req.tenantId });
    if (!session) { sendError(res, 'Not found', 404); return; }
    sendSuccess(res, session);
  } catch (err) { next(err); }
});

/* ── GET /api/v1/bot/ai-actions — paginated AI action log ── */
router.get('/ai-actions', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page as string || '1', 10));
    const limit    = Math.min(100, parseInt(req.query.limit as string || '30', 10));
    const type     = req.query.type as string | undefined;

    const filter: Record<string, unknown> = { tenantId: req.tenantId };
    if (type) filter.actionType = type;

    const [actions, total] = await Promise.all([
      AIAction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AIAction.countDocuments(filter),
    ]);
    sendSuccess(res, { actions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

/* ── GET /api/v1/bot/ai-actions/stats — overview counts ── */
router.get('/ai-actions/stats', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [typeCounts, totalSessions, escalations, recentSessions] = await Promise.all([
      AIAction.aggregate([
        { $match: { tenantId: tid } },
        { $group: { _id: '$actionType', count: { $sum: 1 } } },
      ]),
      ChatSession.countDocuments({ tenantId: tid }),
      ChatSession.countDocuments({ tenantId: tid, escalated: true }),
      ChatSession.countDocuments({ tenantId: tid, createdAt: { $gte: since7d } }),
    ]);

    const byType: Record<string, number> = {};
    for (const row of typeCounts) byType[row._id as string] = row.count as number;

    sendSuccess(res, {
      totalSessions,
      escalations,
      recentSessions,
      crmQueries:      (byType.crm_query || 0) + (byType.crm_filter || 0) + (byType.crm_search || 0),
      leadsCapture:    byType.lead_capture || 0,
      knowledgeQueries: byType.knowledge_query || 0,
      byType,
    });
  } catch (err) { next(err); }
});

/* ── GET /api/v1/bot/leads — leads captured via chat ── */
router.get('/leads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page as string || '1', 10));
    const limit = Math.min(100, parseInt(req.query.limit as string || '20', 10));

    const filter = {
      tenantId: req.tenantId,
      $or: [{ visitorEmail: { $exists: true, $ne: '' } }, { visitorPhone: { $exists: true, $ne: '' } }],
    };

    const [sessions, total] = await Promise.all([
      ChatSession.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('sessionId visitorName visitorEmail visitorPhone channel escalated createdAt'),
      ChatSession.countDocuments(filter),
    ]);
    sendSuccess(res, { leads: sessions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

/* ── POST /api/v1/bot/crm-chat — local CRM + activities NLP search ─────────── */
router.post('/crm-chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { message } = req.body as { message?: string };
    if (!message?.trim()) {
      sendError(res, 'message is required', 400);
      return;
    }
    const result = await handleCrmChat(req.tenantId!, message);
    sendSuccess(res, result);
  } catch (err) { next(err); }
});

export default router;
