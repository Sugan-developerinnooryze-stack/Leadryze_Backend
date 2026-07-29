import axios from 'axios';
import { logger } from '../../utils/logger';
import { config } from '../../config';

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
      return messageId;
    } catch (error) {
      logger.error('Failed to send WhatsApp message', { error: (error as Error).message });
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
