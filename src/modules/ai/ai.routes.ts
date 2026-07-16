import { Router, Response, NextFunction } from 'express';
import axios from 'axios';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess } from '../../utils/response';
import { config } from '../../config';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: AI
 *   description: AI chat and knowledge base (proxied to AI microservice)
 */

router.use(authenticate, requireTenant);

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
    const response = await axios.post(
      `${AI_URL}/api/chat`,
      { ...req.body, tenantId: req.tenantId },
      { headers: aiHeaders, timeout: 70000 }
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
    const response = await axios.post(
      `${AI_URL}/api/knowledge`,
      { ...req.body, tenantId: req.tenantId },
      { headers: aiHeaders, timeout: 60000 }
    );
    sendSuccess(res, response.data.data, 'Knowledge ingested');
  } catch (err) {
    next(err);
  }
});

router.get('/knowledge/search', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const response = await axios.get(`${AI_URL}/api/knowledge/search`, {
      headers: aiHeaders,
      params: { tenantId: req.tenantId, ...req.query },
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
