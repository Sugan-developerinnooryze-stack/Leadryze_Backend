import { randomBytes, randomInt } from 'crypto';
import bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { encrypt, decrypt } from '../../../utils/crypto';
import { logger } from '../../../utils/logger';

/**
 * Shared credential generator for the staff & customer mobile apps.
 * Username = first 4 letters of the name (lowercase) + 2–4 random digits.
 * Password = 10 random chars from an unambiguous alphabet.
 * Storage  = bcrypt hash (login verification) + AES-GCM encrypted copy
 *            (admin UI display) — never plaintext.
 */

const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

function usernameBase(name: string): string {
  const clean = (name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return (clean || 'user').slice(0, 4).padEnd(2, 'x');
}

export async function generateUsername(
  name: string,
  isTaken: (username: string) => Promise<boolean>,
): Promise<string> {
  const base = usernameBase(name);
  // 2-digit suffix first, widen to 3 then 4 digits if collisions persist
  for (const digits of [2, 2, 2, 3, 3, 3, 4, 4, 4, 4]) {
    const min = 10 ** (digits - 1);
    const max = 10 ** digits;
    const candidate = `${base}${randomInt(min, max)}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  // Final fallback — effectively collision-free
  return `${base}${randomBytes(3).toString('hex')}`;
}

export interface AppCredentialFields {
  appUsername:               string;
  appPasswordHash:           string;
  appPasswordEnc:            string;
  appCredentialsGeneratedAt: Date;
}

export async function buildCredentialFields(
  name: string,
  tenantId: unknown,
  model: Model<any>,
  password?: string,
): Promise<AppCredentialFields & { plainPassword: string }> {
  const isTaken = async (username: string) =>
    !!(await model.exists({ tenantId, appUsername: username }));
  const appUsername = await generateUsername(name, isTaken);
  const plainPassword = password ?? generatePassword();
  return {
    appUsername,
    appPasswordHash: await bcrypt.hash(plainPassword, 10),
    appPasswordEnc:  encrypt(plainPassword),
    appCredentialsGeneratedAt: new Date(),
    plainPassword,
  };
}

/**
 * Ensure a staff/customer document has app credentials.
 * No-op when appUsername already exists. Errors are swallowed (with a log)
 * so record creation flows are never broken by credential generation.
 */
export async function ensureCredentials(
  model: Model<any>,
  docId: unknown,
  tenantId: unknown,
  baseName: string,
): Promise<void> {
  try {
    const existing = await model.findById(docId).select('appUsername').lean();
    if (!existing || (existing as any).appUsername) return;
    const fields = await buildCredentialFields(baseName, tenantId, model);
    const { plainPassword: _pw, ...toSet } = fields;
    await model.updateOne({ _id: docId }, { $set: toSet });
  } catch (err: any) {
    logger.error('ensureCredentials failed', { docId: String(docId), message: err?.message });
  }
}

/** Decrypt the stored password copy for admin display. Returns '' when unavailable. */
export function revealPassword(appPasswordEnc?: string | null): string {
  if (!appPasswordEnc) return '';
  try { return decrypt(appPasswordEnc); } catch { return ''; }
}
