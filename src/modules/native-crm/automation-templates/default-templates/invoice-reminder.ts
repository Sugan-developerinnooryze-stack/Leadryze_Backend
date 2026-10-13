import { IDefaultTemplate } from './types';

/** Checks unpaid invoices daily; any invoice already past its due date gets
 * a WhatsApp nudge, then — if it's STILL unpaid a day later — a follow-up
 * email. "Unpaid" uses `status not_in_list "paid,cancelled"` rather than a
 * literal "overdue" stage, since invoice status is a tenant-renameable
 * free-text field (invoice.model.ts has no fixed enum), same reasoning
 * quote-followup.ts already uses for quotations. */
export const invoiceReminder: IDefaultTemplate = {
  name: 'Invoice Reminder',
  description: 'Checks daily for overdue, unpaid invoices — sends a WhatsApp reminder immediately, then a follow-up email the next day if it is still unpaid.',
  category: 'Invoice',
  triggerModule: 'invoice',
  nodes: [
    {
      id: 'n1', type: 'trigger', triggerType: 'scheduled', scheduleModule: 'invoice', scheduleCron: '0 9 * * *',
      scheduleFilter: [
        { field: 'dueDate', operator: '<', value: 'now' },
        { field: 'status', operator: 'not_in_list', value: 'paid,cancelled' },
      ],
    },
    { id: 'n2', type: 'action', actionType: 'send_whatsapp', recipientStrategy: 'record_contact' },
    { id: 'n3', type: 'delay', delayMinutes: 1440 },
    { id: 'n4', type: 'condition', conditions: [{ field: 'status', operator: 'not_in_list', value: 'paid,cancelled' }] },
    { id: 'n5', type: 'action', actionType: 'send_email', recipientStrategy: 'record_contact' },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5', fromPort: 'true' },
  ],
};
