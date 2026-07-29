import mongoose from 'mongoose';
import { NativeCustomer } from '../native-crm/customers/customer.model';
import { Contact } from '../native-crm/contacts/contact.model';
import { decrypt, isEncrypted } from '../../utils/crypto';

export interface Recipient { email?: string; phone?: string; name: string; }

/**
 * Resolves who to notify for a relatedModule/relatedId pair. Only Customer
 * and Contact carry a real person's contact details today — Company has no
 * email field, and Deal/Quotation/Work Order/Contract aren't people, so
 * those resolve to null (caller skips/logs, never throws).
 *
 * Both Customer.email/phone and Contact.email/phone are PII-encrypted at
 * rest (their respective pre-save hooks) — this runs from system jobs/
 * service-layer triggers with no requesting user/role, so both branches
 * decrypt directly rather than the role-gated transformPIIResponse used for
 * HTTP responses.
 */
export async function resolveRecipient(tenantId: string, relatedModule: string, relatedId: string): Promise<Recipient | null> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  if (relatedModule === 'customer') {
    const c = await NativeCustomer.findOne({ _id: relatedId, tenantId: tid }).lean();
    if (!c) return null;
    const email = (c.email && isEncrypted(c.email) ? decrypt(c.email) : c.email) ?? undefined;
    const phone = (c.phone && isEncrypted(c.phone) ? decrypt(c.phone) : c.phone) ?? undefined;
    return { email, phone, name: c.name };
  }
  if (relatedModule === 'contact') {
    const c = await Contact.findOne({ _id: relatedId, tenantId: tid }).lean();
    if (!c) return null;
    const email = (c.email && isEncrypted(c.email) ? decrypt(c.email) : c.email) ?? undefined;
    const phone = (c.phone && isEncrypted(c.phone) ? decrypt(c.phone) : c.phone) ?? undefined;
    return { email, phone, name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'there' };
  }
  return null;
}
