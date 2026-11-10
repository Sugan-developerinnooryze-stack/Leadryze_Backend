import mongoose from 'mongoose';
import { User } from '../../auth/auth.model';
import { NativeStaff } from '../../native-crm/staffs/staff.model';
import type { EntityChoice } from '../contracts/views';
import { identityHasPermission } from '../gates';
import type { AssistIdentity } from '../identity';
import { QUERY_MAX_TIME_MS } from '../query/scoped-match';
import type { StoredRef } from '../writes/workflow-types';
import { escapeRegex } from '../../../utils/escape-regex';

/* Owners are CRM users (Increment 6, B-REF; L25): a User of the same tenant,
 * active and not SUPER_ADMIN, checked here because the services only reject
 * Field Service staff ids. Labels are "First Last", never the email: only
 * firstName and lastName are ever read (a user's email and phone are PII).
 * The owner picker is the Users screen's list (users.view, SUPER_ADMIN left
 * out), narrowed to active users. */

const HEX_ID = /^[a-f0-9]{24}$/i;
/** The owner picker offers at most this many users. */
const MAX_USERS = 10;
/** The longest name text searched, as the record pickers read it. */
const MAX_NAME_TEXT = 100;

/** A user's name as the owner fields show it: "First Last". */
function displayName(user: { firstName?: unknown; lastName?: unknown }): string {
  const name = [user.firstName, user.lastName].map((part) => (typeof part === 'string' ? part.trim() : '')).filter(Boolean).join(' ');
  return name.length > 200 ? `${name.slice(0, 199)}…` : name || 'User';
}

/** A path's value as text for $concat (empty when missing), as the entity name search reads several paths. */
const asText = (path: string) => ({ $convert: { input: path, to: 'string', onError: '', onNull: '' } });

/** users.view: whether the caller may pick an owner at all. */
export async function canPickUsers(tenantId: string, identity: AssistIdentity): Promise<boolean> {
  return identityHasPermission(tenantId, identity, 'users.view');
}

/** The user as a stored reference, or null when the id is not an active CRM user of this tenant. */
export async function crmUserRef(tenantId: string, userId: string): Promise<StoredRef | null> {
  if (typeof tenantId !== 'string' || !HEX_ID.test(tenantId) || typeof userId !== 'string' || !HEX_ID.test(userId)) return null;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const uid = new mongoose.Types.ObjectId(userId);
  const [user, staff] = await Promise.all([
    User.findOne({ _id: uid, tenantId: tid, isActive: true, role: { $ne: 'SUPER_ADMIN' } })
      .select('firstName lastName').maxTimeMS(QUERY_MAX_TIME_MS).lean(),
    // The services' own owner check (assertValidOwner): never a Field Service staff id or _id.
    NativeStaff.exists({ tenantId: tid, $or: [{ staffId: userId }, { _id: uid }] }).maxTimeMS(QUERY_MAX_TIME_MS),
  ]);
  if (!user || staff) return null;
  const id = uid.toHexString();
  return { module: 'user', id, key: id, label: displayName(user) };
}

/** The owner picker's search: at most 10, by first name. The text is escaped
 * once and matched anywhere in "First Last"; empty text lists the first users. */
export async function lookupCrmUsers(tenantId: string, q: string, limit: number = MAX_USERS): Promise<EntityChoice[]> {
  if (typeof tenantId !== 'string' || !HEX_ID.test(tenantId)) return [];
  const n = Math.min(Math.max(Math.floor(Number.isFinite(limit) ? limit : MAX_USERS), 1), MAX_USERS);
  const text = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_TEXT) : '';
  const filter: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(tenantId), isActive: true, role: { $ne: 'SUPER_ADMIN' },
  };
  if (text) {
    filter.$expr = {
      $regexMatch: { input: { $concat: [asText('$firstName'), ' ', asText('$lastName')] }, regex: escapeRegex(text), options: 'i' },
    };
  }
  const users = await User.find(filter).select('firstName lastName').sort({ firstName: 1, lastName: 1, _id: 1 })
    .limit(n).maxTimeMS(QUERY_MAX_TIME_MS).lean() as Array<{ _id: unknown; firstName?: unknown; lastName?: unknown }>;
  return (Array.isArray(users) ? users : []).map((user) => ({
    module: 'user', id: String(user._id).toLowerCase(), label: displayName(user), source: 'native_crm' as const,
  }));
}
