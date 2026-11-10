/** Contact post-save steps — from contacts/contact.controller.ts.
 * Same dependency paths as the controller (duplicate-check, contact.model).
 *
 * The controller's only internal step is the create duplicate check, which
 * flags but never blocks (LR-CONTACT-003 / LR-IMP-001). Contacts write no
 * timeline and no audit entry, on create, update or delete. */

import { findDuplicateContact } from '../duplicate-check';
import { Contact } from '../../contacts/contact.model';
import { RecordWriteHooks, CONTACT_DUPLICATE_WARNING } from './types';

/** contact.controller.ts create: the exact email/phone match. */
export function findContactDuplicate(tenantId: string, data: Record<string, unknown>) {
  return findDuplicateContact(Contact, tenantId, data);
}

/** The assistant gateway's Contact steps: a match is reported back with a
 * generic note (never the other contact's name or id) and the create goes
 * ahead, exactly like the screen. */
export const contactWriteHooks: RecordWriteHooks = {
  needsPrevOnUpdate: () => false,
  afterWriteFailureLevel: 'warn',
  async beforeCreate(ctx, data) {
    const duplicate = await findContactDuplicate(ctx.tenantId, data);
    return duplicate ? { warning: CONTACT_DUPLICATE_WARNING } : {};
  },
};
