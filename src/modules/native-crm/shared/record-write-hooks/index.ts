/** Registry of the internal post-save steps per CRM assistant gateway module
 * (keys are CRM_WRITE_MODULE_MAP keys). Used only by POST
 * /api/internal/crm-write (internal.routes.ts); the screen controllers are
 * unchanged and do not import this file.
 *
 * Only these nine modules have post-save steps on their screens (every
 * other gateway-writable module's controller has none). Removing a key here
 * switches that module's chat writes back to "write + NativeCrmLog only". */

import { RecordWriteHooks } from './types';
import { contactWriteHooks } from './contact.hooks';
import { ticketWriteHooks } from './ticket.hooks';
import { taskWriteHooks } from './task.hooks';
import { invoiceWriteHooks } from './invoice.hooks';
import { workorderWriteHooks } from './workorder.hooks';
import { dealWriteHooks } from './deal.hooks';
import { customerWriteHooks } from './customer.hooks';
import { leadWriteHooks } from './lead.hooks';
import { quotationWriteHooks } from './quotation.hooks';

export const RECORD_WRITE_HOOKS: Readonly<Record<string, RecordWriteHooks>> = Object.freeze({
  contact: contactWriteHooks,
  ticket: ticketWriteHooks,
  task: taskWriteHooks,
  invoice: invoiceWriteHooks,
  workorder: workorderWriteHooks,
  deal: dealWriteHooks,
  customer: customerWriteHooks,
  lead: leadWriteHooks,
  quotation: quotationWriteHooks,
});

export function getRecordWriteHooks(module: string): RecordWriteHooks | undefined {
  return Object.prototype.hasOwnProperty.call(RECORD_WRITE_HOOKS, module) ? RECORD_WRITE_HOOKS[module] : undefined;
}
