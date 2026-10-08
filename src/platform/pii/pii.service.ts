import { createHash } from 'crypto';
import { encrypt, decrypt, isEncrypted } from '../../utils/crypto';
import { PII_FIELDS, ADMIN_ROLES } from './constants';
import { maskField } from './masking.service';

/** One-way, non-reversible — lets a search query check "is there a row
 * whose real email equals X" via an exact hash match, without ever storing
 * (or letting this field leak back into) the plaintext email itself.
 * Exported so a search query (lead.service.ts/contact.service.ts) can hash
 * the user's typed search term the same way to compare against it. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Encrypts all PII fields on an object in-place before saving to MongoDB.
 * Uses isEncrypted() guard to prevent double-encryption.
 */
export function encryptPIIFields(obj: Record<string, any>, module: string): void {
  const def = PII_FIELDS[module];
  if (!def) return;

  // LR-LEAD-005: capture these BEFORE the encryption loop below overwrites
  // obj.phone/obj.email in place — deriving the blind-index fields
  // afterward was reading ciphertext, not the real value. If the field is
  // already ciphertext (unchanged since a prior save), skip deriving —
  // recomputing from ciphertext digits would corrupt the index a prior,
  // correct save already produced.
  const phoneValRaw = obj['phone'] ?? obj['mobile'];
  const emailValRaw = obj['email'];
  const phoneIsPlain = typeof phoneValRaw === 'string' && phoneValRaw.trim() !== '' && !isEncrypted(phoneValRaw);
  const emailIsPlain = typeof emailValRaw === 'string' && emailValRaw.trim() !== '' && !isEncrypted(emailValRaw);

  const allFields = [...def.level2, ...def.level3];
  for (const field of allFields) {
    const val = obj[field];
    if (Array.isArray(val)) {
      obj[field] = val.map((v) =>
        (v && typeof v === 'string' && v.trim() !== '' && !isEncrypted(v)) ? encrypt(v) : v
      );
    } else if (val && typeof val === 'string' && val.trim() !== '' && !isEncrypted(val)) {
      obj[field] = encrypt(val);
    }
  }

  // Derive phoneSearch (full digits — a prefix-anchored search regex needs
  // the complete number, not a truncated slice, to match a fully-typed
  // search term) and emailDomain for search compatibility.
  if (phoneIsPlain) {
    const digits = phoneValRaw.replace(/\D/g, '');
    if (digits.length >= 6) {
      obj['phoneSearch'] = digits;
    }
  }
  if (emailIsPlain && emailValRaw.includes('@')) {
    obj['emailDomain'] = emailValRaw.split('@')[1]?.toLowerCase() ?? '';
    // LR-LEAD-005: exact-match blind index — restores "search by email" for
    // a correctly-encrypted row (a plain regex against the ciphertext
    // column can never match a typed-out email) without storing it back in
    // reversible form.
    obj['emailSearch'] = hashEmail(emailValRaw);
  }
}

/**
 * After fetching from DB, transforms items:
 *   - Admin roles → decrypt all PII fields
 *   - Roles in piiViewRoles → decrypt Level 2 only (mask Level 3)
 *   - Others → mask all PII fields
 */
export function transformPIIResponse(
  items: any | any[],
  module: string,
  userRole: string,
  piiViewRoles: string[],
): any | any[] {
  const def = PII_FIELDS[module];
  if (!def) return items;

  const isAdmin   = ADMIN_ROLES.includes(userRole);
  const canViewL2 = isAdmin || piiViewRoles.includes(userRole);

  const transform = (item: any): any => {
    if (!item || typeof item !== 'object') return item;

    // Work with plain object (handles Mongoose docs and POJOs)
    const plain: Record<string, any> = typeof item.toObject === 'function'
      ? item.toObject()
      : { ...item };

    // Level 2 fields
    for (const field of def.level2) {
      const val = plain[field];
      if (Array.isArray(val)) {
        plain[field] = val.map((v) => (v && typeof v === 'string') ? revealOrMask(field, v, canViewL2) : v);
        continue;
      }
      if (!val || typeof val !== 'string') continue;
      plain[field] = revealOrMask(field, val, canViewL2);
    }

    // Level 3 fields
    for (const field of def.level3) {
      const val = plain[field];
      if (Array.isArray(val)) {
        plain[field] = val.map((v) => (v && typeof v === 'string') ? revealOrMask(field, v, isAdmin) : v);
        continue;
      }
      if (!val || typeof val !== 'string') continue;
      plain[field] = revealOrMask(field, val, isAdmin);
    }

    // Remove internal search fields from API response
    delete plain['phoneSearch'];
    delete plain['emailDomain'];

    return plain;
  };

  return Array.isArray(items) ? items.map(transform) : transform(items);
}

/** Decrypts a stored value if needed, then either reveals it or masks it. */
function revealOrMask(field: string, val: string, reveal: boolean): string {
  const real = isEncrypted(val) ? safeDecrypt(val, field) : val;
  return reveal ? real : maskField(field, real);
}

function safeDecrypt(val: string, field: string): string {
  try {
    return decrypt(val);
  } catch {
    return val; // return as-is if decryption fails
  }
}
