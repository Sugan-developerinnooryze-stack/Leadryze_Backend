/** Lead post-save steps — from leads/lead.controller.ts.
 * Same dependency paths as the controller (mongoose, timeline.model, crypto,
 * audit-log.model, lead.model, team-resolution, duplicate-check).
 *
 * Moved logic: the create duplicate check (:142, :147), lastActivityAt on
 * create (:154), the "created" timeline (:156-164), the server-side team
 * re-resolution on an owner change (:181-187), the "reassigned" /
 * "status_changed" / "updated" timelines in that order (:192-311) and the
 * delete audit (:375-387). Lead timeline writes go straight to
 * NativeTimeline.create (module 'leads', ObjectId tenantId) and are AWAITED,
 * as on the screen. Lead deletes write no timeline.
 *
 * Since Increment 6 (D25, L24) the won-stage auto-lock of PATCH /:id/stage
 * (updateStage :353-356) also applies to an update that MOVES the lead to
 * the won stage: lockLeadIfWon, run after the timelines. Unlike the screen,
 * the "updated" entry names a changed PII field without its values (D29).
 *
 * NOT part of this module: the automations (:165, :216, :313, :357, :374),
 * the allowDuplicate / skipDuplicates overrides (:143-146), the rest of
 * what PATCH /:id/stage does (updateStage :331-368), conversions and
 * export. */

import mongoose from 'mongoose';
import { NativeTimeline } from '../../timeline/timeline.model';
import { decrypt, isEncrypted } from '../../../../utils/crypto';
import { logAuditEvent } from '../../../logs/audit-log.model';
import { Lead } from '../../leads/lead.model';
import { resolveTeamFromStaffId } from '../team-resolution';
import { findDuplicateContact } from '../duplicate-check';
import { autoLockIfConfigured } from '../../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../../pipeline-config/pipeline-config.service';
import { PII_FIELDS } from '../../../../platform/pii/constants';
import { AuditActor, RecordWriteHooks, WriteOrigin, withOrigin, LEAD_DUPLICATE_MESSAGE } from './types';

/** The lead fields masked for roles that may not view them: the timeline names them, never their values. */
const LEAD_PII_KEYS: ReadonlySet<string> = new Set([...PII_FIELDS.leads.level2, ...PII_FIELDS.leads.level3]);

/** lead.controller.ts create: the exact email/phone match. */
export function findLeadDuplicate(tenantId: string, data: Record<string, unknown>) {
  return findDuplicateContact(Lead, tenantId, data);
}

/** lead.controller.ts create: fields the server adds to every new lead. The
 * default list sort is lastActivityAt descending, and createLead does not
 * set it. */
export function leadCreateDefaults(): { lastActivityAt: Date } {
  return { lastActivityAt: new Date() };
}

/** lead.controller.ts create: the "created" timeline entry (awaited). The
 * screen writes no metadata; the assistant writes { via }. */
export function logLeadCreated(tenantId: string, item: any, userId: string | undefined, origin: WriteOrigin) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const metadata = withOrigin(undefined, origin);
  return NativeTimeline.create({
    tenantId:     tid,
    entityModule: 'leads',
    entityId:     item._id.toString(),
    action:       'created',
    description:  `Lead ${item.leadId} created`,
    performedBy:  userId,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

/** lead.controller.ts update: a real staff-owner reassignment — a
 * leadOwnerStaffId in the body that differs from prev's. */
export function isLeadReassignment(prev: any, body: Record<string, any>): boolean {
  return !!(prev && body.leadOwnerStaffId !== undefined
    && body.leadOwnerStaffId !== prev.leadOwnerStaffId);
}

/** lead.controller.ts update, before the write: on a reassignment, resolve
 * the new owner's teamId/teamName server-side and put them on the SAME body
 * object that is then written (both keys present, undefined when the staff
 * member has no team). Returns whether this is a reassignment. */
export async function resolveLeadReassignment(tenantId: string, prev: any, body: Record<string, any>): Promise<boolean> {
  const isReassignment = isLeadReassignment(prev, body);
  if (isReassignment) {
    const { teamId, teamName } = await resolveTeamFromStaffId(tenantId, body.leadOwnerStaffId);
    body.teamId = teamId ?? undefined;
    body.teamName = teamName ?? undefined;
  }
  return isReassignment;
}

/** lead.controller.ts update: the "reassigned" timeline entry (awaited). */
export function logLeadReassigned(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const prevOwner = prev!.leadOwner || prev!.leadOwnerStaffId || 'Unassigned';
  const newOwner = item.leadOwner || body.leadOwnerStaffId || 'Unassigned';
  return NativeTimeline.create({
    tenantId:     tid,
    entityModule: 'leads',
    entityId:     item._id.toString(),
    action:       'reassigned',
    description:  `Reassigned from ${prevOwner} to ${newOwner} by ${userId ?? 'system'}`,
    performedBy:  userId,
    metadata:     withOrigin({ previousStaffId: prev!.leadOwnerStaffId, newStaffId: body.leadOwnerStaffId, teamId: body.teamId, teamName: body.teamName }, origin),
  });
}

/** lead.controller.ts update: the "status_changed" timeline entry (awaited),
 * only when the status really changed. Returns whether it changed (the
 * screen fires runAutomations only then). */
export async function logLeadStatusChange(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
): Promise<boolean> {
  if (prev && body.status && body.status !== prev.status) {
    const tid = new mongoose.Types.ObjectId(tenantId);
    await NativeTimeline.create({
      tenantId:     tid,
      entityModule: 'leads',
      entityId:     item._id.toString(),
      action:       'status_changed',
      description:  `Status changed from ${prev.status} → ${body.status}`,
      performedBy:  userId,
      metadata:     withOrigin({ from: prev.status, to: body.status }, origin),
    });
    return true;
  }
  return false;
}

/** lead.controller.ts update (LR-UI-002): one "updated" timeline entry
 * listing the fields that really changed (awaited). Internal/system keys
 * and the fields with their own entries are ignored. Unlike the screen, a
 * changed PII field (PII_FIELDS.leads) is named without its old or new
 * value: the timeline is shown to roles that may not view it (D29). */
export async function logLeadFieldChanges(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
): Promise<void> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  // LR-UI-002: Enumerate specifically updated fields instead of a generic "Lead details updated"
  // Filter out internal/system keys and fields handled by separate timeline entries (reassigned, status_changed).
  const IGNORE_FIELDS = new Set([
    '_id', 'tenantId', '__v', 'updatedAt', 'createdAt', 'status', 'version',
    'lastActivityAt', 'conversionHistory', 'isConverted', 'convertedCustomerId', 'convertedAt',
    'contactId', 'opportunityId', 'emailSearch', 'phoneSearch', 'emailDomain',
    'leadId', 'numId', 'clientId', 'branchId', 'teamId', 'teamName', 'leadOwnerStaffId',
  ]);
  const changedFields: string[] = [];
  let singleOldVal = '';
  let singleNewVal = '';

  if (prev) {
    const prevObj = (prev as any).toObject ? (prev as any).toObject() : prev;
    for (const [k, v] of Object.entries(body)) {
      if (IGNORE_FIELDS.has(k) || v === undefined) continue;

      let prevVal = prevObj[k];
      if (typeof prevVal === 'string' && isEncrypted(prevVal)) {
        try {
          prevVal = decrypt(prevVal);
        } catch {
          // Keep as-is if decrypt fails
        }
      }

      let isChanged = false;
      let oldStr = '';
      let newStr = '';

      if (Array.isArray(v)) {
        const oldArr = Array.isArray(prevVal) ? prevVal.map(String).sort() : [];
        const newArr = v.map(String).sort();
        if (JSON.stringify(oldArr) !== JSON.stringify(newArr)) {
          isChanged = true;
        }
      } else if (typeof v === 'number') {
        if (Number(prevVal ?? 0) !== v) {
          isChanged = true;
          oldStr = String(prevVal ?? '');
          newStr = String(v);
        }
      } else if (k === 'email' || k === 'secondaryEmail') {
        const sOld = String(prevVal ?? '').trim().toLowerCase();
        const sNew = String(v ?? '').trim().toLowerCase();
        if (sOld !== sNew) {
          isChanged = true;
          oldStr = String(prevVal ?? '').trim();
          newStr = String(v ?? '').trim();
        }
      } else if (typeof v === 'object' && v !== null) {
        if (JSON.stringify(v) !== JSON.stringify(prevVal ?? {})) {
          isChanged = true;
        }
      } else {
        const sOld = String(prevVal ?? '').trim();
        const sNew = String(v ?? '').trim();
        if (sOld !== sNew) {
          isChanged = true;
          oldStr = sOld;
          newStr = sNew;
        }
      }

      if (isChanged) {
        changedFields.push(k);
        const pii = LEAD_PII_KEYS.has(k);
        singleOldVal = pii ? '' : oldStr;
        singleNewVal = pii ? '' : newStr;
      }
    }
  }

  if (changedFields.length > 0) {
    const formattedFields = changedFields.map((f) => f.replace(/([A-Z])/g, ' $1').toLowerCase().trim());
    let desc = `Updated: ${formattedFields.join(', ')}`;
    const metadata: Record<string, any> = { changedFields: formattedFields };

    if (changedFields.length === 1 && singleOldVal && singleNewVal && singleOldVal.length <= 30 && singleNewVal.length <= 30) {
      desc = `Updated ${formattedFields[0]}: ${singleOldVal} → ${singleNewVal}`;
      metadata.from = singleOldVal;
      metadata.to = singleNewVal;
    }

    await NativeTimeline.create({
      tenantId:     tid,
      entityModule: 'leads',
      entityId:     item._id.toString(),
      action:       'updated',
      description:  desc,
      performedBy:  userId,
      metadata:     withOrigin(metadata, origin),
    });
  }
}

/** lead.controller.ts updateStage (:353-356), applied to an update (D25,
 * L24): when the update MOVES the lead to the tenant's won stage, the won
 * key is looked up (awaited) and the record auto-locks if the tenant set
 * auto-lock up (fire-and-forget; a failed lock goes to onLockError). An
 * unchanged status is not a move (both kanbans only send real moves); with
 * no prev (the pre-read failed) the move is assumed, as PATCH does. No
 * status in the body: no lookup. Never runAutomations (:357). */
export async function lockLeadIfWon(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined,
  onLockError: (err: unknown) => void = () => {},
): Promise<void> {
  if (!body.status) return;
  if (prev && prev.status === body.status) return;
  const wonKey = await getOutcomeStageKey(tenantId, 'lead', 'won', 'won');
  if (body.status === wonKey) {
    autoLockIfConfigured(tenantId, 'leads', String(item._id), wonKey, userId ?? 'system').catch(onLockError);
  }
}

/** lead.controller.ts remove: the lead.deleted audit event. */
export function auditLeadDeleted(tenantId: string, actor: AuditActor, item: any, origin: WriteOrigin): Promise<void> {
  return logAuditEvent('lead.deleted',
    actor,
    {
      tenantId,
      target: 'Lead',
      targetId: item.leadId ?? String(item._id),
      detail: withOrigin({
        leadId: item.leadId,
        name: `${item.firstName} ${item.lastName}`,
        before: { leadId: item.leadId, name: `${item.firstName} ${item.lastName}`, status: item.status },
      }, origin),
    },
  );
}

/** The assistant gateway's Lead steps. A duplicate is refused (409) with a
 * generic message that never names or points to the other lead. The three
 * update timelines run in the screen's order and stop at the first failure,
 * as the screen's sequential awaits do; the won-stage lock then runs
 * whatever happened to them. */
export const leadWriteHooks: RecordWriteHooks = {
  // Reassignment, status change and the changed-field list all read prev.
  needsPrevOnUpdate: () => true,
  // The screen turns a failed lead timeline write into a 400 after the lead
  // was saved; the gateway keeps its 200 (the write did happen) and logs an
  // error instead — see internal.routes.ts.
  afterWriteFailureLevel: 'error',
  async beforeCreate(ctx, data) {
    const duplicate = await findLeadDuplicate(ctx.tenantId, data);
    if (duplicate) return { block: { status: 409, message: LEAD_DUPLICATE_MESSAGE } };
    return { extraFields: leadCreateDefaults() };
  },
  async beforeUpdate(ctx, prev, payload) {
    await resolveLeadReassignment(ctx.tenantId, prev, payload);
  },
  async afterCreate(ctx, item) {
    await logLeadCreated(ctx.tenantId, item, ctx.userId, ctx.origin);
  },
  async afterUpdate(ctx, item, prev, payload) {
    try {
      // Same result as the screen's pre-write flag: prev and the owner key
      // are not changed by the write (only teamId/teamName were added).
      if (isLeadReassignment(prev, payload)) {
        await logLeadReassigned(ctx.tenantId, item, prev, payload, ctx.userId, ctx.origin);
      }
      await logLeadStatusChange(ctx.tenantId, item, prev, payload, ctx.userId, ctx.origin);
      await logLeadFieldChanges(ctx.tenantId, item, prev, payload, ctx.userId, ctx.origin);
    } finally {
      // The lock never depends on a timeline write succeeding (D25). A
      // failed key lookup is swallowed here, so a timeline error, if any,
      // stays the one the gateway logs.
      await lockLeadIfWon(ctx.tenantId, item, prev, payload, ctx.userId, ctx.swallow('lead.autoLock'))
        .catch(ctx.swallow('lead.autoLock'));
    }
  },
  async afterDelete(ctx, item) {
    const actor = await ctx.getAuditActor();
    await auditLeadDeleted(ctx.tenantId, actor, item, ctx.origin);
  },
};
