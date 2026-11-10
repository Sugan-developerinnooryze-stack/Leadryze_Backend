import type { Model } from 'mongoose';
import { encryptPIIFields } from '../../../platform/pii/pii.service';
import { PII_FIELDS } from '../../../platform/pii/constants';

/* PII on update. Customer, Staff and Site encrypt their registered PII
 * fields (platform/pii/constants.ts) in a pre('save') hook, which a
 * findOneAndUpdate never runs, so an edited value used to be stored in
 * plaintext. preparePiiUpdate gives an update payload the treatment a new
 * record gets on create, and drops masked display values so they never
 * overwrite the real data. */

const PHONE_FIELDS = new Set(['phone', 'mobile', 'whatsapp', 'alternatePhone', 'addPhone']);
const BLIND_INDEX_FIELDS = ['phoneSearch', 'emailDomain', 'emailSearch'];

/** True for a display string the PII layer made by masking a real value
 * (masking.service.ts): email, address, GST, PAN and generic masks always
 * contain '*', and a phone becomes digits around a run of 'X'. Bullets are
 * how a screen shows a hidden value. Such a string is never written back. */
export function isMaskedPiiValue(field: string, value: string): boolean {
  if (/[*•]/.test(value)) return true;
  return PHONE_FIELDS.has(field) && /X{2,}|^\d{2}X+\d{2}$/.test(value);
}

/** The lead fields a screen may show masked (the registered lead PII, the
 * address included) plus secondaryEmail, which the lead screens treat like
 * the e-mail. A lead update drops a masked value in any of them, and the lead
 * timeline names such a field but never its value (LR-C4-LEAD-003). */
export const LEAD_MASKABLE_FIELDS: readonly string[] = [...PII_FIELDS.leads.level2, ...PII_FIELDS.leads.level3, 'secondaryEmail'];

/** What the schema's own setters do to a value on create (trim, lowercase),
 * done before encrypting so the ciphertext holds the same plaintext a new
 * record would. A number is stored as text, like the String path casts it. */
function normaliseLikeSchema(model: Model<any>, field: string, value: unknown): unknown {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return text;
  const path: any = model.schema.path(field);
  const options = (path?.caster ?? path)?.options ?? {};
  let out = text;
  if (options.trim) out = out.trim();
  if (options.lowercase) out = out.toLowerCase();
  return out;
}

/** The update to write for `module`'s model. Registered PII fields holding a
 * masked display value are dropped (an array field when any item is
 * masked); the remaining values are normalised like the schema does and
 * encrypted by the same encryptPIIFields the pre('save') hook runs, with the
 * blind-index fields the model keeps. An update with no registered PII field
 * is returned as is, and `data` itself is never changed. */
export function preparePiiUpdate<T extends Record<string, any>>(data: T, module: string, model: Model<any>): T {
  const def = PII_FIELDS[module];
  if (!def || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  const fields = [...def.level2, ...def.level3].filter((f) => Object.prototype.hasOwnProperty.call(data, f));
  if (!fields.length) return data;

  const out: Record<string, any> = { ...data };
  for (const field of fields) {
    const value = out[field];
    if (Array.isArray(value)) {
      if (value.some((v) => typeof v === 'string' && isMaskedPiiValue(field, v))) delete out[field];
      else out[field] = value.map((v) => normaliseLikeSchema(model, field, v));
    } else if (typeof value === 'string' && isMaskedPiiValue(field, value)) {
      delete out[field];
    } else {
      out[field] = normaliseLikeSchema(model, field, value);
    }
  }

  const encrypted: Record<string, any> = { ...out };
  encryptPIIFields(encrypted, module);
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(out, field)) out[field] = encrypted[field];
  }
  for (const key of BLIND_INDEX_FIELDS) {
    if (encrypted[key] === out[key]) continue;
    // Staff and Site keep no blind index.
    if (!model.schema.path(key)) continue;
    // encryptPIIFields takes phoneSearch from `phone ?? mobile`. Without a
    // phone in the update that is the mobile, while the record may have a
    // phone the index was built from, so it is left alone.
    if (key === 'phoneSearch' && out.phone === undefined) continue;
    out[key] = encrypted[key];
  }
  return out as T;
}
