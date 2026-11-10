import { Cond, QueryPlan, QueryPlanSchema } from '../contracts/plan';
import type { FieldCap, ModuleCap } from '../registry/types';
import { getModuleCap } from '../registry';
import { conditionOpsFor, isQueryGroupable, isQuerySortable, queryCapsFor, queryStatesFor } from '../registry/query-caps';
import type { CondOp } from '../registry/query-caps';
import { relationFor } from '../registry/relations';
import { metricFor } from '../registry/metrics';
import { BUSINESS_NUMBER_EXACT, BUSINESS_NUMBER_MODULES } from '../grammar/tokens';
import { toAsciiDigits } from '../grammar/numbers';
import { CRM_WRITE_MODULE_MAP } from '../../internal/crm-write.module-map';
import { MAX_LIST_LIMIT } from '../../internal/crm-gateway.helpers';
import type { CapabilityView } from '../capability-view';
import { conditionShapeProblem, fieldFor } from './compile';

/* Checks a QueryPlan against the caller's capability view before anything
 * runs, and picks the executor. Every rejection names the problem; nothing is
 * dropped silently. Structural checks only (no database): what depends on the
 * tenant (pipeline stage keys, tagged outcomes, currencies) is checked when
 * executor Q compiles the plan (compile.ts). A condition on a reference that
 * holds another record's number (a work order's customer, a task's assignee)
 * takes record numbers of that module only, and the plan comes back with them
 * as the models store them; a name there would match nothing (a record named
 * in words is found through a relation: "for ABC Industries"). A field whose
 * stored values don't share one unit (call.duration) takes no condition.
 *
 * Executor L (the module's own list() and getById()) runs one record by its
 * business number (or, Increment 5, by a server-written record.ref), and list
 * and count with nothing but page and page size, plus search where list()
 * keeps the scope while searching. Executor Q (scoped queries, Increment 3)
 * runs everything else: conditions, every sort (it breaks ties on _id, list()
 * sorts don't), top N, count breakdowns and "mine" (Increment 4: what it
 * means per module is decided when the plan runs, query/mine.ts), and from
 * Increment 5 relations and named metrics. A relation must be one
 * registry/relations.ts names for the target in its direction (has / has_none
 * name a child, for names a parent), and its conditions are checked against
 * the related (child) module; whether the caller may use that module is
 * decided when it runs (query/relations.ts), as a notice, never here. A named
 * metric must be one of the target's (registry/metrics.ts), broken down only
 * by one of its own fields or, per day to year, by its own date (bucketField).
 * Date windows (outside an agenda), sums of other fields and concept targets
 * are not run here; every presentation is accepted and the composer answers
 * what it can (Increment 8). */

export type PlanProblemCode =
  | 'invalid_plan'          // fails the strict schema
  | 'unsupported_target'    // a concept target (customer across sources, ...) — later increments
  | 'unknown_module'        // not a registry module
  | 'module_disabled'       // the module flag is off for this caller
  | 'no_permission'         // no view permission
  | 'unsupported_op'        // agenda — later increments
  | 'unsupported_option'    // a plan part no executor can run yet (relation, window, metrics, ...) or the chosen one can't
  | 'unsupported_condition' // a condition this module or field can't be filtered by (or not yet)
  | 'invalid_value'         // a condition value that doesn't fit its field
  | 'missing_record'        // detail without record.number or record.ref
  | 'no_business_number';   // the module has no business number to look up

export interface PlanProblem {
  code: PlanProblemCode;
  message: string;
  path?: string;
}

/** L: the module's own list() / getById(). Q: scoped queries (execute-query.ts). */
export type Executor = 'L' | 'Q';

export type PlanValidation =
  | { ok: true; plan: QueryPlan; cap: ModuleCap; executor: Executor }
  | { ok: false; problems: PlanProblem[]; module?: string; access?: 'disabled' | 'no_permission' };

/** What a forced executor (a table's handle) answers when the change needs another one. */
export const HANDLE_CHANGE_REFUSED = "This table can't be changed that way.";

/** Plan keys no executor runs yet, with the reason given back (later increments). */
const LATER_KEYS: ReadonlyArray<[keyof QueryPlan, string]> = [
  ['window', 'date windows'],
];
/** Plan keys a record lookup can't be combined with ("mine" narrows a list
 * or a count; one record by its number is the caller's to see or not). */
const DETAIL_ONLY_KEYS: ReadonlyArray<keyof QueryPlan> = ['where', 'sort', 'top', 'group', 'metrics', 'mine', 'relation'];
/** Plan keys a count breakdown can't be combined with (groups are not paged or re-sorted). */
const AGGREGATE_EXCLUDED_KEYS: ReadonlyArray<keyof QueryPlan> = ['sort', 'top', 'page', 'pageSize'];
/** Plan keys a named metric can't be combined with (its rows are not paged or re-sorted; top N picks the largest). */
const METRIC_EXCLUDED_KEYS: ReadonlyArray<keyof QueryPlan> = ['sort', 'page', 'pageSize'];
const STATE_SUPPORT: Readonly<Record<string, 'open' | 'closed' | 'overdue' | 'dueToday'>> = {
  open: 'open', closed: 'closed', overdue: 'overdue', due_today: 'dueToday',
};
/** A server-written record id (record.ref, a relation's entity.ref). */
const RECORD_REF = /^[a-f0-9]{24}$/i;

type Problems = PlanProblem[];
const push = (problems: Problems, code: PlanProblemCode, path: string, message: string) => problems.push({ code, path, message });

/** A reference that holds another record's business number (a work order's
 * customer, a task's assignee): only that number finds the record. */
function isBusinessRef(field: FieldCap | undefined): field is FieldCap & { ref: NonNullable<FieldCap['ref']> } {
  return !!field && (field.kind === 'ref' || field.kind === 'ref_many') && field.ref?.idFormat === 'business';
}

/** A record number as the models store it, and the module its code names:
 * NFKC, ASCII digits, trimmed and upper-cased ("9a218c-cus-०००१" ->
 * "9A218C-CUS-0001", 'customer'). Null when the text isn't one whole
 * business number. */
export function businessNumberOf(text: string): { number: string; module: string | undefined } | null {
  const number = toAsciiDigits(text.normalize('NFKC')).trim().toUpperCase();
  const match = BUSINESS_NUMBER_EXACT.exec(number);
  return match ? { number, module: BUSINESS_NUMBER_MODULES[match[2]] } : null;
}

/** A where condition's problems that need no tenant data. */
function conditionProblem(cap: ModuleCap, cond: Record<string, unknown>, at: string): PlanProblem | null {
  const plural = cap.labels.plural;
  if (cond.op === 'state') {
    // 'expiring' (and the date range only it takes) runs where the module's
    // query caps report it (contracts and quotations, Increment 5).
    const states: ReturnType<typeof queryStatesFor> & { expiring?: boolean } = queryStatesFor(cap);
    if (cond.v === 'expiring') {
      return states.expiring === true ? null : { code: 'unsupported_condition', path: at, message: `${plural} can't be filtered as expiring.` };
    }
    if (cond.range !== undefined) return { code: 'unsupported_condition', path: at, message: 'Only expiring records take a date range.' };
    const support = STATE_SUPPORT[String(cond.v)];
    if (!support || !queryStatesFor(cap)[support]) {
      return { code: 'unsupported_condition', path: at, message: `${plural} can't be filtered as ${String(cond.v).replace('_', ' ')}.` };
    }
    return null;
  }
  if (cond.op === 'outcome') {
    return cap.stage ? null : { code: 'unsupported_condition', path: at, message: `${plural} have no stage, so no outcomes.` };
  }
  const field = typeof cond.f === 'string' ? fieldFor(cap, cond.f) : undefined;
  if (!field) return { code: 'unsupported_condition', path: `${at}.f`, message: `${plural} can't be filtered by "${String(cond.f)}".` };
  // Decision D-B: the stored values don't share one unit (call.duration:
  // minutes from the Calls screen, seconds elsewhere), so no number answers a
  // condition on it until the data is settled. It can still be sorted.
  if (field.unitUncertain) {
    return { code: 'unsupported_option', path: `${at}.f`, message: `${plural} can't be filtered by ${field.label.toLowerCase()} yet.` };
  }
  const ops = conditionOpsFor(cap, field);
  if (!ops.includes(cond.op as CondOp)) {
    return {
      code: 'unsupported_condition', path: `${at}.op`,
      message: ops.length ? `${field.label} can't be filtered with "${String(cond.op)}".` : `${plural} can't be filtered by ${field.label.toLowerCase()}.`,
    };
  }
  const shape = conditionShapeProblem(field, cond, `${at}.v`);
  if (shape) return shape;
  // A reference holding another record's number is matched by that number
  // only: a name there would be compared with the stored numbers and match
  // nothing, a confident zero. A record named in words is found through a
  // relation instead ("for ABC Industries", query/relations.ts), so a name
  // here is "not supported".
  if (isBusinessRef(field) && cond.op !== 'empty' && cond.op !== 'not_empty') {
    const values: unknown[] = Array.isArray(cond.v) ? cond.v : [cond.v];
    if (!values.every((v) => typeof v === 'string' && businessNumberOf(v)?.module === field.ref.module)) {
      return { code: 'unsupported_option', path: `${at}.v`, message: `${field.label} is matched by its record number; a name is found through a relation.` };
    }
  }
  return null;
}

/** The plan with each record number in a reference condition (of the plan,
 * and of a relation's related module) as the models store it
 * (businessNumberOf; conditionProblem checked that each is one). */
function withStoredNumbers(cap: ModuleCap, plan: QueryPlan): QueryPlan {
  let changed = false;
  const stored = (value: unknown): unknown => {
    const number = typeof value === 'string' ? businessNumberOf(value)?.number : undefined;
    if (number === undefined || number === value) return value;
    changed = true;
    return number;
  };
  const storedIn = (module: ModuleCap, conds: Cond[] | undefined): Cond[] | undefined => conds?.map((cond) => {
    if (!('f' in cond) || !('v' in cond) || !isBusinessRef(fieldFor(module, cond.f))) return cond;
    const v: unknown = cond.v;
    return { ...cond, v: Array.isArray(v) ? v.map(stored) : stored(v) } as Cond;
  });
  const where = storedIn(cap, plan.where);
  const rel = plan.relation;
  const related = rel && rel.kind !== 'for' && rel.where ? getModuleCap(relationFor(cap.key, rel.kind, rel.name)?.child ?? '') : undefined;
  const relatedWhere = related && rel && rel.kind !== 'for' ? storedIn(related, rel.where) : undefined;
  if (!changed) return plan;
  return {
    ...plan,
    ...(where ? { where } : {}),
    ...(rel && rel.kind !== 'for' && relatedWhere ? { relation: { ...rel, where: relatedWhere } } : {}),
  };
}

/** A relation's problems that need no tenant data: one registry/relations.ts
 * names for the target in its direction (has / has_none name a child, for
 * names a parent), whose other module the engine serves; an entity that can
 * name a record; conditions the related (child) module can be filtered by.
 * Whether the caller may use that module is decided when it runs. */
function relationProblems(cap: ModuleCap, relation: NonNullable<QueryPlan['relation']>): Problems {
  const def = relationFor(cap.key, relation.kind, relation.name);
  const name = relation.name.slice(0, 60);
  if (!def) {
    const message = relation.kind === 'for'
      ? `${cap.labels.plural} can't be listed for a "${name}".`
      : `${cap.labels.plural} can't be filtered by their "${name}".`;
    return [{ code: 'unsupported_option', path: 'relation.name', message }];
  }
  const other = getModuleCap(relation.kind === 'for' ? def.parent : def.child);
  if (!other || !CRM_WRITE_MODULE_MAP[other.key] || !queryCapsFor(other.key)?.q) {
    return [{ code: 'unsupported_option', path: 'relation.name', message: `${cap.labels.plural} can't be related to "${name}" here yet.` }];
  }
  if (relation.kind === 'for') {
    const entity = relation.entity;
    if ('text' in entity && !entity.text.trim()) {
      return [{ code: 'invalid_value', path: 'relation.entity.text', message: 'The record to look for needs a name or a number.' }];
    }
    if ('ref' in entity && !RECORD_REF.test(entity.ref)) {
      return [{ code: 'invalid_value', path: 'relation.entity.ref', message: 'relation.entity.ref must be a record id.' }];
    }
    return [];
  }
  const problems: Problems = [];
  (relation.where ?? []).forEach((cond, i) => {
    const found = conditionProblem(other, cond as Record<string, unknown>, `relation.where.${i}`);
    if (found) problems.push(found);
  });
  return problems;
}

/** A named metric's problems: exactly one, of the target module
 * (registry/metrics.ts), broken down only by one of its own fields, or by its
 * own date (bucketField, a date field) per day, week, month, quarter or year;
 * top N only with a breakdown by a field (a ranking); no sort or paging. */
function namedMetricProblems(cap: ModuleCap, plan: QueryPlan): Problems {
  const problems: Problems = [];
  const metrics = plan.metrics ?? [];
  if (metrics.length !== 1) push(problems, 'unsupported_option', 'metrics', 'One total can be asked for at a time.');
  const first = metrics[0];
  const metric = first && 'metric' in first ? metricFor(cap.key, first.metric) : undefined;
  if (!metric) {
    push(problems, 'unsupported_option', 'metrics.0', `${cap.labels.plural} have no such total.`);
    return problems;
  }
  if (plan.group) {
    const field = fieldFor(cap, plan.group.by);
    const dated = !!plan.group.bucket && !!metric.bucketField && plan.group.by === metric.bucketField
      && !!field && (field.kind === 'date' || field.kind === 'datetime');
    if (!dated && (!metric.groupBy.includes(plan.group.by) || !field)) {
      push(problems, 'unsupported_option', 'group.by', `${metric.label} can't be broken down by "${plan.group.by}".`);
    }
    if (plan.group.bucket && !dated) push(problems, 'unsupported_option', 'group.bucket', `${metric.label} is not broken down by date.`);
    if (dated && plan.top !== undefined) push(problems, 'unsupported_option', 'top', 'top N is for rankings, not dates.');
  } else if (plan.top !== undefined) {
    push(problems, 'unsupported_option', 'top', 'top N needs a breakdown.');
  }
  for (const key of METRIC_EXCLUDED_KEYS) {
    if (plan[key] !== undefined) push(problems, 'unsupported_option', key, `${key} can't be used with a total.`);
  }
  return problems;
}

/** A count breakdown's group: a groupable field; dates need a bucket, nothing else takes one. */
function groupProblem(cap: ModuleCap, group: NonNullable<QueryPlan['group']>): PlanProblem | null {
  const field = fieldFor(cap, group.by);
  if (!field || !isQueryGroupable(cap, field)) {
    return { code: 'unsupported_option', path: 'group.by', message: `${cap.labels.plural} can't be counted by "${group.by}".` };
  }
  const isDate = field.kind === 'date' || field.kind === 'datetime';
  if (isDate && !group.bucket) return { code: 'unsupported_option', path: 'group.bucket', message: `Counting by ${field.label.toLowerCase()} needs a day, week, month, quarter or year.` };
  if (!isDate && group.bucket) return { code: 'unsupported_option', path: 'group.bucket', message: `Only dates can be counted per ${group.bucket}.` };
  return null;
}

/** Every problem a plan has whatever executor runs it. */
function structuralProblems(plan: QueryPlan, cap: ModuleCap): Problems {
  const problems: Problems = [];
  if (plan.op === 'agenda') push(problems, 'unsupported_op', 'op', `"${plan.op}" is not supported yet.`);
  for (const [key, what] of LATER_KEYS) {
    if (plan[key] !== undefined) push(problems, 'unsupported_option', key, `${what} (${key}) are not supported yet.`);
  }

  if (plan.op === 'detail') {
    // record.ref (Increment 5) is a server-written _id (a duplicate number's
    // choice, a related record): the planner never writes one (its grounding refuses it).
    const record = plan.record;
    if (!record || 'focus' in record) {
      push(problems, 'missing_record', 'record', 'A detail plan needs record.number or record.ref.');
    } else if ('ref' in record) {
      if (!RECORD_REF.test(record.ref)) push(problems, 'invalid_value', 'record.ref', 'record.ref must be a record id.');
    } else if (!cap.ids.business) {
      push(problems, 'no_business_number', 'record.number', `${cap.labels.plural} have no record number.`);
    }
    if (plan.search !== undefined) push(problems, 'unsupported_option', 'search', 'Search can\'t be combined with one record.');
    for (const key of DETAIL_ONLY_KEYS) {
      if (plan[key] !== undefined) push(problems, 'unsupported_option', key, `${key} can't be combined with one record.`);
    }
    return problems;
  }
  if (plan.record !== undefined) push(problems, 'unsupported_option', 'record', 'record is only used with op "detail".');

  (plan.where ?? []).forEach((cond, i) => {
    const found = conditionProblem(cap, cond as Record<string, unknown>, `where.${i}`);
    if (found) problems.push(found);
  });
  if (plan.relation) problems.push(...relationProblems(cap, plan.relation));

  if (plan.op === 'aggregate' && plan.metrics?.some((m) => 'metric' in m)) {
    problems.push(...namedMetricProblems(cap, plan));
    return problems;
  }
  if (plan.op === 'aggregate') {
    if (!plan.group) push(problems, 'unsupported_option', 'group', 'Totals and other summaries are not supported yet; count by a field instead.');
    else {
      const found = groupProblem(cap, plan.group);
      if (found) problems.push(found);
    }
    const metrics = plan.metrics ?? [{ fn: 'count' as const }];
    if (metrics.length !== 1 || !('fn' in metrics[0]) || metrics[0].fn !== 'count') {
      push(problems, 'unsupported_option', 'metrics', 'Only counts are supported yet.');
    }
    for (const key of AGGREGATE_EXCLUDED_KEYS) {
      if (plan[key] !== undefined) push(problems, 'unsupported_option', key, `${key} can't be used with a count breakdown.`);
    }
    return problems;
  }

  if (plan.group !== undefined) push(problems, 'unsupported_option', 'group', 'Counting by a field needs op "aggregate".');
  if (plan.metrics !== undefined) push(problems, 'unsupported_option', 'metrics', 'Metrics need op "aggregate".');
  if (plan.top !== undefined) {
    if (plan.op !== 'list') push(problems, 'unsupported_option', 'top', 'top N is only for lists.');
    else if (plan.top > MAX_LIST_LIMIT) push(problems, 'unsupported_option', 'top', `At most the top ${MAX_LIST_LIMIT} can be listed.`);
  }
  if (plan.sort && !fieldFor(cap, plan.sort.by) && !cap.sort.listSortable.includes(plan.sort.by)) {
    push(problems, 'unsupported_option', 'sort.by', `${cap.labels.plural} can't be sorted by "${plan.sort.by}".`);
  }
  return problems;
}

/** True when the module's own list() runs this list or count exactly: no
 * conditions (nor "mine", which only executor Q adds as its own condition next
 * to the scope), no sort, no top N, and a search only where list() keeps the scope
 * while searching. Every explicit sort runs on executor Q: list() sorts have no
 * unique tie-breaker (sorted pages could repeat or skip records), would rank
 * amounts of different currencies together (deal amounts, and Field Service
 * amounts across companies), while Q breaks ties on _id and applies the
 * currency rules. */
function runsOnL(plan: QueryPlan, cap: ModuleCap): boolean {
  if (plan.op !== 'list' && plan.op !== 'count') return false;
  if ((plan.where?.length ?? 0) > 0 || plan.top !== undefined || plan.group !== undefined || plan.metrics !== undefined) return false;
  if (plan.mine !== undefined || plan.relation !== undefined || plan.window !== undefined || plan.record !== undefined) return false;
  if (plan.sort !== undefined) return false;
  if (plan.search?.trim() && queryCapsFor(cap.key)?.listSearchSafe === false) return false;
  return true;
}

/** Problems the given executor has with a structurally valid plan. */
function executorProblems(plan: QueryPlan, cap: ModuleCap, executor: Executor, forced: boolean): Problems {
  const refuse = (path: string, message: string): Problems => [{ code: 'unsupported_option', path, message: forced ? HANDLE_CHANGE_REFUSED : message }];
  if (executor === 'L') {
    if (plan.op === 'detail' || runsOnL(plan, cap)) return [];
    return refuse('executor', `${cap.labels.plural} can't be read that way.`);
  }
  if (plan.op === 'detail') return refuse('op', 'A record number is looked up through the module itself.');
  const qc = queryCapsFor(cap.key);
  if (!qc?.q) return refuse('executor', `${cap.labels.plural} can only be listed and counted as they are.`);
  if (plan.sort) {
    const field = fieldFor(cap, plan.sort.by);
    if (!field || !isQuerySortable(cap, field)) return refuse('sort.by', `${cap.labels.plural} can't be sorted by ${field ? field.label.toLowerCase() : `"${plan.sort.by}"`}.`);
  }
  if (plan.search?.trim() && !qc.searchFields.length) return refuse('search', `${cap.labels.plural} can't be searched by text.`);
  return [];
}

/** detail -> L; an unsorted list / count the module's own list() runs exactly
 * -> L; everything else (conditions, "mine", any sort, top N, breakdowns) -> Q. */
export function chooseExecutor(plan: QueryPlan, cap: ModuleCap): Executor {
  if (plan.op === 'detail') return 'L';
  return runsOnL(plan, cap) ? 'L' : 'Q';
}

/** opts.executor forces one (a table's handle re-runs on the executor that
 * built it): a plan it can't run is refused with HANDLE_CHANGE_REFUSED, never
 * moved to the other executor. */
export function validateQueryPlan(input: unknown, view: CapabilityView, opts: { executor?: Executor } = {}): PlanValidation {
  const parsed = QueryPlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 5).map((issue) => ({
        code: 'invalid_plan' as const,
        path: issue.path.join('.'),
        message: `Plan ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }
  const plan = parsed.data;

  if (!('module' in plan.target)) {
    return { ok: false, problems: [{ code: 'unsupported_target', path: 'target', message: 'Concept targets are not supported yet; name one module.' }] };
  }
  const module = plan.target.module;
  const cap = getModuleCap(module);
  if (!cap || !CRM_WRITE_MODULE_MAP[module]) {
    return { ok: false, module, problems: [{ code: 'unknown_module', path: 'target.module', message: `Unknown module "${module}".` }] };
  }

  const access = view.accessOf(module);
  if (access === 'disabled') {
    return { ok: false, module, access: 'disabled', problems: [{ code: 'module_disabled', path: 'target.module', message: `${cap.labels.plural} is turned off for this caller.` }] };
  }
  if (access !== 'ok') {
    return { ok: false, module, access: 'no_permission', problems: [{ code: 'no_permission', path: 'target.module', message: `No view permission for ${cap.labels.plural}.` }] };
  }

  const problems = structuralProblems(plan, cap);
  if (problems.length) return { ok: false, module, problems };

  if (opts.executor !== undefined && opts.executor !== 'L' && opts.executor !== 'Q') {
    return { ok: false, module, problems: [{ code: 'unsupported_option', path: 'executor', message: HANDLE_CHANGE_REFUSED }] };
  }
  const executor = opts.executor ?? chooseExecutor(plan, cap);
  const refused = executorProblems(plan, cap, executor, opts.executor !== undefined);
  if (refused.length) return { ok: false, module, problems: refused };

  // top N is the page size of a Q list (never more than N per page). A named
  // total's top N caps its rows per currency instead (query/metrics.ts), and a
  // page size next to a total is refused, so that plan keeps none: it is the
  // session's last plan and its follow-ups validate it again.
  const namedTotal = plan.op === 'aggregate' && !!plan.metrics?.some((m) => 'metric' in m);
  const topSize = plan.top !== undefined && !namedTotal ? Math.min(plan.top, plan.pageSize ?? plan.top) : undefined;
  const sized: QueryPlan = topSize !== undefined && topSize !== plan.pageSize ? { ...plan, pageSize: topSize } : plan;
  return { ok: true, plan: withStoredNumbers(cap, sized), cap, executor };
}
