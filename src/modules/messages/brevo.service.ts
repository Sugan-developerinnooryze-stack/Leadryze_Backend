import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { trackServiceUsage } from '../admin/service-usage.model';

const BREVO_API = 'https://api.brevo.com/v3';

function headers() {
  return {
    'api-key': config.brevo.apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export interface EmailAttachment {
  name:    string;
  content: string; // base64
}

export interface EmailOptions {
  to: string;
  toName?: string;
  cc?: string[];
  subject: string;
  htmlContent: string;
  textContent?: string;
  attachment?: EmailAttachment[];
}

export async function sendEmailNow(opts: EmailOptions): Promise<string | null> {
  if (!config.brevo.apiKey) {
    logger.warn('Brevo API key not configured — email skipped', { to: opts.to });
    return null;
  }

  try {
    const response = await axios.post(
      `${BREVO_API}/smtp/email`,
      {
        sender: { name: config.brevo.senderName, email: config.brevo.senderEmail },
        to: [{ email: opts.to, name: opts.toName || opts.to }],
        subject: opts.subject,
        htmlContent: opts.htmlContent,
        ...(opts.textContent ? { textContent: opts.textContent } : {}),
        ...(opts.cc?.length ? { cc: opts.cc.map((email) => ({ email })) } : {}),
        ...(opts.attachment?.length ? { attachment: opts.attachment } : {}),
      },
      { headers: headers(), timeout: 15000 }
    );
    const messageId: string = response.data?.messageId || '';
    logger.info('Email sent via Brevo', { to: opts.to, subject: opts.subject, messageId });
    void trackServiceUsage('brevo', true);
    return messageId;
  } catch (err) {
    logger.error('Brevo email failed', { to: opts.to, error: (err as Error).message });
    void trackServiceUsage('brevo', false);
    throw err;
  }
}

// ─── Pre-built templates ──────────────────────────────────────────────────────

export function buildFollowupEmail(customerName: string, agentName: string, daysSince: number): EmailOptions {
  return {
    to: '',
    subject: `Following up — ${agentName}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#1a1a2e">Hi ${customerName},</h2>
        <p>I wanted to follow up since we haven't connected in ${daysSince} day${daysSince > 1 ? 's' : ''}.</p>
        <p>If you have any questions or need assistance, I'm here to help. Feel free to reply to this email or reach out anytime.</p>
        <br/>
        <p>Best regards,<br/><strong>${agentName}</strong><br/>${config.brevo.senderName}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#999;font-size:12px">You're receiving this because you enquired with us. To unsubscribe, reply with "unsubscribe".</p>
      </div>
    `,
  };
}

export function buildWelcomeEmail(customerName: string): EmailOptions {
  return {
    to: '',
    subject: `Welcome to ${config.brevo.senderName}!`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#1a1a2e">Welcome, ${customerName}!</h2>
        <p>Thank you for getting in touch. Our AI assistant is ready to help you 24/7.</p>
        <p>Here's what we can help you with:</p>
        <ul>
          <li>Answering your questions instantly</li>
          <li>Booking appointments</li>
          <li>Product and pricing information</li>
        </ul>
        <p>Reply to this email anytime — we'll get back to you promptly.</p>
        <br/>
        <p>Best regards,<br/><strong>${config.brevo.senderName}</strong></p>
      </div>
    `,
  };
}

export function buildBookingConfirmationEmail(
  customerName: string,
  dateTime: string,
  details: string
): EmailOptions {
  return {
    to: '',
    subject: `Booking Confirmed — ${dateTime}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#1a1a2e">Booking Confirmed!</h2>
        <p>Hi ${customerName}, your booking has been confirmed.</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:0"><strong>Date & Time:</strong> ${dateTime}</p>
          <p style="margin:8px 0 0"><strong>Details:</strong> ${details}</p>
        </div>
        <p>We look forward to seeing you. If you need to reschedule, please reply to this email.</p>
        <br/>
        <p>Best regards,<br/><strong>${config.brevo.senderName}</strong></p>
      </div>
    `,
  };
}

// Legacy class-based API (kept for backward compatibility)
export class BrevoService {
  async sendEmail(to: string, subject: string, htmlContent: string): Promise<boolean> {
    await sendEmailNow({ to, subject, htmlContent });
    return true;
  }
}
