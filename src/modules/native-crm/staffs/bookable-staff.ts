import mongoose from 'mongoose';
import { User } from '../../auth/auth.model';

/* LR-C4-USER-006 (product owner decision, 10 Nov 2026): a staff profile can
 * be linked to a login user (NativeStaff.userId). When that login user is
 * deactivated (Settings > Users), the staff profile is treated like inactive
 * staff by the website widget's booking: not listed to visitors, no
 * availability, never chosen or round-robin assigned. The staff data itself
 * is not changed, so reactivating the user makes them bookable again. Staff
 * with no linked login are unaffected. A deactivated team supervisor does not
 * stop the team (supervisors are not on the booking roster). */

type Id = string | mongoose.Types.ObjectId;
const asObjectId = (id: Id) => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id);

/** The tenant's deactivated login users. */
export async function deactivatedUserIds(tenantId: Id): Promise<mongoose.Types.ObjectId[]> {
  return (await User.find({ tenantId: asObjectId(tenantId), isActive: false }).distinct('_id')) as mongoose.Types.ObjectId[];
}

/** Narrows a NativeStaff query filter to staff not linked to a deactivated
 * login ($nin still matches staff with no linked login). The filter is left
 * as it was when the tenant has no deactivated users. */
export async function excludeDeactivatedLogins<T extends Record<string, unknown>>(filter: T, tenantId: Id): Promise<T> {
  const ids = await deactivatedUserIds(tenantId);
  if (ids.length) (filter as Record<string, unknown>).userId = { $nin: ids };
  return filter;
}

/** For a list already loaded: whether this staff profile is linked to one of
 * the given deactivated logins. */
export function linkedToDeactivatedLogin(staff: { userId?: unknown }, deactivated: mongoose.Types.ObjectId[]): boolean {
  if (!staff.userId) return false;
  const id = String(staff.userId);
  return deactivated.some((d) => String(d) === id);
}
