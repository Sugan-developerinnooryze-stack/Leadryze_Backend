import mongoose, { Model } from 'mongoose';
import { hashEmail } from '../../../platform/pii/pii.service';

/** LR-LEAD-001 / LR-CONTACT-003: flags (never blocks — LR-IMP-001) a
 * create whose email or phone exactly matches an existing record in the
 * same tenant, using the same blind-index fields search already relies on
 * (emailSearch/phoneSearch) — never a same-domain or fuzzy match, per the
 * resolved product rule. Returns the existing record's own id-ish display
 * field (e.g. leadId/firstName+lastName), or null if there's no match. */
export async function findDuplicateContact(
  model: Model<any>,
  tenantId: string,
  data: { email?: string; phone?: string; mobile?: string },
  excludeId?: string,
): Promise<{ id: string; label: string } | null> {
  const or: Record<string, unknown>[] = [];
  if (data.email) {
    const rawEmail = String(data.email).trim();
    const lowerEmail = rawEmail.toLowerCase();
    or.push({ emailSearch: hashEmail(lowerEmail) });
    or.push({ email: lowerEmail });
    or.push({ email: rawEmail });
    or.push({ secondaryEmail: lowerEmail });
  }
  const phone = data.phone || data.mobile;
  if (phone) {
    const rawPhone = String(phone).trim();
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length >= 6) {
      or.push({ phoneSearch: digits });
      if (digits.length > 10) {
        or.push({ phoneSearch: digits.slice(-10) });
      } else if (digits.length === 10) {
        or.push({ phoneSearch: new RegExp(`${digits}$`) });
      }
    }
    or.push({ phone: rawPhone });
    or.push({ mobile: rawPhone });
  }
  if (!or.length) return null;

  const tid = mongoose.isValidObjectId(tenantId) ? new mongoose.Types.ObjectId(tenantId) : tenantId;
  const filter: Record<string, unknown> = {
    tenantId: { $in: [tenantId, tid] },
    $or: or,
  };
  if (excludeId) {
    const eid = mongoose.isValidObjectId(excludeId) ? new mongoose.Types.ObjectId(excludeId) : excludeId;
    filter._id = { $nin: [excludeId, eid] };
  }

  const match = await model.findOne(filter).select('_id firstName lastName leadId name customerId').lean();
  if (!match) return null;
  const m = match as any;
  const label = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.name || m.customerId || m.leadId || String(m._id);
  return { id: String(m.customerId || m.leadId || m._id), label };
}
