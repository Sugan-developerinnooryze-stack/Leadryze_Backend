import { QueryPlanSchema } from '../contracts/plan';
import type { QueryPlan } from '../contracts/plan';
import type { GrammarContext } from './context';
import type { GrammarParse } from './parse';
import { phraseWordsV1, tokenizeV1 } from './tokens';
import type { WordToken } from './tokens';
import { matchDateExpr } from './dates';
import type { DateValue } from './dates';
import {
  AGENDA_FILLERS, AGENDA_NOUNS, AGENDA_OPENERS, AGENDA_OPENER_GAPS, AgendaKind, CONNECTOR_PHRASES, MAX_GRAMMAR_WORDS,
} from './vocabulary';

/* The agenda across modules (Increment 8, agenda.md 4.7, decision N26):
 * "what's on today", "what do we need to do this week", "my agenda", "what's
 * overdue", "what's coming up", "what's on 5 November". A question that names
 * no module, made only of an opener or an agenda noun, fillers and at most one
 * date, as whole lower-cased English words with every word used and no LLM
 * call. A module named anywhere but in an opener ("tasks due today", "meetings
 * this week" are module reads, and "what tasks do we need to do" is refused),
 * one of the caller's Custom Modules, a vendor, a business number, a write
 * verb, a second date, "or", or a name ("what's on for Rao") is not an agenda:
 * every such word is unknown here. The plan is { op 'agenda', target {
 * concept 'agenda' } } with the window or the overdue state; which executor
 * answers it, and in which modules, is decided when it runs (query/agenda.ts).
 * Pure: no clock of its own (GrammarContext.todayKey). */

type AgendaParse = Extract<GrammarParse, { kind: 'agenda' }>;

/** How many tokens `words` take at toks[i], with AGENDA_OPENER_GAPS between
 * them ("what all do we need to do"), or 0. */
function gappedAt(toks: readonly WordToken[], i: number, words: readonly string[]): number {
  let j = i;
  for (let k = 0; k < words.length; k += 1) {
    if (k > 0) while (j < toks.length && toks[j].w !== words[k] && AGENDA_OPENER_GAPS.has(toks[j].w)) j += 1;
    if (toks[j]?.w !== words[k]) return 0;
    j += 1;
  }
  return j - i;
}

/** The longest opener at toks[i]. */
function openerAt(toks: readonly WordToken[], i: number): { kind: AgendaKind; length: number } | null {
  let best: { kind: AgendaKind; length: number } | null = null;
  for (const o of AGENDA_OPENERS) {
    const length = gappedAt(toks, i, o.words);
    if (length && (!best || length > best.length)) best = { kind: o.kind, length };
  }
  return best;
}

/** The length of the longest agenda noun at toks[i] ("my plate"), or 0. */
function nounAt(toks: readonly WordToken[], i: number): number {
  let best = 0;
  for (const words of AGENDA_NOUNS) {
    if (words.length > best && words.every((w, k) => toks[i + k]?.w === w)) best = words.length;
  }
  return best;
}

/** Registry module names and vendor names as v1 words, built once per synonym index. */
const registryNames = new WeakMap<object, ReadonlyArray<readonly string[]>>();

/** Words that name records or where they live: a registry module, one of the
 * caller's Custom Modules (any word may be one: "Agenda", "Plate") or a vendor. */
function nameWords(ctx: GrammarContext): ReadonlyArray<readonly string[]> {
  let registry = registryNames.get(ctx.synonyms);
  if (!registry) {
    registry = [...ctx.synonyms.map((s) => phraseWordsV1(s.phrase)), ...CONNECTOR_PHRASES.map((p) => p.words)].filter((w) => w.length > 0);
    registryNames.set(ctx.synonyms, registry);
  }
  const custom = (ctx.customModules ?? []).flatMap((m) => m.words.map((w) => phraseWordsV1(w))).filter((w) => w.length > 0);
  return [...registry, ...custom];
}

/** A name of records anywhere but in an opener ("to do" in "what do we need to do" asks what to do). */
function namesRecords(toks: readonly WordToken[], opened: ReadonlySet<number>, ctx: GrammarContext): boolean {
  return nameWords(ctx).some((words) => {
    for (let i = 0; i + words.length <= toks.length; i += 1) {
      if (words.every((w, k) => toks[i + k].w === w) && words.some((_, k) => !opened.has(i + k))) return true;
    }
    return false;
  });
}

/** The agenda a module-less question asks for, or null (agenda.md 4.7).
 * Mapping: an overdue opener and no date: the overdue state; "coming up",
 * "upcoming" and no date: the next 7 days; no date otherwise: everything the
 * Daily Events panel shows (no window); a relative date ("today", "this
 * week", "next 7 days"): that window; a written day or range ("on 5
 * November", "between 1 and 15 November"): from and to; an open-ended date
 * ("since Monday"), or an overdue opener with a date, is not read. "next 7
 * days" alone is Daily Events' own Next 7 days (agenda.md T1). */
export function parseAgenda(message: string, ctx: GrammarContext): AgendaParse | null {
  const tokens = tokenizeV1(typeof message === 'string' ? message : '');
  if (!tokens.length || tokens.length > MAX_GRAMMAR_WORDS) return null;
  const toks: WordToken[] = [];
  // A business number names one record.
  for (const t of tokens) {
    if (t.kind !== 'word') return null;
    toks.push(t);
  }
  const opts = ctx.todayKey ? { todayKey: ctx.todayKey } : {};
  const kinds: AgendaKind[] = [];
  const dates: DateValue[] = [];
  let nouns = 0;
  const opened = new Set<number>();
  // Longest piece first at every position: an opener, an agenda noun or a
  // date (in that order when they are as long); else a filler.
  for (let i = 0; i < toks.length;) {
    const opener = openerAt(toks, i);
    const noun = nounAt(toks, i);
    const date = matchDateExpr(toks, i, opts);
    const length = Math.max(opener?.length ?? 0, noun, date?.length ?? 0);
    if (!length) {
      if (!AGENDA_FILLERS.has(toks[i].w)) return null;
      i += 1;
      continue;
    }
    if (opener && opener.length === length) {
      kinds.push(opener.kind);
      for (let k = i; k < i + length; k += 1) opened.add(k);
    } else if (noun === length) nouns += 1;
    else if (date) dates.push(date.value);
    i += length;
  }
  if (kinds.length > 1 || nouns > 1 || dates.length > 1) return null;
  const [kind] = kinds;
  const [date] = dates;
  if (!kind && !nouns && !(date?.kind === 'within' && date.rel === 'next_7_days')) return null;
  if (namesRecords(toks, opened, ctx)) return null;

  let part: Pick<QueryPlan, 'window' | 'where'>;
  if (kind === 'overdue') {
    // "what's overdue this week": overdue now, or due this week?
    if (date) return null;
    part = { where: [{ op: 'state', v: 'overdue' }] };
  } else if (!date) part = kind === 'upcoming' ? { window: 'next_7_days' } : {};
  else if (date.kind === 'within') part = { window: date.rel };
  else if (date.kind === 'between') part = { window: { from: date.from, to: date.to } };
  else return null;
  const plan: QueryPlan = { v: 1, op: 'agenda', target: { concept: 'agenda' }, ...part };
  if (!QueryPlanSchema.safeParse(plan).success) return null;
  return { kind: 'agenda', op: 'agenda', plan, modules: [], filterKeys: part.where ? ['state'] : part.window ? ['window'] : [] };
}
