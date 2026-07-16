import mongoose from 'mongoose';
import { Template, ITemplate } from './template.model';
import { parsePagination, buildSkip } from '../../utils/pagination';

function extractVariables(body: string): string[] {
  const matches = body.match(/\{\{(\w+)\}\}/g) || [];
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

export function renderTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`);
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
