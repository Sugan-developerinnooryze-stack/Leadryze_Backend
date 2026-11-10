import type { CapabilityView } from '../capability-view';
import type { AppLink, QueryHandle, SectionState, SourceRef } from '../contracts/views';
import type { Cond, QueryPlan } from '../contracts/plan';
import type { ModuleCap } from '../registry/types';
import { getModuleCap } from '../registry';
import { CONCEPTS, ConceptKey, ConceptSource } from '../registry/concepts';
import {
  CONNECTOR_CONCEPT_MODULES, CONNECTOR_TYPES, CONNECTOR_TYPE_LABELS, ConnectorSyncState, ConnectorType, activeConnectorSync,
} from '../registry/connectors';
import { listLinkFor } from '../contracts/routes';
import { GateIdentity, GatewayTenant, TENANT_INACTIVE_MESSAGE, gateModuleRead } from '../gates';
import { sourceRefFor } from '../views/compose';
import type { ScopeKind } from '../views/interpret';
import { executeCount, moduleDefFor } from './execute-list';
import { PlanRejectedError, executeQueryCount } from './execute-query';
import { connectorCountTimedOut, countConnectorModuleWith } from './connector-counts';
import { MineMode, MineUnavailableError, mineLabel, minePartial } from './mine';
import { logger } from '../../../utils/logger';

/* Per-source counts of a concept ("how many customers do we have"): one
 * section per source, each under its own gates and with its own state, and
 * never a total — numbers from different sources are never added together
 * (decision D1).
 *
 * Native sources run gateModuleRead for their module every time (the
 * capability view is only a cache), then their executor with the scope and
 * branch the gates returned: a plain count runs on executor L (the module's
 * own list(), as /crm-count does: Field Service customers), a count with the
 * concept's conditions on executor Q (contacts whose status is "customer").
 * Each section carries a drill handle on the same executor with the same
 * conditions, so its list total equals the count. Connector sources run the
 * connector count's gates and states (connector-counts.ts) and appear only
 * for vendors with an active connector. A source that fails is an error
 * section, never 0 and never a reason to drop the others. With a deadline,
 * each source races it on its own: one still counting then is an error
 * section that can be retried, and the others keep their numbers. When the
 * active connectors can't be read (the lookup failed or hadn't finished),
 * no connector tile is invented; the caller's report says so instead.
 *
 * "How many customers do I have" (mine): each native source counts only the
 * caller's own records on executor Q (query/mine.ts says what that means for
 * its module), its drill lists the same, and its label says whose ("Field
 * Service customers assigned to you"); a source where that can't be told is
 * an 'unsupported' section saying why. Connector records have no owner a
 * LeadRyze user maps to (plan 3.3), so each connected vendor's section says
 * so and nothing of theirs is counted. */

export interface SourceCountSection {
  source: SourceRef;
  state: SectionState;
  /** null = unavailable, never shown as 0. */
  value: number | null;
  label: string;
  /** The list behind the number (same executor, same conditions). Native sources only. */
  drill?: QueryHandle;
  href?: AppLink;
}

interface CountConceptInput {
  concept: ConceptKey;
  tenantId: string;
  tenant: GatewayTenant;
  identity: GateIdentity;
  view: CapabilityView;
  now?: Date;
  /** "how many customers do I have": each native source counts only the caller's own (query/mine.ts). */
  mine?: MineMode;
}

type ModuleSource = Extract<ConceptSource, { kind: 'module' }>;
type ConnectorSource = Extract<ConceptSource, { kind: 'connector' }>;

const LABEL_MAX = 120;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "Contacts marked as customers" -> "contacts marked as customers"; source names keep their capitals. */
function inSentence(label: string): string {
  return /^(Field Service|Native CRM)\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** A fresh copy: the registry's conditions are frozen and shared. */
function copyWhere(where: readonly Cond[]): Cond[] {
  return JSON.parse(JSON.stringify(where)) as Cond[];
}

function validNow(now: Date | undefined): Date | undefined {
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : undefined;
}

function failedState(cap: ModuleCap): SectionState {
  return { status: 'error', message: `Couldn't read ${cap.labels.plural} right now.`, retryable: true };
}

/** "Field Service customers", "Contacts marked as customers you can see", or
 * with "mine" whose they are instead ("… assigned to you", "… owned by you":
 * mineLabel); the scope still applies, as the source's badge says. When the
 * scope can leave some of the caller's own records out (minePartial), the
 * label says "that you can see", as a list's interpretation does. */
function sourceLabel(source: ModuleSource, cap: ModuleCap, scopeKind: ScopeKind, mine: MineMode | undefined): string {
  if (mine) {
    const partial = minePartial(cap, mine, scopeKind) ? ' that you can see' : '';
    return clip(`${source.label} ${mineLabel(cap, mine).toLowerCase()}${partial}`, LABEL_MAX);
  }
  return clip(`${source.label}${scopeKind === 'all' ? '' : ' you can see'}`, LABEL_MAX);
}

/** The gates refused: the module is off, the caller lacks its view permission, or the tenant is deactivated. */
function refusedSection(
  cap: ModuleCap, source: ModuleSource, reason: 'tenant_inactive' | 'disabled' | 'no_permission', mine: MineMode | undefined,
): SourceCountSection {
  const state: SectionState = reason === 'no_permission'
    ? { status: 'no_permission', message: `You don't have access to ${cap.labels.plural}.` }
    : reason === 'disabled'
      ? { status: 'disabled', message: `${cap.labels.plural} are turned off for your company.` }
      : { status: 'disabled', message: TENANT_INACTIVE_MESSAGE };
  return { source: sourceRefFor(cap, 'all'), state, value: null, label: sourceLabel(source, cap, 'all', mine) };
}

async function countModuleSource(source: ModuleSource, input: CountConceptInput): Promise<SourceCountSection | null> {
  const { tenantId, tenant, identity, view, mine } = input;
  const cap = getModuleCap(source.module);
  // A module the registry or the capability view doesn't serve (left out at boot, fail closed) isn't a source.
  if (!cap || view.accessOf(source.module) === 'unknown') {
    logger.warn('CRM assist: a concept source module is not served', { concept: input.concept, module: source.module });
    return null;
  }

  let gate: Awaited<ReturnType<typeof gateModuleRead>>;
  try {
    gate = await gateModuleRead(tenantId, tenant, identity, {
      flagKey: cap.gate.flagKey, label: moduleDefFor(cap).label, viewPermission: `${cap.gate.permPrefix}.view`, scopeKey: cap.gate.scopeKey,
    });
  } catch (err) {
    logger.warn('CRM assist: concept source gates failed', { concept: input.concept, module: cap.key, error: (err as Error)?.message });
    return { source: sourceRefFor(cap, 'all'), state: failedState(cap), value: null, label: sourceLabel(source, cap, 'all', mine) };
  }
  if (!gate.ok) return refusedSection(cap, source, gate.reason, mine);

  const where = source.where && source.where.length ? copyWhere(source.where) : undefined;
  // A plain count is /crm-count's (executor L); the concept's conditions, and "mine", need executor Q.
  const executor: 'L' | 'Q' = where || mine ? 'Q' : 'L';
  const scopeKind = gate.scope.kind;
  const label = sourceLabel(source, cap, scopeKind, mine);
  const drill: QueryHandle = {
    plan: { v: 1, op: 'list', target: { module: cap.key }, ...(where ? { where: copyWhere(where) } : {}), ...(mine ? { mine } : {}) },
    section: cap.group,
    executor,
  };
  const href = view.has(cap.key) ? listLinkFor(cap.key) : undefined;
  const shown = { source: sourceRefFor(cap, scopeKind), label, drill, ...(href ? { href } : {}) };

  const plan: QueryPlan = { v: 1, op: 'count', target: { module: cap.key }, ...(where ? { where } : {}), ...(mine ? { mine } : {}) };
  const now = validNow(input.now);
  const ctx = {
    tenantId,
    identity: { userId: identity.userId ?? '', role: identity.role ?? 'AGENT', ...(identity.roleId ? { roleId: identity.roleId } : {}) },
    branchId: gate.branchId,
    scope: gate.scope,
    timezone: tenant.timezone,
    ...(now ? { now } : {}),
  };
  try {
    const { total } = executor === 'Q' ? await executeQueryCount(cap, plan, ctx) : await executeCount(cap, plan, ctx);
    if (typeof total !== 'number' || !Number.isFinite(total)) return { ...shown, state: failedState(cap), value: null };
    const state: SectionState = total === 0 ? { status: 'empty', message: `There are no ${inSentence(label)} yet.` } : { status: 'ok' };
    return { ...shown, state, value: total };
  } catch (err) {
    if (err instanceof MineUnavailableError) {
      // "Mine" can't be told for this source and caller (query/mine.ts): it says why, never a number.
      return { source: shown.source, label, state: { status: 'unsupported', message: clip(err.text, 500) }, value: null };
    }
    if (err instanceof PlanRejectedError) {
      logger.warn('CRM assist: a concept source plan was rejected', {
        concept: input.concept, module: cap.key, problems: (err.problems ?? []).map((p) => p.code),
      });
      return { source: shown.source, label, state: { status: 'unsupported', message: `${source.label} can't be counted here yet.` }, value: null };
    }
    logger.warn('CRM assist: a concept source count failed', { concept: input.concept, module: cap.key, error: (err as Error)?.message });
    return { ...shown, state: failedState(cap), value: null };
  }
}

/** A connected vendor's section for "mine": nothing is counted, since nothing
 * maps a LeadRyze user to a vendor's record owner (plan 3.3). Its source is
 * the one a count shows before the module resolves (the vendor's usual name
 * for the module, with the connector's freshness). */
function connectorMineSection(source: ConnectorSource, sync: ConnectorSyncState): SourceCountSection {
  const vendor = CONNECTOR_TYPE_LABELS[source.type];
  const module = CONNECTOR_CONCEPT_MODULES[source.type][source.concept].label;
  return {
    source: {
      key: `connector:${source.type}` as const,
      label: vendor,
      module,
      moduleLabel: module,
      // Connector records have no data scope (connector-counts.ts).
      scope: 'all',
      freshness: { syncStatus: sync.syncStatus, lastSyncAt: sync.lastSyncAt ? sync.lastSyncAt.toISOString() : null, moduleSyncedAt: null },
    },
    state: { status: 'unsupported', message: `${vendor} records can't be filtered to yours.` },
    value: null,
    label: `${vendor} ${module}`,
  };
}

async function countConnectorSource(
  source: ConnectorSource, input: CountConceptInput, active: Promise<Map<ConnectorType, ConnectorSyncState> | null>,
): Promise<SourceCountSection | null> {
  const sync = await active;
  // Only vendors with an active connector are counted (a failed lookup knows of none).
  if (!sync || !sync.has(source.type)) return null;
  // "Mine": no connector count is run.
  if (input.mine) return connectorMineSection(source, sync.get(source.type)!);
  const now = validNow(input.now);
  const counted = await countConnectorModuleWith({
    tenantId: input.tenantId, tenant: input.tenant, identity: input.identity,
    type: source.type, request: { concept: source.concept }, ...(now ? { now } : {}),
  }, sync.get(source.type));
  return { source: counted.source, state: counted.state, value: counted.value, label: counted.label };
}

/** A native source still counting when the deadline passed: an error that
 * can be retried, never a number. Its gates may not have finished either,
 * so it names no scope and carries no drill or link. */
function timedOutModuleSection(source: ModuleSource, mine: MineMode | undefined): SourceCountSection | null {
  const cap = getModuleCap(source.module);
  if (!cap) return null;
  const label = sourceLabel(source, cap, 'all', mine);
  return {
    source: sourceRefFor(cap, 'all'),
    state: { status: 'error', message: `Counting ${inSentence(label)} took too long. Try again in a moment.`, retryable: true },
    value: null,
    label,
  };
}

/** What a source's count settles to when the deadline passes first. */
const LATE = Symbol('late');

/** One section per source, never summed. Native sources run their own gates (gateModuleRead) and executor
 * (FS customers: executor L count; contacts marked customer: executor Q count with the concept's where);
 * connector sources run countConnectorModule and are included only for types with an active connector.
 * `deadline` (epoch ms): each source races it on its own; one still counting then is an error section
 * ("Counting <label> took too long. Try again in a moment.", retryable), the finished ones keep their values.
 * When the active-connector lookup fails (or hasn't finished by the deadline) no connector tile is
 * invented and `report.connectorsUnchecked` is set to true. `mine`: every native source counts the
 * caller's own on executor Q (an 'unsupported' section when that can't be told), and each connected
 * vendor's section is 'unsupported' with no count run. */
export async function countConcept(input: { concept: ConceptKey; tenantId: string; tenant: GatewayTenant;
  identity: GateIdentity; view: CapabilityView; now?: Date; deadline?: number; report?: { connectorsUnchecked?: boolean };
  mine?: MineMode }): Promise<SourceCountSection[]> {
  const concept = Object.prototype.hasOwnProperty.call(CONCEPTS, input.concept) ? CONCEPTS[input.concept] : undefined;
  if (!concept) throw new Error(`Unknown concept "${String(input.concept)}"`);
  const types = CONNECTOR_TYPES.filter((type) => concept.sources.some((s) => s.kind === 'connector' && s.type === type));
  // One read of the active connectors for every vendor, alongside the native counts.
  // lookup.sync: undefined until it settles, null when it failed.
  const lookup: { sync: Map<ConnectorType, ConnectorSyncState> | null | undefined } = { sync: undefined };
  const active: Promise<Map<ConnectorType, ConnectorSyncState> | null> = (types.length
    ? activeConnectorSync(input.tenantId, types).catch((err) => {
      logger.warn('CRM assist: connector lookup failed; connector sources left out', { concept: input.concept, error: (err as Error)?.message });
      return null;
    })
    : Promise.resolve(new Map<ConnectorType, ConnectorSyncState>())
  ).then((sync) => { lookup.sync = sync; return sync; });

  // Each source races the deadline on its own (one timer for all of them).
  const deadline = typeof input.deadline === 'number' && Number.isFinite(input.deadline) ? input.deadline : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = deadline === undefined ? null : new Promise<typeof LATE>((resolve) => {
    // Within setTimeout's limit, past which Node fires at once.
    timer = setTimeout(() => resolve(LATE), Math.min(Math.max(0, deadline - Date.now()), 0x7fffffff));
  });
  let settled: Array<SourceCountSection | null | typeof LATE>;
  try {
    settled = await Promise.all(concept.sources.map((source) => {
      const counting = source.kind === 'module' ? countModuleSource(source, input) : countConnectorSource(source, input, active);
      return late ? Promise.race([counting, late]) : counting;
    }));
  } finally {
    clearTimeout(timer);
  }

  const lateSources: string[] = [];
  const sections = settled.map((result, i) => {
    if (result !== LATE) return result;
    const source = concept.sources[i];
    lateSources.push(source.kind === 'module' ? source.module : `connector:${source.type}`);
    if (source.kind === 'module') return timedOutModuleSection(source, input.mine);
    // A vendor is shown only once the lookup has found its active connector.
    const sync = lookup.sync?.get(source.type);
    if (!sync) return null;
    if (input.mine) return connectorMineSection(source, sync);
    const counted = connectorCountTimedOut(source.type, { concept: source.concept }, sync);
    return { source: counted.source, state: counted.state, value: counted.value, label: counted.label };
  });
  if (lateSources.length) logger.warn('CRM assist: concept sources did not finish by the deadline', { concept: input.concept, sources: lateSources });
  // The connectors weren't checked (the lookup failed or is still running): the answer has to say so.
  if (types.length && !lookup.sync && input.report) input.report.connectorsUnchecked = true;
  return sections.filter((s): s is SourceCountSection => s !== null);
}
