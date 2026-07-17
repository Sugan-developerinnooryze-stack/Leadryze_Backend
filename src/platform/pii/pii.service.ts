import { encrypt, decrypt, isEncrypted } from '../../utils/crypto';
import { PII_FIELDS, ADMIN_ROLES } from './constants';
import { maskField } from './masking.service';

/**
 * Encrypts all PII fields on an object in-place before saving to MongoDB.
 * Uses isEncrypted() guard to prevent double-encryption.
 */
export function encryptPIIFields(obj: Record<string, any>, module: string): void {
  const def = PII_FIELDS[module];
  if (!def) return;

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

  // Derive phoneSearch (first 6 digits) and emailDomain for search compatibility
  const phoneVal = obj['phone'] ?? obj['mobile'];
  if (phoneVal && typeof phoneVal === 'string') {
    const digits = phoneVal.replace(/\D/g, '');
    if (digits.length >= 6) {
      obj['phoneSearch'] = digits.slice(0, 6);
    }
  }
  const emailVal = obj['email'];
  if (emailVal && typeof emailVal === 'string' && emailVal.includes('@')) {
    obj['emailDomain'] = emailVal.split('@')[1]?.toLowerCase() ?? '';
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
