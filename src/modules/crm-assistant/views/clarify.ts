import type { CapabilityView } from '../capability-view';
import type { GrammarContext } from '../grammar/context';
import type { ModuleCap } from '../registry/types';
import { getModuleCap } from '../registry';
import type { RelationDef } from '../registry/relations';
import type { ClarifyBlock, ClarifyOption, NoticeBlock } from '../contracts/views';
import { VIEW_CAPS } from '../contracts/views';
import type { ExecuteFallbackWait } from '../contracts/api';
import { PLANNER_CAPS, estimateTokens } from '../contracts/plan';
import type { QueryPlan } from '../contracts/plan';
import type { EntityChoice } from '../query/relations';
import { rankModules } from '../planner-catalog';
import type { GroundingDrop, GroundingFix } from '../planner-grounding';
import type { ComposedAnswer } from './compose';
import { humanize } from './chips';
import { scrubIds } from './fallback-text';
import { groupLabel, lowerLabel, summaries } from './interpret';

/* Server-written clarify answers (Increment 4): one ClarifyBlock when the
 * assistant can't answer as asked, with choices that each say exactly what
 * they run. A plan choice re-runs as the caller (no LLM call); "Try again"
 * and the planner's own options are sent as if typed; "Use the classic
 * assistant" hands the message to the existing assistant (action legacy).
 * Every text here is server-written, except the planner's own question and
 * options, which are cleaned and cut to size first. No answer here reads a
 * record, so the badge is the default one and the session's last plan stays.
 *
 * The history summary is one line that never ends in "?": the AI service
 * reads a reply ending in "?" as the existing assistant's question and
 * skips the engine on the next turn.
 *
 * Also here: the notes that a value the planner wrote isn't in the message
 * (grounding). A fill for the session's open form is applied to it since
 * Increment 6 (assist.internal.routes.ts); only "no open form" is said here.
 *
 * Increment 5 adds the questions back that a read asks: which record a name
 * means (ambiguous_entity) or which one "this <record>" is (no_focus), each
 * choice re-running the same plan for that record by its _id; and which
 * module a word means when it names a built-in module and one of the
 * tenant's Custom Modules (ambiguous_module). No two of their choices read
 * alike (decision D3): the label picked is also the staff member's line in
 * the chat. */

export type ClarifyReason = ClarifyBlock['reason'];

/** What the choices are built from: the caller's modules (null when they
 * couldn't be read in time: no plan choices), the message as typed ('' when
 * there is none: no "Try again" or classic choice) and, when loaded, the
 * grammar context (the tenant's stage labels help rank the examples). */
export interface ClarifyContext {
  view: CapabilityView | null;
  message: string;
  grammar?: GrammarContext | null;
}

const TEXTS = {
  tooLong: "That's longer than I can read in one go. Ask a shorter question, or pick one of these.",
  busy: "I'm answering a lot of questions right now. Try again in a minute, or pick one of these.",
  busyPlatform: (wait: string) => `I'm answering a lot of questions right now. Try again in ${wait}, or pick one of these.`,
  busyTenant: (wait: string) => `I can work out one new question like this a minute for your company. Ask again in ${wait}, or pick one of these.`,
  unavailable: "I couldn't work that out just now. Try again in a moment, or pick one of these.",
  unavailableWait: (wait: string) => `I couldn't work that out just now. Try again in ${wait}, or pick one of these.`,
  notUnderstood: "I couldn't work out what to look up. Pick one of these, or ask in other words.",
  classicWrite: "I can't make changes myself yet. The classic assistant can do this for you.",
  classicPlan: "I can't answer that kind of question myself yet. The classic assistant can try.",
  outOfScope: 'I can help with your CRM records, for example:',
  noFocus: "There's no open form in this chat to fill in. Ask for what you need, or open the record first.",
  notInTime: 'That took too long. Try again in a moment.',
  plannerFallbackQuestion: 'Which records do you mean?',
  ambiguousModule: 'That name is used by more than one module. Which one do you mean?',
  parentFallbackQuestion: 'Which record do you mean?',
  noParentToChoose: (singular: string, plural: string) => `No ${singular} is open, and you can't see any ${plural} to choose from.`,
} as const;

/** Bare "pipeline" (Increment 8): asked with the caller's pipelines as choices (composeAmbiguousModule). */
export const PIPELINE_QUESTION = 'Which pipeline do you mean?';

/** Why the choices were offered, in the history summary's own words. */
const REASON_PHRASES: Readonly<Record<ClarifyReason, string>> = {
  ambiguous_entity: 'more than one record matched',
  ambiguous_module: 'more than one module matched',
  ambiguous_source: 'more than one source matched',
  missing_value: 'a detail was missing',
  no_focus: 'no open form',
  unsupported: 'not about the CRM',
  not_understood: 'the question was not understood',
  planner_unavailable: 'the assistant was unavailable',
  planner_busy: 'the assistant was busy',
  too_long: 'the question was too long',
  needs_classic: 'needs the classic assistant',
  duplicate_number: 'several records share that number',
};

const CLASSIC_LABEL = 'Use the classic assistant';
const CLASSIC_DETAIL = 'Answers with the full assistant; slower and uses more of your AI allowance.';
/** A message a choice may carry (the chat's own limit). */
const MAX_MESSAGE = 4000;
/** The planner's question, options and how many of them (the planner output's own limits). */
const PLANNER_QUESTION_MAX = 200;
const PLANNER_OPTION_MAX = 80;
const MAX_PLANNER_OPTIONS = 5;
const MAX_OPTIONS = 10;
/** A value named in a "left out" note. */
const DROPPED_VALUE_MAX = 60;
/** Control, format and line-separator characters (text-direction marks,
 * zero-width spaces, soft hyphens, invisible TAG letters, U+061C, U+2028/9).
 * The zero-width joiners stay: Indic words use them. */
const UNSAFE_CHARS = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end).trim();
}

/** Model or user text made safe to show: no control characters, one space
 * between words, no record ids, at most `max` characters. */
function cleaned(text: string, max: number): string {
  return cut(scrubIds(text.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ')), max);
}

/** "about 40 seconds", "about a minute", "about 2 minutes". */
function waitPhrase(seconds: number): string {
  if (seconds < 55) return `about ${Math.max(5, Math.ceil(seconds / 5) * 5)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? 'about a minute' : `about ${minutes} minutes`;
}

/** What a planner choice sends: the question as first asked with the choice
 * after it ("open deals with ABC (ABC Industries)"), so the planner, which
 * never sees the conversation, reads the whole question again. Within what
 * the planner reads (PLANNER_CAPS): what doesn't fit is cut from the end of
 * the question, never from the choice. Without the question, the choice alone. */
function withChoice(original: string, label: string): string {
  const tail = ` (${label})`;
  let head = cut(original.replace(/\s+/g, ' ').trim(), Math.max(0, PLANNER_CAPS.messageChars - tail.length));
  while (head && estimateTokens(`${head}${tail}`) > PLANNER_CAPS.messageEstTokens) {
    head = head.length > 20 ? cut(head, head.length - 20) : '';
  }
  return head ? `${head}${tail}` : label;
}

/** A number as a note shows it: digits, at most two decimals, no grouping. */
function plainNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** `phrase`: why, in the summary's words, when the reason's own phrase doesn't fit (REASON_PHRASES). */
function clarify(reason: ClarifyReason, question: string, options: readonly ClarifyOption[], phrase: string = REASON_PHRASES[reason]): ComposedAnswer {
  const block: ClarifyBlock = { id: 'b1', type: 'clarify', question, reason, options: options.slice(0, MAX_OPTIONS) };
  return {
    blocks: [block],
    // With nothing to pick (no open form, or the planner's question alone) no choice was offered.
    summary: block.options.length
      ? `Offered choices (${phrase}).`
      : `Couldn't answer as asked (${phrase}).`,
    dataRead: false,
  };
}

function notice(id: string, code: string, text: string, tone: NoticeBlock['tone'] = 'info'): NoticeBlock {
  return { id, type: 'notice', tone, code, text: cut(scrubIds(text), 1000) };
}

/* ── Choices ───────────────────────────────────────────────────────────── */

function show(cap: ModuleCap): ClarifyOption {
  return {
    label: `Show ${lowerLabel(cap.labels.plural)}`,
    detail: groupLabel(cap),
    run: { plan: { v: 1, op: 'list', target: { module: cap.key } } },
  };
}

function howMany(cap: ModuleCap): ClarifyOption {
  return {
    label: `How many ${lowerLabel(cap.labels.plural)}?`,
    detail: groupLabel(cap),
    run: { plan: { v: 1, op: 'count', target: { module: cap.key } } },
  };
}

/** Up to 3 plan choices from the caller's own modules, ranked by the message
 * as the planner catalog ranks them (rankModules): "Show <first>", "Show
 * <second>", "How many <third, else first>?". Plain plans with no condition,
 * so each runs under the caller's own gates like any other plan. */
export function examples(view: CapabilityView | null, message: string, grammar: GrammarContext | null = null): ClarifyOption[] {
  if (!view) return [];
  const picks = rankModules(message, view, grammar).slice(0, 3).map((ranked) => ranked.cap);
  if (!picks.length) return [];
  const options = [show(picks[0])];
  if (picks[1]) options.push(show(picks[1]));
  options.push(howMany(picks[2] ?? picks[0]));
  return options;
}

/** Hands the message, unchanged, to the existing assistant (action legacy). */
export function classic(message: string): ClarifyOption {
  return { label: CLASSIC_LABEL, detail: CLASSIC_DETAIL, run: { legacy: { message } } };
}

/** Sends the message again, as if typed. */
export function tryAgain(message: string): ClarifyOption {
  return { label: 'Try again', run: { message } };
}

/** A choice that carries the message only when there is one to carry. */
function withMessage(message: string, choice: (message: string) => ClarifyOption): ClarifyOption[] {
  return message.trim() && message.length <= MAX_MESSAGE ? [choice(message)] : [];
}

function examplesFor(ctx: ClarifyContext): ClarifyOption[] {
  return examples(ctx.view, ctx.message, ctx.grammar ?? null);
}

/* ── Answers ───────────────────────────────────────────────────────────── */

/** Longer than the planner reads (PLANNER_CAPS): never sent to it. */
export function composeTooLong(ctx: ClarifyContext): ComposedAnswer {
  return clarify('too_long', TEXTS.tooLong, [...examplesFor(ctx), ...withMessage(ctx.message, classic)]);
}

/** The governor or the provider's rate limit refused the planner call.
 * `wait`, when the AI service knows it, says whose limit it was (the
 * tenant's one planner question a minute, or the platform's budget) and
 * about when a new question can run. */
export function composePlannerBusy(ctx: ClarifyContext, wait?: ExecuteFallbackWait): ComposedAnswer {
  const question = !wait ? TEXTS.busy
    : wait.by === 'tenant' ? TEXTS.busyTenant(waitPhrase(wait.seconds)) : TEXTS.busyPlatform(waitPhrase(wait.seconds));
  return clarify('planner_busy', question, [...withMessage(ctx.message, tryAgain), ...examplesFor(ctx)]);
}

/** The planner's provider failed (or the server couldn't use its answer in
 * time). `wait`: when the failed call still holds the tenant's planner slot,
 * about when "Try again" can run. */
export function composePlannerUnavailable(ctx: ClarifyContext, wait?: ExecuteFallbackWait): ComposedAnswer {
  const question = wait ? TEXTS.unavailableWait(waitPhrase(wait.seconds)) : TEXTS.unavailable;
  return clarify('planner_unavailable', question, [...withMessage(ctx.message, tryAgain), ...examplesFor(ctx)]);
}

/** The planner's answer couldn't be used: invalid, truncated, or a plan that can't run as written. */
export function composeNotUnderstood(ctx: ClarifyContext): ComposedAnswer {
  return clarify('not_understood', TEXTS.notUnderstood, [...examplesFor(ctx), ...withMessage(ctx.message, classic)]);
}

/** Only the existing assistant can do this yet: a change ('write': a module
 * without a guided form, or guided forms off, Increment 6), or a plan this
 * engine can't run yet ('plan': relations, date windows, agendas, charts, ...). */
export function composeNeedsClassic(ctx: ClarifyContext, what: 'write' | 'plan'): ComposedAnswer {
  const handOff = withMessage(ctx.message, classic);
  return what === 'write'
    ? clarify('needs_classic', TEXTS.classicWrite, handOff)
    : clarify('needs_classic', TEXTS.classicPlan, [...handOff, ...examplesFor(ctx)]);
}

/** The planner's own question back, cleaned and cut to size. Each of its
 * options (at most 5, no repeats) is sent as if typed, together with the
 * question as first asked (`original`; see withChoice). With no option to
 * pick, the question can go to the existing assistant, which has the
 * conversation. */
export function composePlannerClarify(question: string, options: readonly string[] = [], original = ''): ComposedAnswer {
  const asked = cleaned(question, PLANNER_QUESTION_MAX) || TEXTS.plannerFallbackQuestion;
  const seen = new Set<string>();
  const choices: ClarifyOption[] = [];
  for (const option of options) {
    const label = cleaned(option, PLANNER_OPTION_MAX);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    choices.push({ label, run: { message: withChoice(original, label) } });
    if (choices.length >= MAX_PLANNER_OPTIONS) break;
  }
  return clarify('missing_value', asked, choices.length ? choices : withMessage(original, classic));
}

/** Not about this CRM: what it can do instead. */
export function composeOutOfScope(ctx: ClarifyContext): ComposedAnswer {
  return clarify('unsupported', TEXTS.outOfScope, examplesFor(ctx));
}

/** Values typed for a form, but no form of this session's own is open. */
export function composeNoFocus(): ComposedAnswer {
  return clarify('no_focus', TEXTS.noFocus, []);
}

/** Nothing could run before the answer's deadline (the caller's modules, or
 * the open form, weren't read in time). */
export function composeNotInTime(): ComposedAnswer {
  return {
    blocks: [notice('b1', 'query_timeout', TEXTS.notInTime, 'warning')],
    summary: "Couldn't answer in time.",
    dataRead: false,
  };
}

/** After the answer's own blocks and within the block cap: one note per
 * number grounding read from the message in place of what the planner
 * copied ("5" of "5 lakh"; planner-grounding.ts GroundingFix), then one per
 * value the planner wrote that isn't in the message; values that don't fit
 * are counted in the last note. */
export function withGroundingNotices(
  composed: ComposedAnswer, dropped: readonly GroundingDrop[], fixed: readonly GroundingFix[] = [],
): ComposedAnswer {
  const fixes = [...new Set(fixed.map((f) => {
    const value = cleaned(f.value, DROPPED_VALUE_MAX);
    const to = `${plainNumber(f.to)}${f.unit ? ` ${f.unit}` : ''}`;
    return value ? `I read “${value}” as ${to}, as your message writes it.` : `I read a number as ${to}, as your message writes it.`;
  }))];
  const values = [...new Set(dropped.map((d) => cleaned(d.value, DROPPED_VALUE_MAX)))];
  let room = VIEW_CAPS.blocks - composed.blocks.length;
  const notes: NoticeBlock[] = [];
  const next = () => `b${composed.blocks.length + notes.length + 1}`;
  for (const text of fixes) {
    if (room < 1) break;
    notes.push(notice(next(), 'number_from_message', text));
    room -= 1;
  }
  if (values.length && room >= 1) {
    const named = values.length <= room ? values : values.slice(0, room - 1);
    const texts = named.map((value) => (value
      ? `I left out “${value}” because it isn't in your message.`
      : "I left out a value because it isn't in your message."));
    const rest = values.length - named.length;
    if (rest > 0) texts.push(`I left out ${rest}${named.length ? ' more' : ''} values because they aren't in your message.`);
    for (const text of texts) notes.push(notice(next(), 'not_from_message', text, 'warning'));
  }
  return notes.length ? { ...composed, blocks: [...composed.blocks, ...notes] } : composed;
}

/* ── Increment 5: which record, which module ───────────────────────────── */

/** At most this many characters in a choice's label (contracts/views.ts ClarifyOptionSchema). */
const MAX_LABEL = 120;

/** The labels, case aside, that more than one choice carries. */
function repeatedLabels(labels: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label.toLowerCase(), (counts.get(label.toLowerCase()) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([label]) => label));
}

/** Labels that repeat, each told apart by its place among those that read
 * like it: `relabel(i, n)` writes the i-th label as the n-th (1, 2, ...) of
 * them. The others stay as they are. */
function toldApart(labels: readonly string[], relabel: (i: number, n: number) => string): string[] {
  const repeated = repeatedLabels(labels);
  const seen = new Map<string, number>();
  return labels.map((label, i) => {
    const key = label.toLowerCase();
    if (!repeated.has(key)) return label;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return relabel(i, n);
  });
}

/** A record a relation named, as a choice: its name and number ("Acme
 * Industries (ABC123-CUS-0001)"), what tells it apart ("Zen Group ·
 * Chennai"), and the same plan re-run for it by its _id (entity { ref },
 * query/relations.ts EntityChoice). The label is also the staff member's
 * line in the chat when picked. */
function entityOption(choice: EntityChoice): ClarifyOption {
  const { match, plan } = choice;
  const named = match.number && match.number !== match.label ? `${match.label} (${match.number})` : match.label;
  const detail = match.detail ? cleaned(match.detail, 200) : '';
  return { label: cleaned(named, MAX_LABEL) || 'This record', ...(detail ? { detail } : {}), run: { plan } };
}

const ORDINALS = ['Newest', 'Second newest', 'Third newest'];

/** The choices, newest first (as the records were found). Records that read
 * the same (two invoices sharing a number, which is also their name; two
 * people of one name) take what tells them apart into the label: their
 * detail, when that differs for each of them ("Ravi Kumar · Zen Group"),
 * else their order ("ABC123-INV-0001 · Newest"). */
function entityOptions(choices: readonly EntityChoice[]): ClarifyOption[] {
  const options = choices.map(entityOption);
  const repeated = repeatedLabels(options.map((o) => o.label));
  const withDetail = options.map((o) => (o.detail ? cut(`${o.label} · ${o.detail}`, MAX_LABEL) : o.label));
  const told = options.map((option, i): ClarifyOption => {
    const key = option.label.toLowerCase();
    if (!repeated.has(key) || !option.detail) return option;
    const alike = options.flatMap((o, j) => (o.label.toLowerCase() === key ? [withDetail[j].toLowerCase()] : []));
    if (new Set(alike).size < alike.length) return option;
    const { detail: _detail, ...rest } = option;
    return { ...rest, label: withDetail[i] };
  });
  const labels = toldApart(told.map((o) => o.label), (i, n) => {
    const order = ` · ${ORDINALS[n - 1] ?? `Number ${n} by newest`}`;
    return `${cut(told[i].label, MAX_LABEL - order.length)}${order}`;
  });
  return told.map((option, i) => (labels[i] === option.label ? option : { ...option, label: labels[i] }));
}

/** Several records the caller can see match the name a relation gave
 * ("work orders for Acme"): a choice each; when more than ten matched, the
 * newest ten and a note to type more of the name. */
export function composeEntityChoices(rel: { question: string; choices: readonly EntityChoice[]; moreHint?: string }): ComposedAnswer {
  const composed = clarify('ambiguous_entity', cleaned(rel.question, 300) || TEXTS.parentFallbackQuestion, entityOptions(rel.choices));
  return rel.moreHint
    ? { ...composed, blocks: [...composed.blocks, notice('b2', 'more_matches', rel.moreHint)] }
    : composed;
}

/** "Invoices for this work order" with no work order on screen (or one the
 * caller can no longer see): the newest the caller can see, a choice each.
 * With none they can see, a note that says so, not a question with nothing
 * to pick; nothing was listed. */
export function composeParentChoices(
  rel: { question: string; choices: readonly EntityChoice[]; parent: ModuleCap; relation: RelationDef },
): ComposedAnswer {
  if (!rel.choices.length) {
    const child = getModuleCap(rel.relation.child);
    return {
      blocks: [notice('b1', 'no_focus', TEXTS.noParentToChoose(lowerLabel(rel.parent.labels.singular), lowerLabel(rel.parent.labels.plural)))],
      summary: child ? summaries.relationRefused(child) : "Couldn't answer as asked (no record was open).",
      dataRead: false,
    };
  }
  return clarify('no_focus', cleaned(rel.question, 300) || TEXTS.parentFallbackQuestion, entityOptions(rel.choices), 'no record was open');
}

/** "1st", "2nd", "3rd", "4th". */
function nth(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** What a breakdown's rows are counted by, in lower case: the date bucket
 * ("month"); else `by`, when the caller knows the field's label (a Custom
 * Module's, from its definition); the built-in field's label; or the field's
 * key in words ("data.equipment_type": "equipment type"). */
function breakdownWords(group: NonNullable<QueryPlan['group']>, module: string, by?: string): string {
  const field = getModuleCap(module)?.fields.find((f) => f.key === group.by || f.path === group.by);
  const words = group.bucket || by?.trim() || field?.label || humanize(group.by.replace(/^data\./, ''));
  return cut(words.toLowerCase(), 30);
}

/** A word that names a built-in module and one of the tenant's Custom
 * Modules ("equipment": Assets, and a Custom Module of that name), or two
 * Custom Modules of one name: the same read on each, as choices ("Show
 * equipment (Custom Modules)", "How many assets (Field Service)?", "Assets by
 * status (Field Service)" for a breakdown), each running as the caller, with
 * no LLM call. Choices that read alike (two Custom Modules named Equipment)
 * are told apart by their order as given, the sidebar's ("How many equipment
 * (Custom Modules, 2nd)?"). `by`: a breakdown's field label, where the caller
 * has it. `question`: the question asked (Increment 8: PIPELINE_QUESTION for
 * bare "pipeline", a choice of the caller's pipelines). */
export function composeAmbiguousModule(
  choices: ReadonlyArray<{ plural: string; group: string; plan: QueryPlan; by?: string }>,
  question: string = TEXTS.ambiguousModule,
): ComposedAnswer {
  const labelOf = (i: number, n: number | null): string => {
    const { plural, group, plan, by } = choices[i];
    const name = cut(plural.replace(/\s+/g, ' ').trim(), 50);
    const where = `(${group}${n === null ? '' : `, ${nth(n)}`})`;
    const module = 'module' in plan.target ? plan.target.module : '';
    const text = plan.op === 'count' ? `How many ${name.toLowerCase()} ${where}?`
      : plan.op !== 'aggregate' ? `Show ${name.toLowerCase()} ${where}`
        : plan.group ? `${name} by ${breakdownWords(plan.group, module, by)} ${where}` : `${name} totals ${where}`;
    return cleaned(text, MAX_LABEL) || 'Show these';
  };
  const labels = toldApart(choices.map((_, i) => labelOf(i, null)), labelOf);
  return clarify('ambiguous_module', question, choices.map(({ plan }, i) => ({ label: labels[i], run: { plan } })));
}
