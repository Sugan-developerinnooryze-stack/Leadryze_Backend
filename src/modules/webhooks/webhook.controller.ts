import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { logSecurityEvent } from '../logs/security-event.model';
import {
  findHubSpotConnectorByPortalId,
  hubSpotUpsertContact,
  hubSpotUpsertCRMObject,
} from '../connectors/connector.service';
import { Customer } from '../customers/customer.model';
import { CRMRecord } from '../crm/crm-record.model';
import mongoose from 'mongoose';

export function verifyWhatsApp(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.meta.waVerifyToken) {
    logger.info('WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
}

export async function receiveWhatsApp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!config.meta.appSecret) {
      // Secret not configured — reject rather than silently accept
      res.status(503).send('Webhook secret not configured');
      return;
    }
    if (!signature) {
      res.status(401).send('Missing signature');
      return;
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(JSON.stringify(req.body)).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('WhatsApp webhook: invalid signature');
      logSecurityEvent('webhook.sig_invalid', {
        ip:        req.ip ?? 'unknown',
        userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
        detail:    { provider: 'whatsapp' },
      });
      res.status(401).send('Invalid signature');
      return;
    }

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (messages?.length) {
      for (const msg of messages) {
        logger.info('WhatsApp inbound message', {
          from: msg.from,
          type: msg.type,
          content: msg.text?.body,
          tenantPhoneId: changes.value?.metadata?.phone_number_id,
        });
      }
    }

    const statuses = changes?.value?.statuses;
    if (statuses?.length) {
      for (const status of statuses) {
        logger.info('WhatsApp status update', {
          messageId: status.id,
          status: status.status,
          recipient: status.recipient_id,
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
}

export function verifyInstagram(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.meta.waVerifyToken) {
    logger.info('Instagram webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
}

export async function receiveInstagram(req: Request, res: Response): Promise<void> {
  // Verify META app-secret signature (same scheme as WhatsApp)
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (config.meta.appSecret) {
    if (!signature) {
      res.status(401).send('Missing signature');
      return;
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(JSON.stringify(req.body)).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('Instagram webhook: invalid signature');
      logSecurityEvent('webhook.sig_invalid', {
        ip:        req.ip ?? 'unknown',
        userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
        detail:    { provider: 'instagram' },
      });
      res.status(401).send('Invalid signature');
      return;
    }
  }
  logger.info('Instagram/Messenger inbound', { body: req.body });
  res.sendStatus(200);
}

export async function receiveTwilio(req: Request, res: Response): Promise<void> {
  // Verify Twilio webhook HMAC signature using x-twilio-signature header
  const twilioSignature = req.headers['x-twilio-signature'] as string | undefined;
  const authToken = config.twilio.authToken;

  if (authToken && twilioSignature) {
    // Build the string to sign: URL + sorted param key=value pairs
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const params = req.body as Record<string, string>;
    const sortedParams = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], '');
    const expected = crypto.createHmac('sha1', authToken).update(url + sortedParams).digest('base64');
    if (!crypto.timingSafeEqual(Buffer.from(twilioSignature), Buffer.from(expected))) {
      logger.warn('Twilio webhook: invalid signature');
      logSecurityEvent('webhook.sig_invalid', {
        ip:        req.ip ?? 'unknown',
        userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
        detail:    { provider: 'twilio' },
      });
      res.status(401).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }
  } else if (!authToken) {
    logger.warn('Twilio webhook: authToken not configured — skipping signature verification');
  }

  logger.info('Twilio inbound', {
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body,
    callStatus: req.body.CallStatus,
  });
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// ── HubSpot CRM webhook (HubSpot → LeadRyze) ─────────────────────────────────

// Known standard objects — used as a fast-path fallback for webhook routing.
// Custom objects (p12345_invoice etc.) are looked up via /crm/v3/schemas dynamically.
const HS_OBJECT_MAP: Record<string, { api: string; module: string; displayField: string }> = {
  company: { api: 'companies', module: 'Companies', displayField: 'name'     },
  deal:    { api: 'deals',     module: 'Deals',     displayField: 'dealname' },
  ticket:  { api: 'tickets',   module: 'Tickets',   displayField: 'subject'  },
  product: { api: 'products',  module: 'Products',  displayField: 'name'     },
  quote:   { api: 'quotes',    module: 'Quotes',    displayField: 'hs_title' },
  invoice: { api: 'invoices',  module: 'Invoices',  displayField: 'hs_number'},
};

export async function receiveHubSpot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    if (!events.length) { res.sendStatus(200); return; }

    // Identify tenant by portalId sent in every event
    const portalId = String(events[0]?.portalId || '');
    if (!portalId) { res.sendStatus(200); return; }

    const connector = await findHubSpotConnectorByPortalId(portalId);
    if (!connector) {
      logger.warn('HubSpot webhook: no connector found for portalId', { portalId });
      res.status(400).send('Unknown portal');
      return;
    }

    // Verify signature before accepting (X-HubSpot-Signature-v3)
    const sig       = req.headers['x-hubspot-signature-v3'] as string | undefined;
    const timestamp = req.headers['x-hubspot-request-timestamp'] as string | undefined;
    if (connector.config.webhookSecret) {
      if (!sig || !timestamp) {
        logger.warn('HubSpot webhook: missing signature headers', { portalId });
        res.status(401).send('Missing signature');
        return;
      }
      const rawBody  = JSON.stringify(req.body);
      const toSign   = `POST${req.protocol}://${req.get('host')}${req.originalUrl}${rawBody}${timestamp}`;
      const expected = crypto.createHmac('sha256', connector.config.webhookSecret).update(toSign).digest('base64');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.warn('HubSpot webhook: invalid signature', { portalId });
        logSecurityEvent('webhook.sig_invalid', {
          ip:        req.ip ?? 'unknown',
          userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
          detail:    { provider: 'hubspot', portalId },
        });
        res.status(401).send('Invalid signature');
        return;
      }
    }

    // Signature verified — acknowledge HubSpot (requires 200 within 5s)
    res.sendStatus(200);

    const tenantId = String(connector.tenantId);

    // Process each event — deduplicate by objectId+subscriptionType
    const seen = new Set<string>();
    for (const event of events) {
      const key = `${event.subscriptionType}:${event.objectId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const type   = String(event.subscriptionType || '');  // e.g. "contact.propertyChange"
      const parts  = type.split('.');                        // ["contact", "propertyChange"]
      const obj    = parts[0];                               // "contact" | "company" | "deal" | "ticket"
      const action = parts[1];                               // "creation" | "propertyChange" | "deletion"
      const objectId = String(event.objectId || '');
      if (!objectId) continue;

      try {
        if (obj === 'contact') {
          if (action === 'deletion') {
            const tid = new mongoose.Types.ObjectId(tenantId);
            await Customer.findOneAndDelete({ tenantId: tid, channel: 'hubspot', externalId: objectId });
            logger.info('HubSpot webhook: contact deleted', { objectId, tenantId });
          } else {
            // creation or propertyChange — fetch full contact and upsert
            await hubSpotUpsertContact(tenantId, connector, objectId);
            logger.info('HubSpot webhook: contact upserted', { objectId, action, tenantId });
          }
        } else {
          // Resolve object type — check known map first, then look up schema dynamically
          // This handles custom objects (e.g. p12345_invoice) automatically
          let objInfo = HS_OBJECT_MAP[obj] as { api: string; module: string; displayField: string } | undefined;

          if (!objInfo) {
            // Unknown object — look up via HubSpot schema API (custom objects)
            try {
              const axios = await import('axios');
              const schemaRes = await axios.default.get(
                `https://api.hubapi.com/crm/v3/schemas/${obj}`,
                { headers: { Authorization: `Bearer ${connector.config.accessToken}` } }
              );
              const s = schemaRes.data;
              objInfo = {
                api:          s.name,
                module:       s.labels?.plural || s.name,
                displayField: s.primaryDisplayProperty || 'name',
              };
            } catch {
              logger.warn('HubSpot webhook: unknown object type, schema lookup failed', { obj });
            }
          }

          if (objInfo) {
            if (action === 'deletion') {
              const tid = new mongoose.Types.ObjectId(tenantId);
              await CRMRecord.findOneAndDelete({ tenantId: tid, channel: 'hubspot', module: objInfo.module, externalId: objectId });
              logger.info('HubSpot webhook: CRM object deleted', { obj, module: objInfo.module, objectId, tenantId });
            } else {
              await hubSpotUpsertCRMObject(tenantId, connector, objInfo.api, objInfo.module, objInfo.displayField, objectId);
              logger.info('HubSpot webhook: CRM object upserted', { obj, module: objInfo.module, objectId, action, tenantId });
            }
          }
        }
      } catch (err) {
        logger.warn('HubSpot webhook: event processing error', {
          type, objectId, err: (err as Error).message,
        });
      }
    }
  } catch (err) {
    next(err);
  }
}
