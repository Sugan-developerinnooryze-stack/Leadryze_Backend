import type { QueryPlan } from '../contracts/plan';
import type { ModuleCap } from '../registry/types';
import type { PipelineFacts, PipelineOutcome, StageFact } from '../query/pipeline';
import { offPipelineDrillPlan, stageDrillPlan } from '../query/pipeline';
import type { PartialReason } from '../query/execute-query';
import { PIPELINE_CAPS } from '../contracts/views';
import type { PipelineBlock, PipelineStage, SectionState, ViewBlock } from '../contracts/views';
import { listLinkFor } from '../contracts/routes';
import type { ComposeEnv, ComposedAnswer, QueryRun } from './compose';
import {
  chipContextFor, clip, humanize, matchedBy, notice, planNotices, queryNoticeBlocks, relationPartialState, sourceRefFor,
} from './compose';
import type { RelationWords } from './chips';
import { conditionPhrases, filterChips } from './chips';
import { scrubIds } from './fallback-text';
import { groupLabel, interpretPlan, lowerLabel, partialMineWords, recordsPhrase } from './interpret';

/* The pipeline block (Increment 8): one module's records per stage of the
 * tenant's own pipeline (Pipeline & Stages settings), in its order, zero
 * counts included, each stage's money per currency (never added across
 * currencies), the list behind every stage that holds records, and the
 * records in no listed stage counted once, with what they are (a stage
 * removed from the pipeline, a key no longer in it, none) and their own list.
 * A state, stage or outcome condition hides the stages it rules out, never
 * one that holds records. The chips can't be removed (a pipeline has no
 * handle). The basis notice says where the stages come from and how the
 * money adds up. */

/** How each module's money per stage adds up (after the basis' first sentence). */
const MONEY_BASIS: Readonly<Record<string, string>> = {
  deal: 'Amounts add up each deal\'s amount in its own currency; a deal with no currency counts in its company\'s currency. Different currencies are never added together.',
  lead: 'Expected revenue adds up each lead\'s expected revenue in its company\'s currency. Different currencies are never added together.',
  invoice: 'Totals add up each invoice\'s total with tax in its company\'s currency, not what is still due. Different currencies are never added together.',
  quotation: 'Totals add up each quotation\'s total with tax in its company\'s currency. Different currencies are never added together.',
  contract: 'Totals add up each contract\'s total with tax in its company\'s currency, once per contract, not over its whole term. Different currencies are never added together.',
};
/** When a listed stage is marked cancelled by loadStageInfo's rule rather than by a tag. */
const CANCELLED_BASIS = 'Stages marked cancelled are final stages tagged cancelled or lost, or named cancelled, lost, rejected or disqualified.';

/** The off-pipeline note names this many parts; the rest are one part. */
const MAX_NOTE_PARTS = 3;
const MAX_NOTE_LABEL = 60;
/** contracts/views.ts PipelineStageSchema: key 80, label 120, outcome 40; StageAmount currency 8. */
const MAX_STAGE_KEY = 80;

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** The stage key a plan value names, as the compiler reads it (compile.ts
 * canonicalValue): the key, then the key in any case, then the same words,
 * then a stage label; unique matches only. */
function stageKeyNamed(stages: readonly StageFact[], raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim();
  const one = (found: readonly StageFact[]) => (found.length === 1 ? found[0].key : null);
  return stages.find((s) => s.key === v)?.key
    ?? one(stages.filter((s) => s.key.toLowerCase() === v.toLowerCase()))
    ?? one(stages.filter((s) => norm(s.key) === norm(v)))
    ?? one(stages.filter((s) => norm(s.label) === norm(v)));
}

/** The stages the plan's own conditions leave room for (decision N23): open,
 * overdue and due today only stages that aren't final; closed only final
 * ones; a stage condition its stages (ne, nin: all but them); an outcome the
 * stages tagged with it ('cancelled': the cancelled set too). */
function stagesAllowed(cap: ModuleCap, plan: QueryPlan, facts: PipelineFacts): (stage: StageFact) => boolean {
  const checks: Array<(stage: StageFact) => boolean> = [];
  const onStage = (key: string) => key === facts.fieldKey || cap.fields.find((f) => f.key === key)?.path === facts.field;
  for (const cond of plan.where ?? []) {
    if (cond.op === 'state') {
      if (cond.v === 'open' || cond.v === 'overdue' || cond.v === 'due_today') checks.push((s) => !s.terminal);
      else if (cond.v === 'closed') checks.push((s) => s.terminal);
    } else if (cond.op === 'outcome') {
      const outcome = cond.v.trim().toLowerCase();
      const has = (s: StageFact) => s.outcome === outcome || (outcome === 'cancelled' && facts.cancelled.has(s.key));
      checks.push(cond.not === true ? (s) => !has(s) : has);
    } else if ('f' in cond && onStage(cond.f)) {
      if (cond.op === 'empty') {
        checks.push(() => false);
        continue;
      }
      const values: readonly unknown[] | null = cond.op === 'eq' || cond.op === 'ne' ? [cond.v] : cond.op === 'in' || cond.op === 'nin' ? cond.v : null;
      if (!values) continue;
      const keys = new Set(values.map((v) => stageKeyNamed(facts.stages, v)).filter((k): k is string => k !== null));
      checks.push(cond.op === 'eq' || cond.op === 'in' ? (s) => keys.has(s.key) : (s) => !keys.has(s.key));
    }
  }
  return (stage) => checks.every((check) => check(stage));
}

/** The history line: how many records in how many stages, never an amount. */
function pipelineSummary(
  cap: ModuleCap, plan: QueryPlan, env: ComposeEnv, n: { total: number; withRecords: number; listed: number; off: number },
): string {
  const records = `${groupLabel(cap)} ${lowerLabel(cap.labels.plural)}`;
  const partial = partialMineWords(cap, plan, env.scopeKind);
  const noun = lowerLabel(n.total === 1 ? cap.labels.singular : cap.labels.plural);
  const where = `in ${n.withRecords} of ${n.listed} pipeline stages${n.off > 0 ? `; ${n.off} not in any stage` : ''}`;
  if (partial) return n.total === 0 ? `No ${records} ${partial}.` : `Counted ${n.total} ${groupLabel(cap)} ${noun} ${partial}, ${where}.`;
  if (n.total === 0) return plan.mine ? `You have no ${records} to count.` : `No ${records} to count.`;
  return plan.mine ? `Counted ${n.total} of your ${records} ${where}.` : `Counted ${n.total} ${groupLabel(cap)} ${noun} ${where}.`;
}

/** A pipeline answer: [PipelineBlock 'b1', the basis notice 'b2', then executor Q's notes]. */
export function composePipeline(cap: ModuleCap, plan: QueryPlan, outcome: PipelineOutcome, env: ComposeEnv, relation?: RelationWords): ComposedAnswer {
  const { facts, amount } = outcome;
  const source = sourceRefFor(cap, env.scopeKind);
  const run: QueryRun = { executor: 'Q', implied: outcome.implied, notices: outcome.notices };
  const chipCtx = chipContextFor(outcome.read, run);
  const filters = filterChips(cap, plan, chipCtx, false, relation);
  const plural = lowerLabel(cap.labels.plural);
  const field = lowerLabel(facts.fieldLabel);

  // Every active stage the plan leaves room for, and any that holds records,
  // in the tenant's order; past the cap their records join the off-pipeline ones.
  const byKey = new Map(outcome.rows.map((row) => [row.key, row]));
  const countOf = (key: string | null) => byKey.get(key)?.count ?? 0;
  const allowed = stagesAllowed(cap, plan, facts);
  const shown = facts.stages.filter((s) => s.active && (allowed(s) || countOf(s.key) > 0));
  const listed = shown.slice(0, PIPELINE_CAPS.stages);
  const pastCap = shown.slice(PIPELINE_CAPS.stages);

  // A stage key too long for the block gets a stable short one; its drill keeps the real key.
  const taken = new Set(listed.map((s) => s.key).filter((key) => key.length <= MAX_STAGE_KEY));
  const blockKey = (key: string, i: number): string => {
    if (key.length <= MAX_STAGE_KEY) return key;
    let short = `k${i}`;
    for (let n = 1; taken.has(short); n += 1) short = `k${i}_${n}`;
    taken.add(short);
    return short;
  };
  const leftOutCurrencies = new Set<string>();
  const stages: PipelineStage[] = listed.map((s, i) => {
    const row = byKey.get(s.key);
    const count = row?.count ?? 0;
    const money = (row?.amounts ?? []).filter((a) => Number.isFinite(a.v));
    money.slice(PIPELINE_CAPS.amounts).forEach((a) => leftOutCurrencies.add(a.currency));
    const amounts = money.slice(0, PIPELINE_CAPS.amounts).map((a) => ({ v: a.v, currency: clip(a.currency, 8) }));
    const drill = count > 0 ? stageDrillPlan(plan, facts.fieldKey, s.key) : undefined;
    return {
      key: blockKey(s.key, i), label: clip(s.label, 120), ...(s.color ? { color: s.color } : {}), order: i, terminal: s.terminal,
      ...(s.outcome ? { outcome: clip(s.outcome, 40) } : {}), count,
      ...(amounts.length ? { amounts } : {}),
      ...(drill ? { drill: { plan: drill, section: cap.group, executor: 'Q' as const } } : {}),
    };
  });

  // The records in no listed stage, once: stages past the cap, removed stages
  // (most first, then pipeline order), keys no longer in the pipeline (most
  // first, then A to Z), then none; a 4th part and beyond are one part.
  const factOf = new Map(facts.stages.map((s) => [s.key, s]));
  const positionOf = new Map(facts.stages.map((s, i) => [s.key, i]));
  const parts: Array<{ count: number; text: string }> = [];
  const past = pastCap.reduce((n, s) => n + countOf(s.key), 0);
  if (past > 0) parts.push({ count: past, text: `${past} on stages past the first ${PIPELINE_CAPS.stages}` });
  outcome.rows
    .filter((row) => row.key !== null && row.count > 0 && factOf.get(row.key)?.active === false)
    .sort((a, b) => b.count - a.count || (positionOf.get(a.key!) ?? 0) - (positionOf.get(b.key!) ?? 0))
    .forEach((row) => parts.push({ count: row.count, text: `${row.count} on ${clip(factOf.get(row.key!)!.label, MAX_NOTE_LABEL)} (removed from the pipeline)` }));
  outcome.rows
    .filter((row) => row.key !== null && row.count > 0 && !factOf.has(row.key))
    .map((row) => ({ count: row.count, label: clip(humanize(row.key!), MAX_NOTE_LABEL) }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .forEach((u) => parts.push({ count: u.count, text: `${u.count} on ${u.label} (not in the pipeline)` }));
  const none = countOf(null);
  if (none > 0) parts.push({ count: none, text: `${none} with no ${field}` });
  const off = parts.reduce((n, p) => n + p.count, 0);
  const named = parts.slice(0, MAX_NOTE_PARTS);
  const rest = parts.slice(MAX_NOTE_PARTS).reduce((n, p) => n + p.count, 0);
  const words = [...named.map((p) => p.text), ...(rest > 0 ? [`${rest} on other stages not in the pipeline`] : [])];
  const offDrill = off > 0 ? offPipelineDrillPlan(plan, facts.fieldKey, listed.map((s) => s.key)) : undefined;
  const offPipeline: PipelineBlock['offPipeline'] = off > 0 ? {
    count: off,
    note: clip(scrubIds(`${off} ${lowerLabel(off === 1 ? cap.labels.singular : cap.labels.plural)} ${off === 1 ? 'is' : 'are'} not in any stage above: ${words.join(', ')}.`), 300),
    ...(offDrill ? { drill: { plan: offDrill, section: cap.group, executor: 'Q' as const } } : {}),
  } : undefined;
  const total = stages.reduce((n, s) => n + s.count, 0) + off;

  const relationState = relationPartialState(relation);
  const rowCap = outcome.partialReasons?.includes('row_cap') ?? false;
  const reasons = new Set<PartialReason>();
  const messages: string[] = [];
  if (rowCap) {
    reasons.add('row_cap');
    messages.push(`Some ${plural} may be missing: there were more stage and currency combinations than one answer holds.`);
  }
  const cut = [
    ...(pastCap.length ? [`Showing the first ${PIPELINE_CAPS.stages} of ${shown.length} stages.`] : []),
    ...(leftOutCurrencies.size
      ? [`Amounts in ${leftOutCurrencies.size} more ${leftOutCurrencies.size === 1 ? 'currency' : 'currencies'} are not shown.`] : []),
  ];
  if (cut.length) {
    reasons.add('section_cap');
    messages.push(cut.join(' '));
  }
  for (const reason of [...(relationState?.partialReasons ?? []), ...(outcome.partialReasons ?? [])]) reasons.add(reason);
  if (relationState?.message) messages.push(relationState.message);
  let state: SectionState = { status: 'ok' };
  if (total === 0) {
    // The filters are repeated, so an empty answer says what was asked (as composeGroups does).
    const matched = matchedBy(filters);
    const visible = recordsPhrase(cap, plan, env.scopeKind);
    state = {
      status: 'empty', message: clip(scrubIds(matched.length ? `No ${visible} match: ${matched.join(', ')}.` : `No ${visible} to count yet.`), 500),
      ...(reasons.size ? { partialReasons: [...reasons] } : {}),
    };
  } else if (reasons.size) {
    state = {
      status: 'partial', partialReasons: [...reasons],
      ...(messages.length ? { message: clip(messages.join(' '), 500) } : {}),
      ...(rowCap ? { lowerBound: true } : {}),
    };
  }

  const asked = interpretPlan(plan, cap, env.scopeKind, { conditions: conditionPhrases(cap, plan, chipCtx, relation) });
  const money = !amount ? ''
    : amount.currency === 'record' ? `, with ${amount.words} in each ${lowerLabel(cap.labels.singular)}'s own currency`
      : `, with ${amount.words} in each company's currency`;
  const interpretedAs = clip(`${asked} in pipeline order${money}`, 300);
  const basis = [
    `Stages are in your pipeline order from Pipeline & Stages settings, and each counts the ${plural} in it now.`,
    ...(amount && MONEY_BASIS[cap.key] ? [MONEY_BASIS[cap.key]] : []),
    ...(listed.some((s) => s.cancelledByRule) ? [CANCELLED_BASIS] : []),
  ].join(' ');

  const listLink = listLinkFor(cap.key);
  const block: PipelineBlock = {
    id: 'b1',
    type: 'pipeline',
    title: clip(`${cap.labels.plural} by ${field}`, 200),
    source,
    state,
    filters,
    interpretedAs,
    stages,
    ...(amount ? { amountLabel: clip(amount.label, 60) } : {}),
    ...(offPipeline ? { offPipeline } : {}),
    ...(listLink ? { listLink } : {}),
  };
  const blocks: ViewBlock[] = [
    block,
    notice('b2', 'pipeline_basis', basis, 'info', { source }),
    ...queryNoticeBlocks([...outcome.notices, ...planNotices(cap, plan)], source, 'b', 3),
  ];
  const summary = pipelineSummary(cap, plan, env, { total, withRecords: stages.filter((s) => s.count > 0).length, listed: stages.length, off });
  return { blocks, summary, interpretedAs, plan, dataRead: true };
}
