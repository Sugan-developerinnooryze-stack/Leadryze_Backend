import type { BuiltInPipelineModule } from '../../native-crm/pipeline-config/pipeline-config.model';
import type { FieldCap, ModuleCap } from '../registry/types';
import type { ExecContext, ReadContext } from './execute-list';
import type { ImpliedCondition } from './compile';
import type { PartialReason, QueryExtras, QueryNotice } from './execute-query';
import type { Cond, QueryPlan } from '../contracts/plan';
import { QueryPlanSchema } from '../contracts/plan';
import { queryCapsFor } from '../registry/query-caps';
import { loadReadContext, moduleDefFor } from './execute-list';
import { fieldFor } from './compile';
import { PlanRejectedError, prepareQuery, undatedNotices } from './execute-query';
import { companyCurrenciesFor, currencyExpressionOf, scopedAggregate } from './scoped-match';
import { loadStageInfo } from '../../daily-events/daily-events.query';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';

/* The pipeline view (Increment 8): one module's records counted per stage of
 * the tenant's own pipeline, in its order, with money per stage in each
 * currency (never added across currencies) and the records in no listed
 * stage counted once. Reads only: stages through peekStages and
 * loadStageInfo (never a stage writer), records through scoped-match.ts.
 *
 * One aggregation over exactly executor Q's members (prepareQuery: where,
 * search, "mine", then a relation's extras), grouped by the stored stage
 * value and, for a module with an amount, by currency: a deal's own (trimmed
 * and upper-cased, a blank one its company's), every other module's its
 * company's (currencyExpressionOf). A stage's count is therefore the total of
 * its drill list (the same members plus the stage). Leads group under their
 * list collation (case-insensitive), so a lead stored "New" counts in the
 * stage "new". */

/** At most this many (stage, currency) rows are read; one more says some were left out. */
const MAX_PIPELINE_ROWS = 500;
/** contracts/plan.ts: a plan holds at most 10 conditions, an in / nin condition at most 50 values. */
const MAX_PLAN_CONDITIONS = 10;
const MAX_CONDITION_VALUES = 50;
/** A tenant colour as the app stores it ("#6366f1"): contracts/views.ts HexColorSchema's rule. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Each pipeline module's money per stage (decision N24): a deal's amount in
 * its own currency; a lead's expected revenue and a document's total with tax
 * in its company's. Work orders, tasks and tickets have none. */
const AMOUNTS: Readonly<Record<string, { field: string; label: string; currency: 'record' | 'company'; words: string }>> = {
  deal: { field: 'amount', label: 'Amount', currency: 'record', words: 'amounts' },
  lead: { field: 'expectedRevenue', label: 'Expected revenue', currency: 'company', words: 'expected revenue' },
  invoice: { field: 'servicesAmountWithTax', label: 'Total', currency: 'company', words: 'totals' },
  quotation: { field: 'servicesAmountWithTax', label: 'Total', currency: 'company', words: 'totals' },
  contract: { field: 'servicesAmountWithTax', label: 'Total', currency: 'company', words: 'totals' },
};

/** `cancelledByRule`: the outcome 'cancelled' comes from loadStageInfo's
 * cancelled set (a final stage keyed cancel, lost, reject or disqualif, or
 * tagged lost), not from a tag of its own. */
export interface StageFact {
  key: string; label: string; color?: string; order: number; terminal: boolean; outcome?: string; active: boolean; cancelledByRule?: true;
}

export interface PipelineFacts {
  pipeline: BuiltInPipelineModule;
  /** Stored path: 'stage' | 'status' | 'taskStatus' | 'ticketStatus'. */
  field: string;
  /** Registry field key for drill conditions. */
  fieldKey: string;
  /** 'Stage' | 'Status'. */
  fieldLabel: string;
  /** Every saved stage, active and removed, in pipeline order. */
  stages: StageFact[];
  /** loadStageInfo(...).cancelled, imported, never re-derived. */
  cancelled: ReadonlySet<string>;
}

export interface PipelineAmountSpec { field: FieldCap; label: string; currency: 'record' | 'company'; words: string }

/** One stored stage value (null: no stage) with its records and, per currency, their amount (the caller's currency first, then A to Z). */
export interface PipelineValueRow { key: string | null; count: number; amounts: Array<{ v: number; currency: string }> }

/** total: every record read; currencyOrder: the caller's currency, then the
 * others the amounts are in, A to Z; partialReasons: a relation's, and
 * 'row_cap' when more stage and currency rows were made than one read holds
 * (every count is then a lower bound). */
export interface PipelineOutcome {
  facts: PipelineFacts; rows: PipelineValueRow[]; total: number;
  amount: PipelineAmountSpec | null; currencyOrder: string[];
  read: ReadContext; implied: ImpliedCondition[]; notices: QueryNotice[]; partialReasons?: PartialReason[];
}

/** A count of a pipeline module by its stage field, no bucket, no sum or named metric, present absent, 'auto' or 'pipeline' (B6.1). */
export function isPipelinePlan(cap: ModuleCap, plan: QueryPlan): boolean {
  const stage = cap.stage;
  if (!stage || !('pipeline' in stage) || plan.op !== 'aggregate') return false;
  const group = plan.group;
  if (!group || group.bucket !== undefined) return false;
  if (group.by !== stage.field && fieldFor(cap, group.by)?.path !== stage.field) return false;
  const metrics = plan.metrics;
  if (metrics !== undefined && !(metrics.length === 1 && 'fn' in metrics[0] && metrics[0].fn === 'count')) return false;
  return plan.present === undefined || plan.present === 'auto' || plan.present === 'pipeline';
}

/** Deal amount ('record', label "Amount", words "amounts"), lead expectedRevenue
 * ('company', "Expected revenue"), invoice, quotation and contract
 * servicesAmountWithTax ('company', "Total", "totals"); null for work orders,
 * tasks and tickets. */
export function pipelineAmountOf(cap: ModuleCap): PipelineAmountSpec | null {
  const spec = AMOUNTS[cap.key];
  const field = spec ? fieldFor(cap, spec.field) : undefined;
  if (!spec || !field || field.kind !== 'money') return null;
  // A record's own currency needs the field that holds it (a deal's currency).
  if (spec.currency === 'record' && typeof field.money?.currency !== 'object') return null;
  return { field, label: spec.label, currency: spec.currency, words: spec.words };
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** peekStages and loadStageInfo(tenantId, { field, pipeline }, new Map()) in parallel; null for a non-pipeline module. */
export async function loadPipelineFacts(cap: ModuleCap, tenantId: string): Promise<PipelineFacts | null> {
  const stage = cap.stage;
  if (!stage || !('pipeline' in stage)) return null;
  const field = cap.fields.find((f) => f.path === stage.field || f.key === stage.field);
  const [saved, info] = await Promise.all([
    peekStages(tenantId, stage.pipeline),
    loadStageInfo(tenantId, { field: stage.field, pipeline: stage.pipeline }, new Map()),
  ]);
  // Entries without a key are skipped and the first of a repeated key wins
  // (stored order); then the tenant's order, a tie in stored order.
  const seen = new Set<string>();
  const kept: Array<{ s: Record<string, unknown>; at: number }> = [];
  (Array.isArray(saved) ? saved : []).forEach((raw, at) => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as unknown as Record<string, unknown>;
    if (typeof s.key !== 'string' || !s.key.trim() || seen.has(s.key)) return;
    seen.add(s.key);
    kept.push({ s, at });
  });
  const orderOf = (s: Record<string, unknown>) => (typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : Number.POSITIVE_INFINITY);
  kept.sort((a, b) => (orderOf(a.s) === orderOf(b.s) ? a.at - b.at : orderOf(a.s) < orderOf(b.s) ? -1 : 1));
  const stages = kept.map(({ s }, order): StageFact => {
    const key = s.key as string;
    const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim() : humanize(key);
    const color = typeof s.color === 'string' ? s.color.trim() : '';
    const tagged = typeof s.outcome === 'string' && s.outcome.trim() ? s.outcome.trim().toLowerCase() : undefined;
    const byRule = !tagged && info.cancelled.has(key);
    return {
      key, label, ...(HEX_COLOR.test(color) ? { color } : {}), order, terminal: s.isTerminal === true,
      ...(tagged ? { outcome: tagged } : byRule ? { outcome: 'cancelled', cancelledByRule: true as const } : {}),
      // A stage saved before isActive existed counts as active.
      active: s.isActive !== false,
    };
  });
  return {
    pipeline: stage.pipeline, field: field?.path ?? stage.field, fieldKey: field?.key ?? stage.field,
    fieldLabel: field?.label ?? humanize(stage.field), stages, cancelled: info.cancelled,
  };
}

function finite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** The stage key a stored value stands for: the value itself, or, where the
 * module groups case-insensitively (its list collation: leads), the stage key
 * it equals ignoring case (an active stage before a removed one). null for no
 * stage (null, missing, blank); any other value stays as stored (a key no
 * longer in the pipeline), a non-string one as text. */
function stageKeyReader(facts: PipelineFacts, ignoreCase: boolean): (raw: unknown) => string | null {
  const keys = new Set(facts.stages.map((s) => s.key));
  const byLower = new Map<string, string>();
  for (const s of [...facts.stages.filter((x) => x.active), ...facts.stages.filter((x) => !x.active)]) {
    if (!byLower.has(s.key.toLowerCase())) byLower.set(s.key.toLowerCase(), s.key);
  }
  return (raw) => {
    if (raw === null || raw === undefined) return null;
    const text = typeof raw === 'string' ? raw : String(raw);
    if (!text.trim()) return null;
    if (keys.has(text)) return text;
    return ignoreCase ? byLower.get(text.toLowerCase()) ?? text : text;
  };
}

function reject(path: string, message: string): PlanRejectedError {
  return new PlanRejectedError([{ code: 'unsupported_option', path, message }]);
}

/** One row as read: the stored stage value (s) and currency (c), the record count, the amount and how many records have one above 0. */
interface RawRow { _id?: { s?: unknown; c?: unknown }; n?: unknown; v?: unknown; p?: unknown }

/** One scopedAggregate over prepareQuery's members (plus extras). Throws PlanRejectedError and MineUnavailableError as executor Q does. */
export async function executePipeline(cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, extras?: QueryExtras): Promise<PipelineOutcome> {
  if (!cap.stage || !('pipeline' in cap.stage)) throw reject('group.by', `${cap.labels.plural} have no pipeline stages.`);
  if (!isPipelinePlan(cap, plan)) {
    const field = cap.fields.find((f) => f.path === cap.stage!.field || f.key === cap.stage!.field);
    throw reject('group', `A pipeline counts ${cap.labels.plural.toLowerCase()} by ${(field?.label ?? cap.stage.field).toLowerCase()}.`);
  }
  const amount = pipelineAmountOf(cap);
  // The stage facts and the company currencies are read alongside the plan's
  // members; "mine" that can't be told, or a plan that can't run, throws first.
  const [prepared, facts, currencies] = await Promise.all([
    prepareQuery(cap, plan, ctx, extras),
    loadPipelineFacts(cap, ctx.tenantId),
    amount ? companyCurrenciesFor(ctx) : Promise.resolve(null),
  ]);
  if (!facts) throw reject('group.by', `${cap.labels.plural} have no pipeline stages.`);

  const by = `$${facts.field}`;
  let stages: Record<string, unknown>[];
  if (amount && currencies) {
    const company = currencyExpressionOf(currencies);
    const own = amount.field.money?.currency;
    const currency = amount.currency === 'record' && typeof own === 'object'
      ? recordCurrencyExpression(fieldFor(cap, own.field)?.path ?? own.field, company)
      : company;
    // A stored amount as a number: 0 when it is missing or not a number (as the named totals read it).
    const value = { $convert: { input: `$${amount.field.path}`, to: 'double', onError: 0, onNull: 0 } };
    stages = [
      { $group: { _id: { s: by, c: currency }, n: { $sum: 1 }, v: { $sum: value }, p: { $sum: { $cond: [{ $gt: [value, 0] }, 1, 0] } } } },
      { $sort: { '_id.s': 1, '_id.c': 1 } },
      { $limit: MAX_PIPELINE_ROWS + 1 },
    ];
  } else {
    stages = [{ $group: { _id: { s: by }, n: { $sum: 1 } } }, { $sort: { '_id.s': 1 } }, { $limit: MAX_PIPELINE_ROWS + 1 }];
  }
  const [result, read, undated] = await Promise.all([
    scopedAggregate(cap, ctx, prepared.conditions, stages),
    loadReadContext(cap, moduleDefFor(cap), ctx, prepared.status),
    // A window on a date some records lack (a deal's close date) says how many it leaves out.
    prepared.undated ? undatedNotices(cap, ctx, prepared.undated) : Promise.resolve([]),
  ]);

  const raw = result as RawRow[];
  const capped = raw.length > MAX_PIPELINE_ROWS;
  const keyOf = stageKeyReader(facts, !!queryCapsFor(cap.key)?.collation);
  // Rows of one stage key (several currencies, or values equal ignoring case) fold into one.
  const folded = new Map<string | null, { count: number; money: Map<string, { v: number; p: number }> }>();
  for (const row of raw.slice(0, MAX_PIPELINE_ROWS)) {
    const key = keyOf(row._id?.s);
    const entry = folded.get(key) ?? { count: 0, money: new Map<string, { v: number; p: number }>() };
    entry.count += Math.max(0, Math.round(finite(row.n) ?? 0));
    const c = row._id?.c;
    const v = finite(row.v);
    if (amount && typeof c === 'string' && c && v !== null) {
      const sum = entry.money.get(c) ?? { v: 0, p: 0 };
      entry.money.set(c, { v: sum.v + v, p: sum.p + (finite(row.p) ?? 0) });
    }
    folded.set(key, entry);
  }
  // The caller's currency (its company's, else the org's) first, then A to Z.
  const own = currencies ? (ctx.branchId ? currencies.byBranch.get(ctx.branchId.toLowerCase()) : undefined) ?? currencies.org : null;
  const seenCurrencies = new Set<string>();
  folded.forEach((entry) => entry.money.forEach((sum, c) => { if (sum.p > 0) seenCurrencies.add(c); }));
  const currencyOrder = own ? [own, ...[...seenCurrencies].filter((c) => c !== own).sort()] : [];
  const rank = (c: string) => (currencyOrder.includes(c) ? currencyOrder.indexOf(c) : currencyOrder.length);
  const rows: PipelineValueRow[] = [...folded].map(([key, entry]) => ({
    key,
    count: entry.count,
    // A currency is listed only when a record there has an amount above 0; never added to another.
    amounts: [...entry.money].filter(([, sum]) => sum.p > 0)
      .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, sum]) => ({ v: Math.round(sum.v * 100) / 100, currency })),
  }));
  const reasons = [...new Set<PartialReason>([...(prepared.partialReasons ?? []), ...(capped ? ['row_cap' as const] : [])])];
  return {
    facts, rows, total: rows.reduce((n, row) => n + row.count, 0), amount, currencyOrder,
    read, implied: prepared.implied, notices: [...prepared.notices, ...undated],
    ...(reasons.length ? { partialReasons: reasons } : {}),
  };
}

/** The list behind a stage or the records in none (drillPlanOf's shape:
 * the same target, conditions, search, "mine" and relation) plus `more`,
 * a condition the plan already has not repeated. Undefined when that would
 * take more conditions than a plan holds, or when it doesn't fit a plan at
 * all (a stage key longer than a plan value). */
function listPlanWith(plan: QueryPlan, more: Cond[]): QueryPlan | undefined {
  const own = plan.where ?? [];
  const seen = new Set(own.map((cond) => JSON.stringify(cond)));
  const where = [...own, ...more.filter((cond) => !seen.has(JSON.stringify(cond)))];
  if (where.length > MAX_PLAN_CONDITIONS) return undefined;
  const drill: QueryPlan = {
    v: 1, op: 'list', target: plan.target,
    ...(where.length ? { where } : {}),
    ...(plan.search ? { search: plan.search } : {}),
    ...(plan.mine ? { mine: plan.mine } : {}),
    ...(plan.relation ? { relation: plan.relation } : {}),
  };
  return QueryPlanSchema.safeParse(drill).success ? drill : undefined;
}

/** drillPlanOf plus { f: fieldKey, op: 'eq', v: key }; undefined past 10 conditions. */
export function stageDrillPlan(plan: QueryPlan, fieldKey: string, key: string): QueryPlan | undefined {
  return listPlanWith(plan, [{ f: fieldKey, op: 'eq', v: key }]);
}

/** The same with { f: fieldKey, op: 'nin', v: activeKeys }; plain drillPlanOf when activeKeys is empty; undefined past 50 keys or 10 conditions. */
export function offPipelineDrillPlan(plan: QueryPlan, fieldKey: string, activeKeys: readonly string[]): QueryPlan | undefined {
  const keys = [...new Set(activeKeys)];
  if (keys.length > MAX_CONDITION_VALUES) return undefined;
  // nin also matches records whose stage is null or missing.
  return listPlanWith(plan, keys.length ? [{ f: fieldKey, op: 'nin', v: keys }] : []);
}

/** A deal's own currency, trimmed and upper-cased; blank: its company's (currencyExpressionOf). */
export function recordCurrencyExpression(path: string, company: Record<string, unknown>): Record<string, unknown> {
  return {
    $let: {
      vars: { c: { $toUpper: { $trim: { input: { $convert: { input: `$${path}`, to: 'string', onError: '', onNull: '' } } } } } },
      in: { $cond: [{ $eq: ['$$c', ''] }, company, '$$c'] },
    },
  };
}
