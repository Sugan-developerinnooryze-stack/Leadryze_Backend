import axios from 'axios';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { trackServiceUsage } from '../admin/service-usage.model';

export class WhatsAppService {
  private token: string;
  private phoneNumberId: string;
  private baseUrl = 'https://graph.facebook.com/v19.0';

  constructor(token: string, phoneNumberId: string) {
    this.token = token;
    this.phoneNumberId = phoneNumberId;
  }

  async sendMessage(to: string, message: string): Promise<string> {
    try {
      const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      };

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });

      const messageId = response.data.messages[0].id;
      logger.info('WhatsApp message sent', { messageId });
      // Same "Configured means actually working" tracking Brevo/Twilio
      // already have — this row on the Health page's API Keys table was
      // always stuck at "No activity logged yet" before, regardless of real
      // send volume, since nothing ever recorded a Meta WhatsApp send.
      void trackServiceUsage('meta', true);
      return messageId;
    } catch (error) {
      logger.error('Failed to send WhatsApp message', { error: (error as Error).message });
      void trackServiceUsage('meta', false);
      throw error;
    }
  }

  /** Meta's `type: 'document'` message — a plain `type: 'text'` send (above)
   * can never carry an attachment. `link` must be a publicly-reachable URL
   * (Meta's servers fetch it directly), which is exactly what s3.service.ts's
   * uploadToS3()/buildPublicUrl() already produce — see pdf.controller.ts's
   * shareDocumentWhatsApp() for how the PDF gets there. Like a business-
   * initiated text message, this only succeeds within Meta's 24-hour
   * customer-service window (or with an approved template message, which
   * this codebase doesn't implement yet) — Meta rejects it otherwise with a
   * real, specific error we deliberately let bubble up rather than swallow. */
  async sendDocument(to: string, doc: { link: string; filename: string; caption?: string }): Promise<string> {
    try {
      const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
      const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: { link: doc.link, filename: doc.filename, ...(doc.caption ? { caption: doc.caption } : {}) },
      };

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });

      const messageId = response.data.messages[0].id;
      logger.info('WhatsApp document sent', { messageId });
      void trackServiceUsage('meta', true);
      return messageId;
    } catch (error: any) {
      logger.error('Failed to send WhatsApp document', { error: error?.response?.data ?? (error as Error).message });
      void trackServiceUsage('meta', false);
      throw error;
    }
  }
}

/**
 * Real Meta WhatsApp Cloud API wiring — dormant until config.meta.waPhoneNumberId
 * /waAccessToken are set (no Meta Business account exists yet). Follows the
 * exact same "missing key → return null, don't throw" guard sendEmailNow
 * already uses, so callers (reminder cron, bulk-send) never need special-case
 * handling — this activates automatically the moment real credentials are
 * added, no other code changes required.
 */
// This repo's own .env ships literal placeholder values ('your-whatsapp-
// access-token', 'your-phone-number-id') rather than leaving the vars unset
// — a plain truthy check would misreport "configured" against those. Guard
// against that specific known placeholder text so the dormant/live signal
// stays accurate until real Meta credentials replace them.
const PLACEHOLDER_VALUES = new Set(['your-whatsapp-access-token', 'your-phone-number-id', '']);

export function getWhatsAppService(): WhatsAppService | null {
  const { waPhoneNumberId, waAccessToken } = config.meta;
  if (!waPhoneNumberId || !waAccessToken) return null;
  if (PLACEHOLDER_VALUES.has(waPhoneNumberId) || PLACEHOLDER_VALUES.has(waAccessToken)) return null;
  return new WhatsAppService(waAccessToken, waPhoneNumberId);
}

export async function sendWhatsAppNow(to: string, body: string): Promise<string | null> {
  const svc = getWhatsAppService();
  if (!svc) {
    logger.warn('WhatsApp not configured (no Meta credentials) — message skipped', { to });
    return null;
  }
  try {
    return await svc.sendMessage(to, body);
  } catch (err) {
    logger.error('sendWhatsAppNow failed', { to, error: (err as Error).message });
    return null;
  }
}

export function isWhatsAppConfigured(): boolean {
  return getWhatsAppService() !== null;
}

/** Unlike sendWhatsAppNow above (fire-and-forget, used by background
 * automation actions that log their own failures via writeLog and must
 * never throw), this backs a direct, user-initiated "Send via WhatsApp"
 * action that's awaited and needs a real answer — it throws, with Meta's
 * own rejection message intact when available (e.g. the actual
 * "re-engagement message" error when the customer hasn't messaged this
 * number in the last 24 hours), so the caller can show something
 * actionable instead of a generic failure. */
export async function sendWhatsAppDocumentNow(
  to: string,
  doc: { link: string; filename: string; caption?: string },
): Promise<string> {
  const svc = getWhatsAppService();
  if (!svc) throw new Error('WhatsApp is not configured for this platform yet.');
  try {
    return await svc.sendDocument(to, doc);
  } catch (err: any) {
    const metaMessage = err?.response?.data?.error?.message as string | undefined;
    throw new Error(metaMessage ?? 'Failed to send WhatsApp message.');
  }
}
