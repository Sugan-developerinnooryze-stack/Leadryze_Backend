import mongoose from 'mongoose';
import { TicketSlaPolicy, ISlaPriorityPolicy } from './ticket-sla-policy.model';
import { SlaStatus } from './ticket.types';

const DEFAULT_POLICIES: ISlaPriorityPolicy[] = [
  { priority: 'critical', firstResponseMinutes: 15,  resolutionMinutes: 240 },
  { priority: 'high',     firstResponseMinutes: 60,  resolutionMinutes: 480 },
  { priority: 'medium',   firstResponseMinutes: 240, resolutionMinutes: 1440 },
  { priority: 'low',      firstResponseMinutes: 480, resolutionMinutes: 2880 },
];
const DEFAULT_WARNING_PERCENT = 80;

/** Upsert-on-read, same pattern as pipeline-config's own getOrCreateStages —
 * first access seeds today's defaults, so existing tenants see zero change
 * until they actively edit their policy. */
export async function getOrCreateSlaPolicy(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  let doc = await TicketSlaPolicy.findOne({ tenantId: tid });
  if (!doc) {
    doc = await TicketSlaPolicy.create({ tenantId: tid, enabled: true, warningPercent: DEFAULT_WARNING_PERCENT, policies: DEFAULT_POLICIES });
  }
  return doc;
}

export async function updateSlaPolicy(
  tenantId: string, data: { enabled?: boolean; warningPercent?: number; policies?: ISlaPriorityPolicy[] },
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return TicketSlaPolicy.findOneAndUpdate(
    { tenantId: tid },
    { $set: data },
    { upsert: true, new: true, runValidators: true },
  );
}

/** Computes both SLA tiers for a ticket at the given priority, anchored to
 * `from` (creation time, or a priority-change time on update) — the
 * "warning" tier is deliberately a SEPARATE due date/dedup-field pair from
 * "breach", not one field with two derived thresholds, so a tenant can wire
 * warning -> notify assigned staff and breach -> escalate to a manager as
 * two genuinely independent automation rules (see
 * automation-rule.service.ts's scheduleStampField for the idempotency
 * mechanism both tiers share). Falls back to the 'medium' tier if this
 * ticket's priority somehow isn't in the tenant's configured policy list
 * (shouldn't happen — every tenant is seeded with all 4 — but defensive,
 * same posture as pipeline-config's getOutcomeStageKey fallback). */
export async function computeDueDates(tenantId: string, priority: string, from: Date): Promise<{
  firstResponseDueAt: Date; resolutionDueAt: Date; firstResponseWarningAt: Date; resolutionWarningAt: Date;
}> {
  const policyDoc = await getOrCreateSlaPolicy(tenantId);
  const p = policyDoc.policies.find((x) => x.priority === priority) ?? policyDoc.policies.find((x) => x.priority === 'medium') ?? DEFAULT_POLICIES[2];
  const warningFraction = (policyDoc.warningPercent ?? DEFAULT_WARNING_PERCENT) / 100;

  const firstResponseDueAt = new Date(from.getTime() + p.firstResponseMinutes * 60_000);
  const resolutionDueAt = new Date(from.getTime() + p.resolutionMinutes * 60_000);
  const firstResponseWarningAt = new Date(from.getTime() + p.firstResponseMinutes * 60_000 * warningFraction);
  const resolutionWarningAt = new Date(from.getTime() + p.resolutionMinutes * 60_000 * warningFraction);

  return { firstResponseDueAt, resolutionDueAt, firstResponseWarningAt, resolutionWarningAt };
}

/** Single source of truth for a ticket's current SLA status — used by
 * listTickets() (per-row display + the slaStatus filter's Mongo condition
 * set) AND TicketViewPage's SLA card, so the two can never drift into two
 * independent implementations of the same rule. Keys off resolutionDueAt/
 * resolutionWarningAt/resolvedAt/closedAt only — the same fields
 * ticket.service.ts's own updateTicket() already treats as the semantic
 * "is this ticket done" markers (not a separate isTerminal stage lookup),
 * for consistency with the rest of this module's conventions. A
 * resolved/closed ticket (even one resolved after breaching) reports
 * 'on_track' — once closed, it's no longer an active SLA concern for a
 * manager filtering "what still needs attention," matching the 4-state
 * on_track/warning/breached/no_sla model with no separate "done" state. */
export function deriveSlaStatus(
  ticket: {
    resolutionDueAt?: Date | string | null;
    resolutionWarningAt?: Date | string | null;
    resolvedAt?: Date | string | null;
    closedAt?: Date | string | null;
  },
  now: Date = new Date(),
): SlaStatus {
  if (ticket.resolvedAt || ticket.closedAt) return 'on_track';
  if (!ticket.resolutionDueAt) return 'no_sla';
  const nowMs = now.getTime();
  if (nowMs >= new Date(ticket.resolutionDueAt).getTime()) return 'breached';
  if (ticket.resolutionWarningAt && nowMs >= new Date(ticket.resolutionWarningAt).getTime()) return 'warning';
  return 'on_track';
}

/** The equivalent Mongo condition set for deriveSlaStatus() above, for the
 * `slaStatus` list/search filter — must stay logically equivalent to the
 * per-record function or the filter and the badge shown for the same
 * ticket could disagree. */
export function slaStatusMongoFilter(status: SlaStatus, now: Date = new Date()): Record<string, unknown> {
  const notDone = { resolvedAt: null, closedAt: null };
  switch (status) {
    case 'no_sla':
      return { resolutionDueAt: null };
    case 'breached':
      return { ...notDone, resolutionDueAt: { $ne: null, $lte: now } };
    case 'warning':
      return { ...notDone, resolutionDueAt: { $ne: null, $gt: now }, resolutionWarningAt: { $ne: null, $lte: now } };
    case 'on_track':
      return {
        $or: [
          { resolvedAt: { $ne: null } },
          { closedAt: { $ne: null } },
          { resolutionDueAt: null },
          { ...notDone, resolutionDueAt: { $ne: null, $gt: now }, $or: [{ resolutionWarningAt: null }, { resolutionWarningAt: { $gt: now } }] },
        ],
      };
    default:
      return {};
  }
}
