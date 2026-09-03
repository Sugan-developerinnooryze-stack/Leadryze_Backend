import { Request, Response } from 'express';
import crypto from 'crypto';
import { AutomationRule, IAutomationRule } from '../automation-rules/automation-rule.model';
import { AutomationFlow } from '../automation-flows/automation-flow.model';
import { runAutomationOnWebhook } from '../automation-rules/automation-rule.service';
import { runFlowOnWebhook } from '../automation-flows/automation-flow.service';
import { WebhookDelivery } from './webhook-delivery.model';
import { logSecurityEvent } from '../../logs/security-event.model';
import { logger } from '../../../utils/logger';

/** Public, unauthenticated webhook receiver — Webhook Trigger's entry point,
 * dispatching into whichever engine (AutomationRule or AutomationFlow) owns
 * the given token. Deliberately responds BEFORE even querying the database,
 * not just before the automation finishes — this makes the response
 * identical in both CONTENT and TIMING across every case (real match, wrong
 * token, disabled rule), the strongest anti-enumeration property (no DB
 * round-trip latency gap to measure), and means a slow/down Mongo can never
 * turn into a slow response or a sender-side timeout-and-retry storm. Matches
 * this codebase's own existing fire-and-forget convention (e.g.
 * deal.controller.ts's `runAutomationsOnCreate(...).catch(() => {})` firing
 * before the response is sent). */
export async function trigger(req: Request, res: Response): Promise<void> {
  res.status(202).json({ success: true, message: 'Accepted' });

  const token = req.params.token;
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

  try {
    // Idempotency: fingerprint this exact delivery (token + raw body) and
    // claim it atomically via the unique index on WebhookDelivery — a
    // duplicate-key error means an identical delivery was already accepted
    // within the TTL window (almost always a sender's retry-on-timeout,
    // since the 202 above is sent before this even runs), so it's skipped
    // rather than re-triggering the automation a second time. See
    // webhook-delivery.model.ts's own doc comment for the full reasoning.
    const fingerprint = crypto.createHash('sha256').update(`${token}:${JSON.stringify(payload)}`).digest('hex');
    try {
      await WebhookDelivery.create({ fingerprint });
    } catch (err: any) {
      if (err?.code === 11000) {
        logger.warn('Webhook delivery deduplicated — identical payload already processed', { token });
        return;
      }
      throw err;
    }

    const rule = await AutomationRule.findOne({ enabled: true, triggerType: 'webhook', webhookToken: token }).lean();
    if (rule) {
      await runAutomationOnWebhook(String(rule.tenantId), rule as unknown as IAutomationRule, payload);
      return;
    }

    const flow = await AutomationFlow.findOne({
      enabled: true, 'nodes.type': 'trigger', 'nodes.triggerType': 'webhook', 'nodes.webhookToken': token,
    });
    if (flow) {
      await runFlowOnWebhook(String(flow.tenantId), flow, payload, fingerprint);
      return;
    }

    logSecurityEvent('webhook.token_invalid', {
      ip: req.ip ?? 'unknown',
      userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
      detail: { path: req.path },
    });
  } catch (err) {
    logger.error('Webhook trigger dispatch crashed', { error: (err as Error).message });
  }
}
