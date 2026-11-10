import type { SectionState, SourceRef } from '../contracts/views';
import {
  CONNECTOR_CONCEPT_MODULES, CONNECTOR_TYPES, CONNECTOR_TYPE_LABELS, CONNECTOR_VENDOR_ROW_CAPS, ConnectorConcept,
  ConnectorModuleResolution, ConnectorSyncState, ConnectorType, activeConnectorSync, connectorModuleHasRows,
  connectorModuleViewKey, countConnectorRecords, isConnectorType, normaliseModuleName, resolveConnectorModuleAt,
} from '../registry/connectors';
import { GateIdentity, GatewayTenant, TENANT_INACTIVE_MESSAGE, identityHasPermission, isTenantBlocked } from '../gates';
import { isModuleFlagDisabled } from '../../internal/crm-gateway.helpers';
import { logger } from '../../../utils/logger';

/* Connector counts (Increment 3, plan 4.8): how many synced records one
 * connector module holds, as one section with its own state and freshness.
 * The gates run in this order (the Daily Events reader's, plus the states it
 * lacks):
 *   1. the connector_<type> flag (SUPER_ADMIN bypasses)        -> disabled
 *   2. an active connector of the type                          -> not_connected
 *   3. the module resolves (registry/connectors.ts): when not,
 *      never_synced if no active connector has a lastSyncAt, else not_synced
 *      (which says so when several stored modules match equally well);
 *      the stored module names come back only for a caller with
 *      connector.view (or an admin), as the Connectors screen shows them
 *   4. connector.<type>.<module lower-cased>.view, wildcards honoured by the
 *      permission service (a Manager holds none until granted) -> no_permission
 *   5. one count aggregation; a failure                         -> error (null, retryable)
 *   6. ok, or empty for 0; partial "N+" at the vendor's sync cap.
 * A number is never summed across vendors or with native data. Freshness is
 * the worst sync state and the latest lastSyncAt of the type's active
 * connectors, plus the module's latest syncedAt. All Connector and CRMRecord
 * reads are the registry's: this file imports no model. */

export interface ConnectorCountSection {
  type: ConnectorType;
  /** key 'connector:<type>'; module = the stored module name, or the vendor's usual name when none resolved; freshness once the connector is known. */
  source: SourceRef;
  state: SectionState;
  /** null = unavailable, never shown as 0. */
  value: number | null;
  /** "Salesforce Opportunities". */
  label: string;
  /** Unresolved only, and only for a caller with connector.view (or an admin): the stored names to ask for instead. */
  storedModules?: string[];
}

export interface ConnectorCountInput {
  tenantId: string;
  tenant: GatewayTenant;
  identity: GateIdentity;
  type: ConnectorType;
  request: { concept: ConnectorConcept } | { storedModule: string };
  now?: Date;
}

/** Stored names listed back at most. */
export const MAX_LISTED_STORED_MODULES = 50;
const MODULE_TEXT_MAX = 120;
/** The grammar's limit for a named stored module. */
const ASKED_MODULE_MAX = 60;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function capitalised(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** The name shown before anything resolved: the vendor's usual name, or the name asked for. */
function requestedName(type: ConnectorType, request: ConnectorCountInput['request']): string {
  if ('concept' in request) return CONNECTOR_CONCEPT_MODULES[type][request.concept].label;
  const asked = normaliseModuleName(typeof request.storedModule === 'string' ? request.storedModule : '').slice(0, ASKED_MODULE_MAX);
  return asked ? capitalised(asked) : 'That module';
}

function sourceOf(type: ConnectorType, moduleName: string, freshness?: SourceRef['freshness']): SourceRef {
  const name = clip(moduleName, MODULE_TEXT_MAX);
  return {
    key: `connector:${type}` as const,
    label: CONNECTOR_TYPE_LABELS[type],
    module: name,
    moduleLabel: name,
    // Connector records have no data scope: whoever holds the module's view key sees every synced row.
    scope: 'all',
    ...(freshness ? { freshness } : {}),
  };
}

function section(
  type: ConnectorType, moduleName: string, state: SectionState, value: number | null,
  extra: { freshness?: SourceRef['freshness']; storedModules?: string[] } = {},
): ConnectorCountSection {
  return {
    type,
    source: sourceOf(type, moduleName, extra.freshness),
    state: state.message ? { ...state, message: clip(state.message, 500) } : state,
    value,
    label: clip(`${CONNECTOR_TYPE_LABELS[type]} ${moduleName}`, MODULE_TEXT_MAX),
    ...(extra.storedModules && extra.storedModules.length ? { storedModules: extra.storedModules } : {}),
  };
}

function failedState(type: ConnectorType, moduleName: string): SectionState {
  return { status: 'error', message: `Couldn't read ${CONNECTOR_TYPE_LABELS[type]} ${moduleName} right now.`, retryable: true };
}

/** Gates 1 (and a deactivated tenant, which the routes refuse before this). */
function refusal(input: ConnectorCountInput): ConnectorCountSection | null {
  const { tenant, identity, type, request } = input;
  if (isTenantBlocked(tenant, identity)) {
    return section(type, requestedName(type, request), { status: 'disabled', message: TENANT_INACTIVE_MESSAGE }, null);
  }
  if (isModuleFlagDisabled(tenant.flags, `connector_${type}`, identity.role)) {
    return section(type, requestedName(type, request), { status: 'disabled', message: `${CONNECTOR_TYPE_LABELS[type]} is turned off for your company.` }, null);
  }
  return null;
}

/** Gate 3 when nothing resolved: never synced, no such module, or several
 * stored modules that match equally well (none of them is counted). */
function unresolvedState(
  type: ConnectorType, asked: string, request: ConnectorCountInput['request'], ambiguous: boolean, sync: ConnectorSyncState,
): SectionState {
  const typeLabel = CONNECTOR_TYPE_LABELS[type];
  if (sync.lastSyncAt === null) return { status: 'never_synced', message: `${typeLabel} is connected but hasn't synced yet.` };
  const concept = 'concept' in request;
  if (ambiguous) {
    return {
      status: 'not_synced',
      message: concept
        ? `${typeLabel} has more than one synced module that looks like ${asked}, so none was counted.`
        : `${typeLabel} has more than one synced module called "${asked}", so none was counted.`,
    };
  }
  return concept
    ? { status: 'not_synced', message: `${typeLabel} is connected but no ${asked} have been synced.` }
    : { status: 'not_synced', message: `${typeLabel} has no synced module called "${asked}".` };
}

function okState(type: ConnectorType, moduleName: string, count: number, sync: ConnectorSyncState): SectionState {
  const typeLabel = CONNECTOR_TYPE_LABELS[type];
  const cap = CONNECTOR_VENDOR_ROW_CAPS[type];
  if (cap !== undefined && count >= cap) {
    return {
      status: 'partial', lowerBound: true, partialReasons: ['vendor_row_cap'],
      message: `${typeLabel} syncs at most ${cap.toLocaleString('en-US')} records per module, so there may be more.`,
    };
  }
  // Sync health is reported next to the result, never instead of it (plan 2.5).
  const health = sync.syncStatus === 'failed' ? ' As of the last successful sync; the latest sync failed.'
    : sync.syncStatus === 'syncing' ? ' A sync is running, so this number may change.' : '';
  if (count === 0) return { status: 'empty', message: `There are no synced ${typeLabel} ${moduleName}.${health}` };
  return health ? { status: 'ok', message: health.trim() } : { status: 'ok' };
}

/** Gates 2 to 6 for a caller that already read the type's active connectors
 * (`sync`; undefined = none). countConcept reads them once for every vendor.
 * Never rejects for a failed read: that is the 'error' state. */
export async function countConnectorModuleWith(
  input: ConnectorCountInput, sync: ConnectorSyncState | undefined,
): Promise<ConnectorCountSection> {
  const { tenantId, identity, type, request } = input;
  if (!isConnectorType(type)) throw new Error(`Unknown connector type "${String(type)}"`);
  const refused = refusal(input);
  if (refused) return refused;
  const typeLabel = CONNECTOR_TYPE_LABELS[type];
  const asked = requestedName(type, request);
  if (!sync) return section(type, asked, { status: 'not_connected', message: `${typeLabel} isn't connected for your company.` }, null);

  const freshness = { syncStatus: sync.syncStatus, lastSyncAt: iso(sync.lastSyncAt), moduleSyncedAt: null };
  const now = input.now instanceof Date && !Number.isNaN(input.now.getTime()) ? input.now.getTime() : Date.now();
  let resolution: ConnectorModuleResolution;
  try {
    resolution = await resolveConnectorModuleAt(tenantId, type, request, now);
  } catch (err) {
    logger.warn('CRM assist: connector module resolution failed', { tenantId, type, error: (err as Error)?.message });
    return section(type, asked, failedState(type, asked), null, { freshness });
  }

  if (resolution.status === 'unresolved') {
    const state = unresolvedState(type, asked, request, resolution.ambiguous === true, sync);
    const mayList = resolution.storedModules.length > 0 && await identityHasPermission(tenantId, identity, 'connector.view');
    const listed = mayList ? resolution.storedModules.slice(0, MAX_LISTED_STORED_MODULES).map((m) => clip(m, MODULE_TEXT_MAX)) : [];
    return section(type, asked, state, null, { freshness, storedModules: listed });
  }

  const module = resolution.module;
  if (!(await identityHasPermission(tenantId, identity, connectorModuleViewKey(type, module)))) {
    return section(type, module, { status: 'no_permission', message: `You don't have access to ${typeLabel} ${module}.` }, null);
  }
  try {
    const counted = await countConnectorRecords(tenantId, type, module);
    return section(type, module, okState(type, module, counted.count, sync), counted.count, {
      freshness: { ...freshness, moduleSyncedAt: iso(counted.moduleSyncedAt) },
    });
  } catch (err) {
    logger.warn('CRM assist: connector count failed', { tenantId, type, module, error: (err as Error)?.message });
    return section(type, module, failedState(type, module), null, { freshness });
  }
}

/** One connector module's count, under every gate, as one section. Never
 * rejects for a failed read: that is the 'error' state, never 0. */
export async function countConnectorModule(input: { tenantId: string; tenant: GatewayTenant; identity: GateIdentity;
  type: ConnectorType; request: { concept: ConnectorConcept } | { storedModule: string }; now?: Date }): Promise<ConnectorCountSection> {
  if (!isConnectorType(input.type)) throw new Error(`Unknown connector type "${String(input.type)}"`);
  // The flag is checked before anything is read.
  const refused = refusal(input);
  if (refused) return refused;
  let sync: ConnectorSyncState | undefined;
  try {
    sync = (await activeConnectorSync(input.tenantId, [input.type])).get(input.type);
  } catch (err) {
    logger.warn('CRM assist: connector lookup failed', { tenantId: input.tenantId, type: input.type, error: (err as Error)?.message });
    const asked = requestedName(input.type, input.request);
    return section(input.type, asked, failedState(input.type, asked), null);
  }
  return countConnectorModuleWith(input, sync);
}

/** A connector count its caller stopped waiting for (countConcept's
 * deadline passed): the module asked for, with the type's sync state when
 * the lookup had found it, in an error state that can be retried — never a
 * number. */
export function connectorCountTimedOut(
  type: ConnectorType, request: ConnectorCountInput['request'], sync?: ConnectorSyncState,
): ConnectorCountSection {
  const asked = requestedName(type, request);
  const state: SectionState = {
    status: 'error', message: `Counting ${CONNECTOR_TYPE_LABELS[type]} ${asked} took too long. Try again in a moment.`, retryable: true,
  };
  return section(type, asked, state, null, sync
    ? { freshness: { syncStatus: sync.syncStatus, lastSyncAt: iso(sync.lastSyncAt), moduleSyncedAt: null } }
    : {});
}

/** For the chat's count chip: connector types whose deal module resolves, has rows, and the caller may view (flag on).
 * A type whose check fails is left out; rejects only when the connector lookup itself fails (the caller answers []). */
export async function countableConnectorsFor(input: { tenantId: string; tenant: GatewayTenant; identity: GateIdentity }):
  Promise<Array<{ type: ConnectorType; label: string }>> {
  const { tenantId, tenant, identity } = input;
  if (isTenantBlocked(tenant, identity)) return [];
  const types = CONNECTOR_TYPES.filter((type) => !isModuleFlagDisabled(tenant.flags, `connector_${type}`, identity.role));
  if (!types.length) return [];
  const active = await activeConnectorSync(tenantId, types);
  const now = Date.now();
  const countable = await Promise.all(types.map(async (type) => {
    if (!active.has(type)) return false;
    try {
      const resolution = await resolveConnectorModuleAt(tenantId, type, { concept: 'deal' }, now);
      if (resolution.status !== 'resolved') return false;
      if (!(await identityHasPermission(tenantId, identity, connectorModuleViewKey(type, resolution.module)))) return false;
      return await connectorModuleHasRows(tenantId, type, resolution.module);
    } catch (err) {
      logger.warn('CRM assist: countable connector check failed', { tenantId, type, error: (err as Error)?.message });
      return false;
    }
  }));
  return types.filter((_, i) => countable[i]).map((type) => ({ type, label: CONNECTOR_TYPE_LABELS[type] }));
}
