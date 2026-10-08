import mongoose from 'mongoose';
import { Template, ITemplate } from './template.model';
import { parsePagination, buildSkip } from '../../utils/pagination';
import { Customer } from '../customers/customer.model';
import { Campaign } from '../campaigns/campaign.model';
import { AutomationRule } from '../native-crm/automation-rules/automation-rule.model';
import { AutomationFlow } from '../native-crm/automation-flows/automation-flow.model';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { sendWhatsAppNow } from '../messages/whatsapp.service';

function extractVariables(body: string): string[] {
  const matches = body.match(/\{\{([\w.]+)\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '')))];
}

export async function createTemplate(tenantId: string, data: Partial<ITemplate>): Promise<ITemplate> {
  const variables = extractVariables(data.body || '');
  return Template.create({ ...data, tenantId: new mongoose.Types.ObjectId(tenantId), variables });
}

export async function getTemplates(tenantId: string, query: Record<string, unknown>) {
  const { page, limit, sort, order } = parsePagination(query);
  const skip = buildSkip(page, limit);
  const filter: Record<string, unknown> = { tenantId, isActive: true };
  if (query.type) filter.type = query.type;
  if (query.category) filter.category = query.category;

  const [templates, total] = await Promise.all([
    Template.find(filter).sort({ [sort]: order === 'asc' ? 1 : -1 }).skip(skip).limit(limit),
    Template.countDocuments(filter),
  ]);
  return { templates, total, page, limit };
}

export async function getTemplateById(tenantId: string, id: string): Promise<ITemplate | null> {
  return Template.findOne({ _id: id, tenantId });
}

export async function updateTemplate(
  tenantId: string,
  id: string,
  data: Partial<ITemplate>
): Promise<ITemplate | null> {
  if (data.body) data.variables = extractVariables(data.body);
  return Template.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true });
}

export async function deleteTemplate(tenantId: string, id: string): Promise<void> {
  await Template.findOneAndUpdate({ _id: id, tenantId }, { isActive: false });
}

// A KNOWN variable that legitimately resolves to '' (e.g. buildVariables()'s
// `title` for a Custom Module record with no title-like field) should render
// blank, not leak the raw {{title}} syntax to whoever reads the message —
// that only happens for a genuinely UNDEFINED key (a real typo in the
// template), which is why this checks `key in variables` rather than
// truthiness.
export function renderTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{([\w.]+)\}\}/g, (match, key) => (key in variables ? variables[key] : match));
}

const DEFAULT_TEMPLATES: Array<{
  name: string; type: 'email' | 'whatsapp' | 'sms';
  category: string; subject?: string; body: string;
}> = [
  {
    name: 'Meeting Confirmation — WhatsApp', type: 'whatsapp', category: 'meeting',
    body: 'Hi {{name}},\n\nYour meeting with {{company}} is confirmed for *{{time}}*.\n\nSee you then! 👋',
  },
  {
    name: 'Meeting Confirmation — Email', type: 'email', category: 'meeting',
    subject: 'Meeting Confirmed: {{time}}',
    body: '<p>Dear {{name}},</p><p>Your meeting with <strong>{{company}}</strong> is confirmed for <strong>{{time}}</strong>.</p><p>We look forward to speaking with you!</p><p>Best regards,<br>{{company}} Team</p>',
  },
  {
    name: 'Appointment Confirmation — WhatsApp', type: 'whatsapp', category: 'appointment',
    body: 'Dear {{name}},\n\nYour appointment with {{company}} is confirmed for *{{date}}* at *{{time}}*.\n\nSee you then! 😊',
  },
  {
    name: 'Appointment Confirmation — Email', type: 'email', category: 'appointment',
    subject: 'Appointment Confirmed — {{date}} at {{time}}',
    body: '<p>Dear {{name}},</p><p>Your appointment with <strong>{{company}}</strong> is confirmed.</p><p><strong>Date:</strong> {{date}}<br><strong>Time:</strong> {{time}}</p><p>Best regards,<br>{{company}} Team</p>',
  },
  {
    name: 'Booking Confirmation — WhatsApp', type: 'whatsapp', category: 'booking',
    body: 'Hi {{name}}! 🎉\n\nYour booking with {{company}} is confirmed.\nDate & Time: *{{time}}*\n\nThank you for choosing us!',
  },
  {
    name: 'Booking Confirmation — Email', type: 'email', category: 'booking',
    subject: 'Booking Confirmed — {{company}}',
    body: '<p>Hi {{name}},</p><p>Your booking with <strong>{{company}}</strong> is confirmed for <strong>{{time}}</strong>.</p><p>Thank you for choosing us!</p><p>Regards,<br>{{company}} Team</p>',
  },
  {
    name: 'Follow-up — WhatsApp', type: 'whatsapp', category: 'followup',
    body: 'Hi {{name}}, just following up! Did you get a chance to review the information I sent? Feel free to reach out anytime. 😊',
  },
  {
    name: 'Reminder — WhatsApp', type: 'whatsapp', category: 'reminder',
    body: 'Hi {{name}}, this is a friendly reminder about your {{meeting}} on *{{date}}*. See you soon! 👋',
  },
];

export async function seedDefaultTemplates(tenantId: string): Promise<{ created: number; skipped: number }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  let created = 0;
  let skipped = 0;
  for (const tpl of DEFAULT_TEMPLATES) {
    const existing = await Template.findOne({ tenantId: tid, name: tpl.name });
    if (existing) { skipped++; continue; }
    const variables = extractVariables(tpl.body);
    await Template.create({ tenantId: tid, ...tpl, variables, language: 'en', isActive: true, aiGenerated: false });
    created++;
  }
  return { created, skipped };
}

// Mirrors deleteTemplate's shape exactly — the other half of the lifecycle
// that was previously missing (deactivate existed, reactivate didn't).
export async function activateTemplate(tenantId: string, id: string): Promise<ITemplate | null> {
  return Template.findOneAndUpdate({ _id: id, tenantId }, { isActive: true }, { new: true });
}

// Intentionally resolves via getTemplateById (no isActive filter) — a
// deactivated template can still be duplicated, same as it can still be
// resolved for sending. The duplicate is a genuinely independent document:
// no templateId anywhere points at its _id, so its usage is naturally 0.
export async function duplicateTemplate(tenantId: string, id: string): Promise<ITemplate | null> {
  const original = await getTemplateById(tenantId, id);
  if (!original) return null;
  return Template.create({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    name: `${original.name} (Copy)`,
    type: original.type,
    category: original.category,
    subject: original.subject,
    body: original.body,
    variables: original.variables,
    language: original.language,
    isActive: true,
    aiGenerated: false,
  });
}

function sampleVariablesForCustomer(customer: { name?: string; firstName?: string; lastName?: string; email?: string; phone?: string; company?: string } | null): Record<string, string> {
  if (!customer) {
    return { name: 'Sample Customer', firstName: 'Sample', lastName: 'Customer', email: 'sample@example.com', phone: '+10000000000', company: 'Sample Co' };
  }
  return {
    name: customer.name ?? '',
    firstName: customer.firstName ?? customer.name ?? '',
    lastName: customer.lastName ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    company: customer.company ?? '',
  };
}

// Render-only — no provider call, no DB write. Reuses the existing pure
// renderTemplate() so preview and real sends are guaranteed to render
// identically.
export async function previewTemplate(
  tenantId: string,
  id: string,
  sampleVariables?: Record<string, string>
): Promise<{ subject?: string; body: string } | null> {
  const template = await getTemplateById(tenantId, id);
  if (!template) return null;
  const variables = sampleVariables ?? sampleVariablesForCustomer(await Customer.findOne({ tenantId }).lean());
  return {
    subject: template.subject ? renderTemplate(template.subject, variables) : undefined,
    body: renderTemplate(template.body, variables),
  };
}

export class TemplateActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// One-off test send — touches no stats, creates no CampaignRecipient-style
// row. Only sendEmailNow can throw (Brevo API failures); sendWhatsAppNow/
// sendSmsNow never throw, they resolve to null on failure or missing config
// — same contract already established in campaign-dispatch.service.ts.
export async function testSendTemplate(tenantId: string, id: string, to: string): Promise<{ sent: boolean; reason?: string }> {
  const template = await getTemplateById(tenantId, id);
  if (!template) throw new TemplateActionError('Template not found', 404);

  const variables = sampleVariablesForCustomer(await Customer.findOne({ tenantId }).lean());
  const body = renderTemplate(template.body, variables);

  if (template.type === 'email') {
    const subject = template.subject ? renderTemplate(template.subject, variables) : 'Test message';
    try {
      const messageId = await sendEmailNow({ to, subject, htmlContent: body });
      return messageId ? { sent: true } : { sent: false, reason: 'Email is not configured for this tenant.' };
    } catch (err) {
      return { sent: false, reason: (err as Error).message };
    }
  }
  if (template.type === 'whatsapp') {
    const messageId = await sendWhatsAppNow(to, body);
    return messageId ? { sent: true } : { sent: false, reason: 'WhatsApp is not connected for this tenant — configure it in Connectors before sending a test.' };
  }
  const sid = await sendSmsNow({ to, body });
  return sid ? { sent: true } : { sent: false, reason: 'SMS is not configured for this tenant — configure your SMS provider before sending a test.' };
}

export interface TemplateUsage {
  campaigns: number;
  automationRules: number;
  automationFlows: number;
  total: number;
}

// Live aggregate, not a denormalized counter — never goes stale. The three
// consumer collections use genuinely different id representations
// (Campaign.templateId is an ObjectId ref; AutomationRule.templateId and
// AutomationFlow's per-node templateId are both plain strings), confirmed
// by direct schema reads, so this cannot be one shared helper query.
export async function getTemplateUsage(tenantId: string, id: string): Promise<TemplateUsage> {
  const [campaigns, automationRules, automationFlows] = await Promise.all([
    Campaign.countDocuments({ tenantId, templateId: new mongoose.Types.ObjectId(id) }),
    AutomationRule.countDocuments({ tenantId, templateId: id }),
    AutomationFlow.countDocuments({ tenantId, 'nodes.templateId': id }),
  ]);
  return { campaigns, automationRules, automationFlows, total: campaigns + automationRules + automationFlows };
}
