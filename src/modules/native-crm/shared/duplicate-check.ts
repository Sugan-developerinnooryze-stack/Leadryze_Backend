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
  if (data.email) or.push({ emailSearch: hashEmail(data.email) });
  const phone = data.phone || data.mobile;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 6) or.push({ phoneSearch: digits });
  }
  if (!or.length) return null;

  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(tenantId), $or: or };
  if (excludeId) filter._id = { $ne: excludeId };

  const match = await model.findOne(filter).select('_id firstName lastName leadId').lean();
  if (!match) return null;
  const m = match as any;
  const label = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.leadId || String(m._id);
  return { id: String(m._id), label };
}
