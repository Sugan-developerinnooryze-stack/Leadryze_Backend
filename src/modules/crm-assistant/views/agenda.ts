import type { QueryPlan } from '../contracts/plan';
import { AGENDA_CAPS, AgendaBlock, AgendaBucket, AgendaGroup, AgendaItem, NoticeBlock, SectionState, SourceRef } from '../contracts/views';
import { isKnownAppLink } from '../contracts/routes';
import { getModuleCap } from '../registry';
import { SOURCE_LABELS } from '../registry/labels';
import type { AgendaGroupOut, AgendaItemOut, AgendaOutcome, AgendaWindow } from '../query/agenda';
import { ComposedAnswer, clip, notice } from './compose';
import { dayText } from './chips';
import { hasData, scrubIds } from './fallback-text';
import { scopeNoteFor } from './interpret';

/* The agenda block (Increment 8): one AgendaBlock per answer, a group per
 * module of one source in its own state, plus the notices for how it was
 * read; and the one-notice answers for a late, failed or too long agenda.
 *
 * Every string an item carries is scrubbed of record ids and clipped to its
 * contract cap (an item's `key` keeps Daily Events' id: it is never text and
 * never printed). A module that wasn't read stays in the block in its own
 * state, with no buckets and never a 0. "Open Daily Events" is offered only
 * when Daily Events itself answered. */

const TEXTS = {
  dailyEventsOff: 'Daily Events is turned off for your organization, so this list was built from each module directly.',
  timezone: "Your company's timezone isn't set, so days are counted in UTC.",
  connectorsUnavailable: "Couldn't read your connected CRMs right now.",
  timedOut: 'Your agenda took too long to load. Try again in a moment.',
  failed: "Couldn't read your agenda right now. Try again in a moment.",
  tooLong: 'An agenda covers at most 3 months at a time. Ask for a shorter period.',
  lowerBound: 'Counted from the newest synced records only.',
};

/** Daily Events' own sections (executor D while its switch is on). */
const DAILY_EVENTS_KINDS: ReadonlySet<AgendaWindow['kind']> = new Set<AgendaWindow['kind']>(['daily_events', 'today', 'overdue', 'upcoming']);
const SYNC_STATUSES: ReadonlySet<string> = new Set(['idle', 'syncing', 'success', 'failed', 'unknown']);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Every word lower-cased except all-capital ones ("this week"). */
function titleLower(title: string): string {
  return title.split(' ').map((word) => (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word) ? word : word.toLowerCase())).join(' ');
}

/** Readable text, ids removed, clipped; '' when nothing is left. */
function shown(text: string | undefined, max: number): string {
  return text ? clip(scrubIds(text), max) : '';
}

function interpretAgenda(window: AgendaWindow, written: boolean): string {
  switch (window.kind) {
    case 'today':
      return `Today's Daily Events (${dayText(window.todayKey)}, ${window.timezone}): everything due or scheduled today in the modules you can see, in any status, and what is overdue.`;
    case 'overdue':
      return 'Everything past its date and still open, in the modules you can see.';
    case 'upcoming':
      return `Everything due or scheduled in the next 7 days (${window.label}) that is still open, in the modules you can see.`;
    case 'daily_events':
      return 'Daily Events: what is overdue, today and the next 7 days, in the modules you can see.';
    default:
      return written
        ? `Everything dated ${window.label} in the modules you can see: today's items in any status, other days only what is still open.`
        : `Everything dated ${titleLower(window.title)} (${window.label}) in the modules you can see: today's items in any status, other days only what is still open.`;
  }
}

function sourceRefOf(group: AgendaGroupOut): SourceRef {
  const connector = group.source.startsWith('connector:');
  const cap = connector ? undefined : getModuleCap(group.module);
  const note = cap ? scopeNoteFor(cap, group.scopeKind) : undefined;
  return {
    key: group.source,
    label: SOURCE_LABELS[group.source],
    module: clip(group.module, 120),
    moduleLabel: clip(group.moduleLabel, 120),
    scope: group.scopeKind === 'all' ? 'all' : 'visible_to_you',
    ...(note ? { scopeNote: clip(note, 200) } : {}),
    ...(group.freshness ? {
      freshness: {
        syncStatus: (SYNC_STATUSES.has(group.freshness.syncStatus) ? group.freshness.syncStatus : 'unknown') as NonNullable<SourceRef['freshness']>['syncStatus'],
        lastSyncAt: group.freshness.lastSyncAt ? clip(group.freshness.lastSyncAt, 40) : null,
        moduleSyncedAt: null,
      },
    } : {}),
  };
}

/** The group's state as the client shows it: never a number for a module that wasn't read. */
function stateOf(group: AgendaGroupOut, sourceLabel: string): SectionState {
  const label = group.moduleLabel;
  const message = (text: string) => clip(scrubIds(text), 500);
  switch (group.state) {
    case 'ok':
      return group.buckets.some((b) => b.lowerBound)
        ? { status: 'partial', partialReasons: ['scan_limit'], lowerBound: true, message: message(group.note ?? TEXTS.lowerBound) }
        : { status: 'ok' };
    case 'disabled': return { status: 'disabled', message: message(`${label} are turned off for your company.`) };
    case 'no_permission': return { status: 'no_permission', message: message(`You don't have access to ${label}.`) };
    case 'timeout':
      return { status: 'error', partialReasons: ['timeout'], retryable: true, message: message(`${label} took too long to read, so it isn't counted. Try again in a moment.`) };
    case 'not_synced': return { status: 'not_synced', message: message(`${sourceLabel} is connected but nothing has been synced yet.`) };
    case 'no_dates': return { status: 'unsupported', message: message(group.note ?? `${label} have no readable dates.`) };
    default:
      return { status: 'error', retryable: true, message: message(`Couldn't load ${label} right now, so it isn't counted. Try again in a moment.`) };
  }
}

/** An item within the contract's caps: every string scrubbed and clipped, an empty optional one left
 * out, a title that scrubs to nothing replaced by the module's name for one record. */
function itemOf(item: AgendaItemOut, singular: string): AgendaItem | null {
  if (!DAY_KEY.test(item.date)) return null;
  const subtitle = shown(item.subtitle, 160);
  const related = shown(item.related, 120);
  const assignee = shown(item.assignee, 120);
  const statusLabel = item.status ? shown(item.status.label, 120) || shown(item.status.key.replace(/_/g, ' '), 120) : '';
  return {
    key: clip(item.key, 200),
    title: shown(item.title, 200) || clip(singular, 200),
    kind: shown(item.kind, 60),
    date: item.date,
    ...(item.time && CLOCK.test(item.time) ? { time: item.time } : {}),
    ...(item.endTime && CLOCK.test(item.endTime) ? { endTime: item.endTime } : {}),
    allDay: item.allDay,
    ...(item.status && statusLabel ? { status: { t: 'status' as const, key: clip(item.status.key, 80), label: statusLabel, tone: item.status.tone } } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(related ? { related } : {}),
    ...(assignee ? { assignee } : {}),
    ...(item.leadFollowUp ? { leadFollowUp: true } : {}),
    ...(typeof item.daysLate === 'number' && Number.isInteger(item.daysLate) && item.daysLate >= 1 ? { daysLate: item.daysLate } : {}),
    ...(item.link && item.link.path.length <= 300 && isKnownAppLink(item.link.path) ? { href: { path: item.link.path, exact: item.link.exact } } : {}),
  };
}

function groupOf(group: AgendaGroupOut): AgendaGroup {
  const source = sourceRefOf(group);
  const state = stateOf(group, source.label);
  if (!hasData(state)) return { source, state, buckets: [] };
  const native = !group.source.startsWith('connector:');
  const singular = (native ? getModuleCap(group.module)?.labels.singular : undefined) ?? group.moduleLabel;
  const buckets: AgendaBucket[] = group.buckets.slice(0, 3).map((b) => {
    const label = shown(b.label, 120);
    return {
      bucket: b.bucket,
      ...(label ? { label } : {}),
      items: b.items.slice(0, AGENDA_CAPS.itemsPerBucket).map((item) => itemOf(item, singular)).filter((i): i is AgendaItem => i !== null),
      total: typeof b.total === 'number' && Number.isInteger(b.total) && b.total >= 0 ? b.total : null,
      lowerBound: b.lowerBound,
      ...(b.drill ? { drill: { plan: b.drill, section: group.source, executor: 'Q' as const } } : {}),
    };
  });
  return { source, state, buckets };
}

function itemsWord(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

/** The history line: how many items the read buckets hold, in how many modules; never a value. */
function summaryOf(outcome: AgendaOutcome, written: boolean, items: number, modules: number): string {
  const counted = `${itemsWord(items)} in ${modules} ${modules === 1 ? 'module' : 'modules'}`;
  const { window } = outcome;
  if (outcome.executor === 'D') {
    return window.kind === 'today' ? `Showed today's Daily Events: ${counted}.` : `Showed ${titleLower(window.title)} from Daily Events: ${counted}.`;
  }
  return `Showed the agenda for ${written ? window.label : titleLower(window.title)}: ${counted}.`;
}

/** One AgendaBlock 'b1' (only the plan's `sources` when it names some), then the notices for how it
 * was read: Daily Events switched off (Q answered one of its windows), the timezone fallback, and
 * connectors that couldn't be read (D). The plan is kept as the session's last plan. */
export function composeAgenda(outcome: AgendaOutcome, plan: QueryPlan, opts: { dailyEventsOn: boolean }): ComposedAnswer {
  const { window } = outcome;
  const sources = 'concept' in plan.target && plan.target.sources?.length ? new Set<string>(plan.target.sources) : null;
  const groups = outcome.groups.filter((g) => !sources || sources.has(g.source)).slice(0, AGENDA_CAPS.groups).map(groupOf);
  const written = typeof plan.window === 'object';
  const interpretedAs = clip(interpretAgenda(window, written), 300);
  const block: AgendaBlock = {
    id: 'b1',
    type: 'agenda',
    title: clip(window.title, 200),
    date: window.todayKey,
    window: { from: window.from, to: window.to, label: clip(window.label, 120) },
    timezone: clip(window.timezone, 64),
    interpretedAs,
    groups,
    openDailyEvents: outcome.executor === 'D',
  };
  const notices: NoticeBlock[] = [];
  const nextId = () => `b${notices.length + 2}`;
  if (outcome.executor === 'Q' && !opts.dailyEventsOn && DAILY_EVENTS_KINDS.has(window.kind)) {
    notices.push(notice(nextId(), 'agenda_daily_events_off', TEXTS.dailyEventsOff));
  }
  if (window.timezoneFallback) notices.push(notice(nextId(), 'agenda_timezone', TEXTS.timezone));
  // Said only where connected CRMs were asked for (every source, or one of them named).
  if (outcome.executor === 'D' && outcome.connectorsUnavailable && (!sources || [...sources].some((s) => s.startsWith('connector:')))) {
    notices.push(notice(nextId(), 'agenda_connectors_unavailable', TEXTS.connectorsUnavailable, 'warning'));
  }
  const read = groups.filter((g) => hasData(g.state));
  const items = read.reduce((n, g) => n + g.buckets.reduce((m, b) => m + (b.total ?? 0), 0), 0);
  return { blocks: [block, ...notices], summary: summaryOf(outcome, written, items, read.length), interpretedAs, plan, dataRead: true };
}

/** The agenda didn't finish before the resolve deadline: nothing is shown as a number. */
export function composeAgendaTimedOut(plan: QueryPlan): ComposedAnswer {
  return { blocks: [notice('b1', 'agenda_timeout', TEXTS.timedOut, 'warning')], summary: "Couldn't load the agenda in time.", dataRead: false };
}

export function composeAgendaFailed(plan: QueryPlan): ComposedAnswer {
  return { blocks: [notice('b1', 'agenda_failed', TEXTS.failed, 'danger')], summary: "Couldn't read the agenda.", dataRead: false };
}

export function composeAgendaTooLong(plan: QueryPlan): ComposedAnswer {
  return { blocks: [notice('b1', 'agenda_too_long', TEXTS.tooLong)], summary: 'Asked for a shorter agenda period.', dataRead: false };
}
