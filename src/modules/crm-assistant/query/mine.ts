import type { DataScope } from '../../../types';
import type { ModuleCap } from '../registry/types';
import { queryCapsFor } from '../registry/query-caps';
import type { ExecContext } from './execute-list';
import { contactOwnerValuesFor, ownStaffIdFor, recordsCreatedBy } from './scoped-match';

/* "Mine" (plan 3.3): the grammar and the planner only ever say "mine"
 * (plan.mine 'assigned' or 'created'); what it means is decided here, per
 * module, from the verified identity and never from the plan:
 *
 *   owner_ids     the owner field holds the caller's userId or own staffId
 *                 (lead leadOwnerStaffId, deal and customer assignedStaffId:
 *                 both formats; task assignedTo and meeting assignedStaffId:
 *                 the own staffId only)
 *   staff_array   the staff list contains the own staffId (work orders)
 *   contact_owner contactOwner is the userId, "First Last" or the user's name
 *   created_by    no assignee: createdBy = userId, labelled "created by you"
 *   unsupported   the module records no owner: refused with the reason
 *
 * mode 'created' is createdBy = userId on any module that records it (not
 * meetings: their create paths never fill createdBy).
 *
 * The condition is always its own $and member next to the closed scope
 * object (scopedFilter), so it only narrows what the caller may already
 * see; it never replaces or widens the scope (the screens' ownerTab "my"
 * overwrites the scope field instead, data-scope.ts). Where that scope can
 * leave some of the caller's own records out (minePartial: tasks assigned to
 * an agent that someone else created), the answer says so instead. A caller
 * without a staff profile gets MineUnavailableError('me_unresolved') where
 * the rule needs one, never every record. The own staffId is looked up once
 * per ExecContext. */

export type MineMode = 'assigned' | 'created';

/** "Mine" can't be answered for this module and caller: no staff profile
 * where the rule needs one ('me_unresolved'), or the module records no
 * owner ('mine_unsupported'). `text` is server-written and safe to show. */
export class MineUnavailableError extends Error {
  constructor(readonly code: 'me_unresolved' | 'mine_unsupported', readonly text: string) {
    super(text);
    this.name = 'MineUnavailableError';
  }
}

export interface MineCondition {
  /** Its own $and member next to the closed scope object; never merged into it. */
  condition: Record<string, unknown>;
  /** What it means: assigned to the caller, created by the caller, or owned (contacts). */
  basis: 'assigned' | 'created' | 'owned';
}

function lowerPlural(cap: ModuleCap): string {
  return cap.labels.plural.toLowerCase();
}

/** Roles that link users to staff records themselves: the admin everyone else is told to ask. */
const STAFF_ADMIN_ROLES: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'TENANT_ADMIN']);

/** The caller has no staff profile and the module's rule needs one. An
 * admin is told where to link their own user instead of to ask an admin. */
function noStaffProfile(cap: ModuleCap, role: string): MineUnavailableError {
  const fix = STAFF_ADMIN_ROLES.has(role)
    ? 'To link one, open or add your staff record on the Staffs page under Field Service and set Linked Login to your own user.'
    : 'Ask an admin to link your user to a staff record.';
  return new MineUnavailableError('me_unresolved',
    `You don't have a staff profile, so I can't tell which ${lowerPlural(cap)} are assigned to you. ${fix}`);
}

/** The schema path of the rule's field (the registry checks at boot that it is one of the module's fields). */
function pathOf(cap: ModuleCap, field: string): string {
  return cap.fields.find((f) => f.key === field)?.path ?? field;
}

/** createdBy holds the userId of whoever created the record (every
 * controller, and the assistant's own writes, store it as a string). A
 * module whose create paths never fill it (ModuleCap.createdByRecorded:
 * meetings) is refused: "created by me" would always answer none. */
function createdByCaller(cap: ModuleCap, userId: string): MineCondition {
  if (cap.createdByRecorded === false) {
    const assignee = cap.mine.kind === 'owner_ids' || cap.mine.kind === 'staff_array';
    throw new MineUnavailableError('mine_unsupported',
      `${cap.labels.plural} don't record who created them, so I can't tell which ones you created.${assignee ? ` Ask for "my ${lowerPlural(cap)}" to see the ones assigned to you.` : ''}`);
  }
  if (!recordsCreatedBy(cap)) {
    throw new MineUnavailableError('mine_unsupported', `${cap.labels.plural} don't record who created them, so I can't tell which are yours.`);
  }
  return { condition: { createdBy: userId }, basis: 'created' };
}

/** The condition for `mode` on `cap` for the caller in `ctx`. Throws
 * MineUnavailableError when it can't be answered (see above). The ids in the
 * condition are the caller's own and only ever reach the query; nothing shown
 * to people carries them (the chip and the sentences use mineLabel). */
export async function mineCondition(cap: ModuleCap, mode: MineMode, ctx: ExecContext): Promise<MineCondition> {
  const userId = typeof ctx.identity.userId === 'string' ? ctx.identity.userId : '';
  // Verified identities always carry a userId; without one nothing can be "mine".
  if (!userId) {
    throw new MineUnavailableError('me_unresolved', `I can't tell who you are here, so I can't tell which ${lowerPlural(cap)} are yours.`);
  }
  if (mode === 'created') return createdByCaller(cap, userId);

  const rule = cap.mine;
  switch (rule.kind) {
    case 'owner_ids': {
      // Lead, deal and customer owners hold either id; task and meeting assignees the staffId only.
      const staffId = rule.match.includes('ownStaffId') ? await ownStaffIdFor(ctx) : null;
      const values = [...new Set(rule.match.map((m) => (m === 'userId' ? userId : staffId)))]
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (!values.length) throw noStaffProfile(cap, ctx.identity.role);
      return { condition: { [pathOf(cap, rule.field)]: { $in: values } }, basis: 'assigned' };
    }
    case 'staff_array': {
      const staffId = await ownStaffIdFor(ctx);
      if (!staffId) throw noStaffProfile(cap, ctx.identity.role);
      // Equality on an array field: records whose list contains the caller's staffId.
      return { condition: { [pathOf(cap, rule.field)]: staffId }, basis: 'assigned' };
    }
    case 'contact_owner':
      // A copy: the looked-up values are shared with the contact scope closure.
      return { condition: { contactOwner: { $in: [...await contactOwnerValuesFor(ctx)] } }, basis: 'owned' };
    case 'created_by':
      return createdByCaller(cap, userId);
    case 'unsupported':
      throw new MineUnavailableError('mine_unsupported', `${rule.reason} So I can't tell which ${lowerPlural(cap)} are yours.`);
    default:
      // A rule kind this code doesn't know: never every record.
      throw new MineUnavailableError('mine_unsupported', `I can't tell which ${lowerPlural(cap)} are yours.`);
  }
}

/** The chip label for `mode` on `cap`: "Assigned to you", "Owned by you" or
 * "Created by you" (no assignee, or mode 'created'). */
export function mineLabel(cap: ModuleCap, mode: MineMode): string {
  if (mode === 'created') return 'Created by you';
  switch (cap.mine.kind) {
    case 'contact_owner': return 'Owned by you';
    case 'created_by': return 'Created by you';
    default: return 'Assigned to you';
  }
}

/** True when `mode` under this scope can leave some of the caller's own
 * records out: a scope narrower than everything that doesn't always hold
 * what the mode matches (QueryCaps.mineInScope: tasks assigned to an agent
 * that someone else created, since the task scope is "created by you"). The
 * answer then says "that you can see" and carries minePartialText; the
 * scope is never widened to fill the gap. */
export function minePartial(cap: ModuleCap, mode: MineMode, scopeKind: DataScope['kind']): boolean {
  return scopeKind !== 'all' && queryCapsFor(cap.key)?.mineInScope[mode] !== true;
}

/** The mine_partial note: what the scope shows and which of the caller's own
 * records it leaves out. The same text whether or not any were left out, so
 * it is never decided by a read outside the scope. Null unless minePartial. */
export function minePartialText(cap: ModuleCap, mode: MineMode, scopeKind: DataScope['kind']): string | null {
  if (!minePartial(cap, mode, scopeKind)) return null;
  const plural = lowerPlural(cap);
  const who = scopeKind === 'team' ? 'you or your team' : 'you';
  const left = mode === 'created' ? `${plural} you created for others` : `${plural} others assigned to you`;
  switch (queryCapsFor(cap.key)?.scopeBasis) {
    case 'created': return `You can only see ${plural} ${who} created, so ${left} aren't included.`;
    case 'assigned': return `You can only see ${plural} assigned to ${who}, so ${left} aren't included.`;
    default: return `Only the ${plural} you can see are included, so some ${plural} ${mineLabel(cap, mode).toLowerCase()} may be left out.`;
  }
}
