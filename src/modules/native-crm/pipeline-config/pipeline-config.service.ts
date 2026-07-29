import mongoose from 'mongoose';
import { PipelineConfig, IPipelineStage, PipelineModule, BuiltInPipelineModule } from './pipeline-config.model';

/**
 * Today's hardcoded stage lists, used ONLY to seed a tenant's first-ever
 * PipelineConfig read — this is what makes the rollout non-breaking: every
 * existing tenant sees exactly the same stages they have today until they
 * actively edit them. New modules can be added here as Phase 2 extends
 * coverage to Field Service.
 *
 * Custom Modules (`custom:<slug>`) deliberately have no entry here — a
 * brand-new custom module has no pre-existing hardcoded behavior to
 * preserve, so it correctly starts with zero stages until the tenant adds
 * their own (see getOrCreateStages' `?? []` fallback below).
 */
const DEFAULT_STAGES: Record<BuiltInPipelineModule, IPipelineStage[]> = {
  lead: [
    { key: 'new',               label: 'New',               color: '#6366f1', order: 0, isTerminal: false, outcome: null,   isActive: true },
    { key: 'contacted',         label: 'Contacted',         color: '#0ea5e9', order: 1, isTerminal: false, outcome: null,   isActive: true },
    { key: 'qualified',         label: 'Qualified',         color: '#f59e0b', order: 2, isTerminal: false, outcome: null,   isActive: true },
    { key: 'meeting_scheduled', label: 'Meeting Scheduled', color: '#8b5cf6', order: 3, isTerminal: false, outcome: null,   isActive: true },
    { key: 'proposal_sent',     label: 'Proposal Sent',     color: '#ec4899', order: 4, isTerminal: false, outcome: null,   isActive: true },
    { key: 'negotiation',       label: 'Negotiation',       color: '#f97316', order: 5, isTerminal: false, outcome: null,   isActive: true },
    { key: 'won',               label: 'Won',               color: '#10b981', order: 6, isTerminal: true,  outcome: 'won',  isActive: true },
    { key: 'lost',              label: 'Lost',              color: '#ef4444', order: 7, isTerminal: true,  outcome: 'lost', isActive: true },
    { key: 'on_hold',           label: 'On Hold',            color: '#94a3b8', order: 8, isTerminal: false, outcome: null,  isActive: true },
    { key: 'disqualified',      label: 'Disqualified',      color: '#64748b', order: 9, isTerminal: true,  outcome: null,   isActive: true },
  ],
  deal: [
    { key: 'prospect',    label: 'Prospect',    color: '#6366f1', order: 0, isTerminal: false, outcome: null,   isActive: true },
    { key: 'qualified',   label: 'Qualified',   color: '#0ea5e9', order: 1, isTerminal: false, outcome: null,   isActive: true },
    { key: 'proposal',    label: 'Proposal',    color: '#f59e0b', order: 2, isTerminal: false, outcome: null,   isActive: true },
    { key: 'negotiation', label: 'Negotiation', color: '#f97316', order: 3, isTerminal: false, outcome: null,   isActive: true },
    { key: 'closed_won',  label: 'Closed Won',  color: '#10b981', order: 4, isTerminal: true,  outcome: 'won',  isActive: true },
    { key: 'closed_lost', label: 'Closed Lost', color: '#ef4444', order: 5, isTerminal: true,  outcome: 'lost', isActive: true },
  ],
  task: [
    { key: 'todo',        label: 'To Do',        color: '#6366f1', order: 0, isTerminal: false, outcome: null, isActive: true },
    { key: 'in_progress', label: 'In Progress',  color: '#f59e0b', order: 1, isTerminal: false, outcome: null, isActive: true },
    { key: 'done',        label: 'Done',         color: '#10b981', order: 2, isTerminal: true,  outcome: null, isActive: true },
    { key: 'cancelled',   label: 'Cancelled',    color: '#94a3b8', order: 3, isTerminal: true,  outcome: null, isActive: true },
  ],
  ticket: [
    { key: 'open',        label: 'Open',         color: '#0ea5e9', order: 0, isTerminal: false, outcome: null, isActive: true },
    { key: 'in_progress', label: 'In Progress',  color: '#f59e0b', order: 1, isTerminal: false, outcome: null, isActive: true },
    { key: 'resolved',    label: 'Resolved',     color: '#10b981', order: 2, isTerminal: true,  outcome: null, isActive: true },
    { key: 'closed',      label: 'Closed',       color: '#64748b', order: 3, isTerminal: true,  outcome: null, isActive: true },
  ],
  // 'approved' is tagged — quotation.controller.ts resolves this key rather
  // than hardcoding the literal, so its auto-lock trigger survives a rename.
  quotation: [
    { key: 'draft',    label: 'Draft',    color: '#94a3b8', order: 0, isTerminal: false, outcome: null,       isActive: true },
    { key: 'sent',     label: 'Sent',     color: '#0ea5e9', order: 1, isTerminal: false, outcome: null,       isActive: true },
    { key: 'approved', label: 'Approved', color: '#10b981', order: 2, isTerminal: true,  outcome: 'approved', isActive: true },
    { key: 'rejected', label: 'Rejected', color: '#ef4444', order: 3, isTerminal: true,  outcome: null,       isActive: true },
  ],
  // 'completed'/'cancelled' are tagged — workorder.controller.ts's auto-lock
  // and workorder.service.ts's contract-visit sync both resolve these keys.
  // 'scheduled' is also tagged — contract.service.ts and contract.scheduler.ts
  // auto-create work orders in this stage when generating from a contract
  // visit, so a tenant rename can't break that auto-generation.
  workorder: [
    { key: 'draft',       label: 'Draft',       color: '#94a3b8', order: 0, isTerminal: false, outcome: null,        isActive: true },
    { key: 'scheduled',   label: 'Scheduled',   color: '#0ea5e9', order: 1, isTerminal: false, outcome: 'scheduled', isActive: true },
    { key: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2, isTerminal: false, outcome: null,        isActive: true },
    { key: 'completed',   label: 'Completed',   color: '#10b981', order: 3, isTerminal: true,  outcome: 'completed', isActive: true },
    { key: 'cancelled',   label: 'Cancelled',   color: '#ef4444', order: 4, isTerminal: true,  outcome: 'cancelled', isActive: true },
  ],
  // 'active' is tagged — contract.controller.ts's auto-lock AND
  // contract.scheduler.ts's auto-generation cron both resolve this key per
  // tenant instead of matching a hardcoded 'active' string in the Mongo
  // query, so a rename can never silently stop a tenant's recurring
  // work-order generation.
  contract: [
    { key: 'draft',     label: 'Draft',     color: '#94a3b8', order: 0, isTerminal: false, outcome: null,      isActive: true },
    { key: 'pending',   label: 'Pending',   color: '#f59e0b', order: 1, isTerminal: false, outcome: null,      isActive: true },
    { key: 'active',    label: 'Active',    color: '#10b981', order: 2, isTerminal: false, outcome: 'active',  isActive: true },
    { key: 'suspended', label: 'Suspended', color: '#f97316', order: 3, isTerminal: false, outcome: null,      isActive: true },
    { key: 'completed', label: 'Completed', color: '#0ea5e9', order: 4, isTerminal: true,  outcome: null,      isActive: true },
    { key: 'expired',   label: 'Expired',   color: '#64748b', order: 5, isTerminal: true,  outcome: null,      isActive: true },
    { key: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 6, isTerminal: true,  outcome: null,      isActive: true },
  ],
  // 'paid' is tagged — invoice.controller.ts's auto-lock resolves this key.
  invoice: [
    { key: 'draft',   label: 'Draft',   color: '#94a3b8', order: 0, isTerminal: false, outcome: null,  isActive: true },
    { key: 'sent',    label: 'Sent',    color: '#0ea5e9', order: 1, isTerminal: false, outcome: null,  isActive: true },
    { key: 'paid',    label: 'Paid',    color: '#10b981', order: 2, isTerminal: true,  outcome: 'paid', isActive: true },
    { key: 'overdue', label: 'Overdue', color: '#f97316', order: 3, isTerminal: false, outcome: null,  isActive: true },
    { key: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 4, isTerminal: true, outcome: null, isActive: true },
  ],
};

/** Upsert-on-read, same pattern as NotificationSettings.getOrCreateSettings —
 * first access seeds today's defaults, so existing tenants see zero change
 * until they actively edit their pipeline. */
export async function getOrCreateStages(tenantId: string, module: PipelineModule): Promise<IPipelineStage[]> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  let doc = await PipelineConfig.findOne({ tenantId: tid, module });
  if (!doc) {
    const defaults = DEFAULT_STAGES[module as BuiltInPipelineModule] ?? [];
    doc = await PipelineConfig.create({ tenantId: tid, module, stages: defaults });
  }
  return doc.stages;
}

export async function updateStages(tenantId: string, module: PipelineModule, stages: IPipelineStage[]): Promise<IPipelineStage[]> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const normalized = stages.map((s, i) => ({ ...s, order: i }));
  const doc = await PipelineConfig.findOneAndUpdate(
    { tenantId: tid, module },
    { $set: { stages: normalized } },
    { upsert: true, new: true, runValidators: true }
  );
  return doc.stages;
}

/** True if `key` is one of the tenant's currently-active stages for this
 * module — the app-layer replacement for the old Mongoose `enum` check. */
export async function isValidStageKey(tenantId: string, module: PipelineModule, key: string): Promise<boolean> {
  const stages = await getOrCreateStages(tenantId, module);
  return stages.some((s) => s.key === key && s.isActive);
}

/** Resolves the tenant's stage key currently tagged with the given semantic
 * outcome (e.g. 'won', 'approved', 'completed', 'active', 'paid') — used
 * anywhere code used to hardcode a literal stage key, so renaming a stage
 * doesn't silently break auto-lock/conversion/scheduler logic. Falls back to
 * the given default if the tenant hasn't configured that outcome stage
 * (shouldn't happen since every tenant is seeded with one, but defensive). */
export async function getOutcomeStageKey(tenantId: string, module: PipelineModule, outcome: string, fallback: string): Promise<string> {
  const stages = await getOrCreateStages(tenantId, module);
  return stages.find((s) => s.outcome === outcome && s.isActive)?.key ?? fallback;
}
