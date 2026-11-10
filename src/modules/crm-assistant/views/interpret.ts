import type { ModuleCap } from '../registry/types';
import type { QueryPlan } from '../contracts/plan';
import { SOURCE_LABELS } from '../registry/labels';
import { queryCapsFor } from '../registry/query-caps';
import { MineMode, mineLabel, minePartial } from '../query/mine';

/* The plain sentences around an answer: interpretedAs ("Field Service
 * customers you can see, newest first") and the one-line summary kept in
 * the conversation history instead of the rows. Neither ever holds a record
 * value or an id; a business number appears only when the user typed it. */

export type ScopeKind = 'all' | 'team' | 'self';

export function lowerLabel(label: string): string {
  return label.toLowerCase();
}

export function sentenceCase(label: string): string {
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function groupLabel(cap: ModuleCap): string {
  return SOURCE_LABELS[cap.group];
}

function visibleSuffix(scopeKind: ScopeKind): string {
  return scopeKind === 'all' ? '' : ' you can see';
}

/** Whose records a "mine" plan reads ("assigned to you", "created by you",
 * "owned by you": mineLabel, then `createdWhen`: "created by you this
 * week"), and "that you can see" where the scope can leave some of them out
 * (query/mine.ts minePartial: tasks assigned to an agent that someone else
 * created). */
function whoseWords(cap: ModuleCap, mine: MineMode, scopeKind: ScopeKind, createdWhen = ''): string {
  const when = createdWhen ? ` ${createdWhen}` : '';
  return `${lowerLabel(mineLabel(cap, mine))}${when}${minePartial(cap, mine, scopeKind) ? ' that you can see' : ''}`;
}

/** The records a plan reads: "Field Service deals", then " you can see"
 * under a narrower scope, or for a "mine" plan whose they are instead
 * (whoseWords). The scope still applies to a "mine" plan; the source badge
 * says so, and so does "that you can see" where it can leave some out. */
export function recordsPhrase(cap: ModuleCap, plan: Pick<QueryPlan, 'mine'>, scopeKind: ScopeKind, createdWhen = ''): string {
  const records = `${groupLabel(cap)} ${lowerLabel(cap.labels.plural)}`;
  return plan.mine ? `${records} ${whoseWords(cap, plan.mine, scopeKind, createdWhen)}` : `${records}${visibleSuffix(scopeKind)}`;
}

/** For the history summaries: whoseWords where the scope can leave some of
 * the caller's own records out (minePartial), else ''. */
export function partialMineWords(cap: ModuleCap, plan: Pick<QueryPlan, 'mine'>, scopeKind: ScopeKind): string {
  return plan.mine && minePartial(cap, plan.mine, scopeKind) ? whoseWords(cap, plan.mine, scopeKind) : '';
}

/** What a narrower-than-everything scope means for this module: what the
 * scope keys off (QueryCaps.scopeBasis), not what "mine" means (the task
 * scope is "created by you", while "my tasks" are the ones assigned to you). */
export function scopeNoteFor(cap: ModuleCap, scopeKind: ScopeKind): string | undefined {
  if (scopeKind === 'all') return undefined;
  const plural = sentenceCase(cap.labels.plural);
  const team = scopeKind === 'team';
  switch (queryCapsFor(cap.key)?.scopeBasis) {
    case 'assigned':
      return `${plural} assigned to ${team ? 'your team' : 'you'}`;
    case 'created':
      return `${plural} created by ${team ? 'you or your team' : 'you'}`;
    case 'owner_or_created':
      return team ? `${plural} assigned to or created by you or your team` : `${plural} assigned to you or created by you`;
    case 'owned_or_created':
      return `${plural} owned or created by ${team ? 'you or your team' : 'you'}`;
    default:
      return `${plural} you can see`;
  }
}

/** How the rows are ordered: the sort that ran (a requested one), else
 * what the module's own list returns. */
export function sortPhrase(cap: ModuleCap, sort: { by: string; dir: 'asc' | 'desc' } = cap.sort.default): string {
  const { by, dir } = sort;
  if (by === 'createdAt' || by === '_id') return dir === 'desc' ? 'newest first' : 'oldest first';
  const field = cap.fields.find((f) => f.key === by || f.path === by);
  const label = lowerLabel(field?.label ?? by);
  if (by === 'updatedAt' || field?.kind === 'date' || field?.kind === 'datetime') {
    return `by ${label}, ${dir === 'desc' ? 'latest first' : 'earliest first'}`;
  }
  if (field?.kind === 'number' || field?.kind === 'money' || field?.kind === 'percent' || field?.kind === 'duration') {
    return `by ${label}, ${dir === 'desc' ? 'highest first' : 'lowest first'}`;
  }
  return dir === 'desc' ? `by ${label}, Z to A` : `by ${label}`;
}

export interface InterpretOptions {
  /** The plan's conditions in plain words (views/chips.ts conditionPhrases):
   * "that are overdue", "with amount more than ₹1,00,000", "in INR only". */
  conditions?: readonly string[];
  /** The sort that ran (executor Q reports it); else plan.sort, else the module's default. */
  sort?: { by: string; dir: 'asc' | 'desc' };
}

const BUCKET_WORDS: Readonly<Record<string, string>> = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "by source", "per month (created)". */
export function groupPhrase(cap: ModuleCap, group: NonNullable<QueryPlan['group']>): string {
  const field = cap.fields.find((f) => f.key === group.by || f.path === group.by);
  const label = lowerLabel(field?.label ?? group.by);
  return group.bucket ? `per ${BUCKET_WORDS[group.bucket] ?? group.bucket} (${label})` : `by ${label}`;
}

export function interpretPlan(plan: QueryPlan, cap: ModuleCap, scopeKind: ScopeKind, opts: InterpretOptions = {}): string {
  const group = groupLabel(cap);
  let records = recordsPhrase(cap, plan, scopeKind);
  const phrases = [...(opts.conditions ?? [])];
  // "Field Service leads created by you this week": a creation date right
  // after "created by you" doesn't say "created" twice, and stays before
  // "that you can see" (minePartial) when that follows.
  if (plan.mine && mineLabel(cap, plan.mine) === 'Created by you' && /^created \S/.test(phrases[0] ?? '')) {
    phrases[0] = phrases[0].slice('created '.length);
    if (minePartial(cap, plan.mine, scopeKind)) records = recordsPhrase(cap, plan, scopeKind, phrases.shift());
  }
  const conditions = phrases.length ? ` ${joinWithAnd(phrases)}` : '';
  if (plan.op === 'count') return `Number of ${records}${conditions}`;
  if (plan.op === 'aggregate' && plan.group) {
    return `Number of ${records}${conditions}, ${groupPhrase(cap, plan.group)}`;
  }
  if (plan.op === 'detail') {
    const number = plan.record && 'number' in plan.record ? ` ${plan.record.number}` : '';
    return `${group} ${lowerLabel(cap.labels.singular)}${number}`;
  }
  const page = plan.page && plan.page > 1 ? `, page ${plan.page}` : '';
  return `${records}${conditions}, ${sortPhrase(cap, opts.sort ?? plan.sort)}${page}`;
}

/** A per-source count of a concept ("customers"): never one total. `mine`:
 * only the caller's own in each source (each source's tile says how). */
export function interpretConcept(plural: string, mine = false): string {
  return `Number of ${mine ? 'your ' : ''}${lowerLabel(plural)} in each source you can use, counted separately`;
}

/** A named total (registry/metrics.ts): "Purchase amount from Field Service
 * invoices you can see, per customer, in each company's currency". `per`: the
 * breakdown's field label, when there is one. `ownCurrency`: the metric adds
 * each record in its own currency (MetricDef.currency, the deal totals: "in
 * each deal's own currency"). */
export function interpretMetric(
  plan: QueryPlan, cap: ModuleCap, scopeKind: ScopeKind, metricLabel: string,
  opts: { conditions?: readonly string[]; per?: string; ownCurrency?: boolean } = {},
): string {
  const records = recordsPhrase(cap, plan, scopeKind);
  const conditions = opts.conditions?.length ? ` ${joinWithAnd(opts.conditions)}` : '';
  const per = opts.per ? `, per ${lowerLabel(opts.per)}` : '';
  const currency = opts.ownCurrency ? `each ${lowerLabel(cap.labels.singular)}'s own currency` : "each company's currency";
  return `${metricLabel} from ${records}${conditions}${per}, in ${currency}`;
}

/* ── One-line history summaries (no rows, no values) ──────────────────── */

const noun = (cap: ModuleCap, n: number) => lowerLabel(n === 1 ? cap.labels.singular : cap.labels.plural);
const recordsOf = (cap: ModuleCap) => `${groupLabel(cap)} ${lowerLabel(cap.labels.plural)}`;

export const summaries = {
  /** `mine` (here, on count and on groups): only the caller's own records were read ("your").
   * `partial` (partialMineWords): the scope can leave some of them out, so the summary names whose
   * they are with "that you can see" instead ("No Native CRM tasks assigned to you that you can see."). */
  list: (cap: ModuleCap, shown: number, total: number, mine = false, partial = '') => {
    if (partial) return total === 0 ? `No ${recordsOf(cap)} ${partial}.` : `Listed ${shown} of ${total} ${groupLabel(cap)} ${noun(cap, total)} ${partial}.`;
    if (total === 0) return mine ? `You have no ${recordsOf(cap)} to show.` : `No ${recordsOf(cap)} to show.`;
    return `Listed ${shown} of ${mine ? 'your ' : ''}${total} ${groupLabel(cap)} ${noun(cap, total)}.`;
  },
  count: (cap: ModuleCap, total: number | null, mine = false, partial = '') => {
    if (partial) return total === null ? `Couldn't count ${recordsOf(cap)} ${partial}.` : `Counted ${total} ${groupLabel(cap)} ${noun(cap, total)} ${partial}.`;
    if (total === null) return `Couldn't count ${mine ? 'your ' : ''}${recordsOf(cap)}.`;
    return mine ? `Counted ${total} of your ${recordsOf(cap)}.` : `Counted ${total} ${groupLabel(cap)} ${noun(cap, total)}.`;
  },
  /** `number`: '' for a record opened by its id that has no number (a deal). */
  detail: (cap: ModuleCap, number: string) => (number
    ? `Showed ${groupLabel(cap)} ${lowerLabel(cap.labels.singular)} ${number}.`
    : `Showed a ${groupLabel(cap)} ${lowerLabel(cap.labels.singular)}.`),
  duplicates: (cap: ModuleCap, number: string, n: number) => `Found ${n} ${lowerLabel(cap.labels.plural)} numbered ${number}.`,
  /** `number`: null for a record asked for by its id (a choice's plan). */
  notFound: (cap: ModuleCap, number: string | null) => (number
    ? `No ${lowerLabel(cap.labels.singular)} numbered ${number} was found.`
    : `The ${lowerLabel(cap.labels.singular)} asked for was not found.`),
  /** A named total: how many rows and currencies it showed, never an amount. */
  metric: (cap: ModuleCap, label: string, rows: number, currencies: number, grouped: boolean) => {
    if (rows === 0) return `No ${recordsOf(cap)} to total for ${lowerLabel(label)}.`;
    const inCurrencies = currencies > 1 ? `, in ${currencies} currencies` : '';
    return grouped
      ? `Showed ${lowerLabel(label)} in ${rows} ${rows === 1 ? 'row' : 'rows'}${inCurrencies}.`
      : `Showed ${lowerLabel(label)} of ${recordsOf(cap)}${inCurrencies}.`;
  },
  /** A relation that couldn't run as asked: nothing was listed. */
  relationRefused: (cap: ModuleCap) => `Couldn't answer that about ${recordsOf(cap)}; nothing was listed.`,
  disabled: (cap: ModuleCap) => `${cap.labels.plural} are turned off for this company.`,
  noPermission: (cap: ModuleCap) => `No access to ${cap.labels.plural}.`,
  failed: (cap: ModuleCap) => `Couldn't read ${cap.labels.plural}.`,
  groups: (cap: ModuleCap, groups: number, total: number, mine = false, partial = '') => {
    const per = `in ${groups} ${groups === 1 ? 'group' : 'groups'}`;
    if (partial) return groups === 0 ? `No ${recordsOf(cap)} ${partial}.` : `Counted ${total} ${groupLabel(cap)} ${noun(cap, total)} ${partial}, ${per}.`;
    if (groups === 0) return mine ? `You have no ${recordsOf(cap)} to count.` : `No ${recordsOf(cap)} to count.`;
    return mine ? `Counted ${total} of your ${recordsOf(cap)} ${per}.` : `Counted ${total} ${groupLabel(cap)} ${noun(cap, total)} ${per}.`;
  },
  /** One part per source, e.g. "Field Service customers 9" ("Salesforce
   * Accounts 5000+" at a sync cap); never a total. `connectorsUnchecked`: the
   * connected CRMs couldn't be checked, so none of them is in the parts.
   * `mine`: each source counted only the caller's own. */
  concept: (plural: string, parts: readonly string[], connectorsUnchecked = false, mine = false) => `${parts.length
    ? `Counted ${mine ? 'your ' : ''}${lowerLabel(plural)} per source, never added together: ${parts.join('; ')}.`
    : `No ${lowerLabel(plural)} source to count.`}${connectorsUnchecked ? ' Connected CRMs could not be checked.' : ''}`,
  /** `lowerBound`: the count stopped at the vendor's sync cap, so there may be more ("5000+"). */
  connector: (label: string, value: number | null, status: string, lowerBound = false) => (value === null
    ? `${label}: ${status.replace(/_/g, ' ')}.`
    : `Counted ${lowerBound ? 'at least ' : ''}${value} ${label}.`),
  /** The read didn't finish before the resolve deadline. */
  timedOut: (what: string) => `Couldn't read ${what} in time.`,
  greeting: () => 'Greeted the user.',
  help: () => 'Listed what the assistant can answer.',
};
