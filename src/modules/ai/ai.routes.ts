import { Router, Response, NextFunction } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';
import { uploadAudio } from '../../middlewares/upload.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import { config } from '../../config';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: AI
 *   description: AI chat and knowledge base (proxied to AI microservice)
 */

router.use(authenticate, requireTenant, resolveBranch);

const aiHeaders = { 'x-api-key': config.ai.internalApiKey };
const AI_URL = config.app.aiServiceUrl;

/**
 * @swagger
 * /ai/chat:
 *   post:
 *     tags: [AI]
 *     summary: Send a message to the AI lead capture agent
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, message]
 *             properties:
 *               sessionId: { type: string }
 *               message: { type: string }
 *               channel: { type: string }
 *     responses:
 *       200: { description: AI response with captured lead data }
 */
router.post('/chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Signed, short-lived identity assertion for the internal CRM-search
    // path (base.agent.ts -> backend.client.ts -> /api/internal/crm-search)
    // to authorize against — reusing the exact same signed-JWT technique
    // already used for OAuth's `state` param, rather than forwarding
    // role/roleId/userId/branchId as plain, independently-trusted query
    // params an internal-key holder could otherwise forge. The AI service
    // never interprets this token, only passes it through unmodified.
    const internalAuth = jwt.sign(
      {
        tenantId: req.tenantId, role: req.user!.role, roleId: req.user!.roleId,
        userId: req.user!.userId, branchId: req.branchId ?? null,
      },
      config.jwt.secret, { expiresIn: '2m' },
    );
    const response = await axios.post(
      `${AI_URL}/api/chat`,
      { ...req.body, tenantId: req.tenantId, internalAuth },
      // Raised from 70s: the tool-calling loop (up to 3 rounds, each
      // possibly needing a primary+fallback retry) legitimately needs more
      // room than a single plain completion did when 70s was chosen.
      { headers: aiHeaders, timeout: 100000 }
    );
    sendSuccess(res, response.data.data, 'AI response generated');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /ai/knowledge:
 *   post:
 *     tags: [AI]
 *     summary: Ingest a knowledge item into the RAG vector store
 *   get:
 *     tags: [AI]
 *     summary: Search knowledge base
 */
router.post('/knowledge', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Was posting to `${AI_URL}/api/knowledge` — the AI service has no such
    // route (it's `/api/knowledge/ingest`), so this call 404'd every time.
    // Pre-existing, unrelated to this pass — fixed here since this file is
    // already being extended with the crawl proxy routes below.
    const response = await axios.post(
      `${AI_URL}/api/knowledge/ingest`,
      { ...req.body, tenantId: req.tenantId },
      { headers: aiHeaders, timeout: 60000 }
    );
    sendSuccess(res, response.data.data, 'Knowledge ingested');
  } catch (err) {
    next(err);
  }
});

router.post('/knowledge/search', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Was a GET reading req.query, but the AI service's /knowledge/search is
    // a POST reading req.body — also pre-existing and also fixed here; the
    // frontend's KnowledgePage already calls this as a POST, so this actually
    // makes that existing UI feature work correctly for the first time.
    const response = await axios.post(
      `${AI_URL}/api/knowledge/search`,
      { ...req.body, tenantId: req.tenantId },
      { headers: aiHeaders, timeout: 15000 }
    );
    sendSuccess(res, response.data.data);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /ai/knowledge/crawl:
 *   post:
 *     tags: [AI]
 *     summary: Crawl the tenant's own website and ingest its pages into the RAG knowledge base
 */
router.post('/knowledge/crawl', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const response = await axios.post(
      `${AI_URL}/api/knowledge/crawl`,
      { ...req.body, tenantId: req.tenantId },
      { headers: aiHeaders, timeout: 15000 }
    );
    sendSuccess(res, response.data.data);
  } catch (err) {
    next(err);
  }
});

router.get('/knowledge/crawl-status', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const response = await axios.get(`${AI_URL}/api/knowledge/crawl-status`, {
      headers: aiHeaders,
      params: { tenantId: req.tenantId },
    });
    sendSuccess(res, response.data.data);
  } catch (err) {
    next(err);
  }
});

router.delete('/knowledge/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await axios.delete(`${AI_URL}/api/knowledge/${req.params.id}`, {
      headers: aiHeaders,
      params: { tenantId: req.tenantId },
    });
    sendSuccess(res, null, 'Knowledge item deleted');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /ai/followup:
 *   post:
 *     tags: [AI]
 *     summary: Generate an AI follow-up message for a customer
 */
router.post('/followup', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const response = await axios.post(
      `${AI_URL}/api/followup`,
      { ...req.body, tenantId: req.tenantId },
      { headers: aiHeaders, timeout: 70000 }
    );
    sendSuccess(res, response.data.data, 'Followup generated');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /ai/voice/chat:
 *   post:
 *     tags: [AI]
 *     summary: Admin-only voice playground — same combined transcribe/respond/
 *       synthesize turn the public widget uses, but authenticated (a staff
 *       JWT resolves the tenant, not a widgetKey) so it can be tested without
 *       a live embedded widget on a real website.
 */
router.post(
  '/voice/chat', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), uploadAudio.single('audio'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
      if (!file) { sendError(res, 'audio file is required', 400); return; }

      const form = new FormData();
      form.append('audio', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'audio');
      form.append('tenantId', req.tenantId!);
      form.append('sessionId', (req.body?.sessionId as string) || `playground-${req.user!.userId}-${Date.now()}`);
      if (req.body?.durationSeconds) form.append('durationSeconds', String(req.body.durationSeconds));

      const response = await axios.post(`${AI_URL}/api/voice/chat`, form, { headers: aiHeaders, timeout: 100000 });
      sendSuccess(res, response.data.data, 'Voice response generated');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /ai/voice/preview:
 *   post:
 *     tags: [AI]
 *     summary: Test Voice preview — synthesizes a short sample sentence
 *       with a given Cartesia voice so a tenant admin can confirm it sounds
 *       right before it's used on a real continuous-voice call.
 */
router.post(
  '/voice/preview', authorize('SUPER_ADMIN', 'TENANT_ADMIN'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const response = await axios.post(
        `${AI_URL}/api/voice/preview`,
        { voiceId: req.body?.voiceId, text: req.body?.text },
        { headers: aiHeaders, timeout: 20000 },
      );
      sendSuccess(res, response.data.data, 'Voice preview generated');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /ai/marketing:
 *   post:
 *     tags: [AI]
 *     summary: Generate AI marketing copy for a campaign
 */
router.post('/marketing', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const response = await axios.post(
      `${AI_URL}/api/chat/marketing`,
      { ...req.body, tenantId: req.tenantId },
      { headers: aiHeaders, timeout: 70000 }
    );
    sendSuccess(res, response.data.data, 'Marketing copy generated');
  } catch (err) {
    next(err);
  }
});

export default router;
