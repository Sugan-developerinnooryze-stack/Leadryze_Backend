import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { trackServiceUsage } from '../admin/service-usage.model';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

function authHeader() {
  const creds = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
  return { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' };
}

export interface SmsOptions {
  to: string;
  body: string;
  from?: string;
}

export async function sendSmsNow(opts: SmsOptions): Promise<string | null> {
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    logger.warn('Twilio credentials not configured — SMS skipped', { to: opts.to });
    return null;
  }

  const from = opts.from || config.twilio.phoneNumber;
  const params = new URLSearchParams({ To: opts.to, From: from, Body: opts.body });

  try {
    const response = await axios.post(
      `${TWILIO_API}/Accounts/${config.twilio.accountSid}/Messages.json`,
      params.toString(),
      { headers: authHeader(), timeout: 15000 }
    );
    const sid: string = response.data?.sid || '';
    logger.info('SMS sent via Twilio', { to: opts.to, sid });
    void trackServiceUsage('twilio', true);
    return sid;
  } catch (err) {
    // Log full Twilio error body so we can see the exact error code
    const axiosErr = err as import('axios').AxiosError;
    const twilioBody = axiosErr.response?.data as Record<string, unknown> | undefined;
    logger.error('Twilio SMS failed', {
      to:        opts.to,
      from:      from,
      status:    axiosErr.response?.status,
      code:      twilioBody?.code,
      message:   twilioBody?.message,
      moreInfo:  twilioBody?.more_info,
    });
    void trackServiceUsage('twilio', false);
    return null;
  }
}

// ─── Pre-built SMS templates ──────────────────────────────────────────────────

export function buildFollowupSms(customerName: string, daysSince: number): string {
  return `Hi ${customerName}, just checking in! It's been ${daysSince} day${daysSince > 1 ? 's' : ''} since we last connected. Any questions or can we help you with anything? Reply anytime. — LeadRyze AI`;
}

export function buildWelcomeSms(customerName: string): string {
  return `Hi ${customerName}! Welcome. Our AI assistant is ready to help you 24/7. Reply anytime and we'll get back to you promptly. — LeadRyze AI`;
}

export function buildBookingConfirmationSms(customerName: string, dateTime: string): string {
  return `Hi ${customerName}, your booking is confirmed for ${dateTime}. Need to reschedule? Just reply to this message. — LeadRyze AI`;
}

export function buildReminderSms(customerName: string, dateTime: string, details: string): string {
  return `Reminder: Hi ${customerName}, your appointment is tomorrow at ${dateTime} for ${details}. See you then! — LeadRyze AI`;
}
