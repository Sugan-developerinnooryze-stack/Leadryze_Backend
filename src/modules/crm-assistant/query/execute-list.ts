import type { ModuleCap } from '../registry/types';
import type { QueryPlan } from '../contracts/plan';
import { CRM_WRITE_MODULE_MAP, CrmWriteModuleDef } from '../../internal/crm-write.module-map';
import {
  applyPIIProtection, countCrmModule, isForbiddenReadKey, projectForDetail, projectForRead, readFieldKeysFor,
} from '../../internal/crm-read.service';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../internal/crm-gateway.helpers';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { getSettings } from '../../native-crm/fs-settings/fs-settings.service';
import { ADMIN_ROLES, PII_FIELDS } from '../../../platform/pii/constants';
import { DataScope } from '../../../types';
import { logger } from '../../../utils/logger';
import type { CompanyCurrencies } from './scoped-match';
import { companyCurrenciesFor, recordIdsByNumber, schemaEnumValues } from './scoped-match';

/* Executor L: reads through the module's own list() and getById() — the
 * closures GET /crm-list, /crm-count and /crm-get call (internal.routes.ts),
 * with the same arguments and the same post-processing (applyPIIProtection,
 * then the read projection, then READ_FORBIDDEN_KEYS), so the engine can
 * never show more than those routes do. Stage labels and colours come from
 * peekStages, which never writes; getOrCreateStages, isValidStageKey and
 * getOutcomeStageKey (which create PipelineConfig documents) are never
 * called here. */

export interface ExecContext {
  tenantId: string;
  identity: { userId: string; role: string; roleId?: string };
  /** From the gates: the caller's branch (null = all branches) and effective scope. */
  branchId: string | null;
  scope: DataScope;
  /** Tenant timezone (gates.ts GatewayTenant.timezone); executor Q resolves day windows in it. */
  timezone: string;
  /** Clock for date windows (tests pass a fixed one). Default new Date(). */
  now?: Date;
}

export type Tone = 'open' | 'done' | 'cancelled' | 'alert' | 'unknown';
export interface StatusOption { label: string; color?: string; tone: Tone }
export interface StatusInfo { field: string; options: ReadonlyMap<string, StatusOption> }

/** What the composer needs besides the rows. */
export interface ReadContext {
  /** False when the caller's role sees this module's PII masked. */
  piiVisible: boolean;
  /** The Field Service currency for the caller's branch, for 'fs_branch' money fields. */
  currency: string | null;
  /** Each listed record's own Field Service currency (its company's), by the
   * record's _id: only when no branch is picked and the tenant's companies use
   * more than one currency (withRecordCurrencies). An amount of a record listed
   * here is shown in it rather than in `currency`, as the named totals count it. */
  recordCurrency?: ReadonlyMap<string, string>;
  status: StatusInfo | null;
  /** Top-level keys the gateway's read projection allows for this module. */
  allowedKeys: ReadonlySet<string>;
}

export interface ListOutcome { items: Record<string, unknown>[]; total: number; page: number; size: number; read: ReadContext }
export type DetailOutcome =
  | { kind: 'record'; record: Record<string, unknown>; read: ReadContext }
  | { kind: 'duplicates'; matches: Record<string, unknown>[]; read: ReadContext }
  | { kind: 'not_found' };

/** At most this many records sharing one number are listed. */
export const MAX_NUMBER_MATCHES = 10;

const CANCELLED_RE = /cancel|lost|reject|disqualif|inactive|retired/i;

export function moduleDefFor(cap: ModuleCap): CrmWriteModuleDef {
  const def = CRM_WRITE_MODULE_MAP[cap.key];
  if (!def) throw new Error(`No gateway module for "${cap.key}"`);
  return def;
}

function stripForbidden(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) if (key === '_id' || !isForbiddenReadKey(key)) out[key] = value;
  return out;
}

/** /crm-list's post-processing of list rows, shared by executors L and Q:
 * applyPIIProtection, then the module's read projection, then
 * READ_FORBIDDEN_KEYS. */
export async function protectAndProject(def: CrmWriteModuleDef, items: unknown[], ctx: ExecContext): Promise<Record<string, unknown>[]> {
  const piiSafe = await applyPIIProtection(items, def.logModule, ctx.tenantId, ctx.branchId, ctx.identity.role ?? 'AGENT');
  return projectForRead(piiSafe, def).map(stripForbidden);
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** Status labels, colours and tones for the module's stage field: the
 * tenant's pipeline stages (peekStages: saved stages, or the defaults,
 * without creating anything) or the schema enum. */
export async function loadStatusInfo(cap: ModuleCap, tenantId: string): Promise<StatusInfo | null> {
  const stage = cap.stage;
  if (!stage) return null;
  const options = new Map<string, StatusOption>();
  if ('pipeline' in stage) {
    const stages = await peekStages(tenantId, stage.pipeline);
    for (const s of stages) {
      const cancelled = s.isTerminal && (s.outcome === 'cancelled' || s.outcome === 'lost' || /cancel|lost|reject|disqualif/i.test(s.key));
      options.set(s.key, {
        label: s.label || humanize(s.key),
        ...(s.color ? { color: s.color } : {}),
        tone: !s.isTerminal ? 'open' : cancelled ? 'cancelled' : 'done',
      });
    }
    return { field: stage.field, options };
  }
  const field = cap.fields.find((f) => f.path === stage.field || f.key === stage.field);
  let values: string[] = field?.schema?.enumValues ?? [];
  if (!values.length) values = schemaEnumValues(cap, stage.field);
  const terminal = new Set(stage.terminal);
  for (const v of values) {
    const tone: Tone = CANCELLED_RE.test(v) ? 'cancelled' : terminal.has(v) ? 'done' : 'open';
    options.set(v, { label: humanize(v), tone });
  }
  return { field: stage.field, options };
}

/** `status`: the module's StatusInfo when the caller already loaded it
 * (loadStatusInfo); otherwise it is loaded here. */
export async function loadReadContext(
  cap: ModuleCap, def: CrmWriteModuleDef, ctx: ExecContext, status?: StatusInfo | null,
): Promise<ReadContext> {
  const hasPii = !!PII_FIELDS[def.logModule];
  const isAdmin = ADMIN_ROLES.includes(ctx.identity.role);
  const needsCurrency = cap.fields.some((f) => f.money?.currency === 'fs_branch');
  // The same settings document applyPIIProtection reads (fs-settings piiConfig).
  const settings: any = (hasPii && !isAdmin) || needsCurrency
    ? await getSettings(ctx.tenantId, ctx.branchId ?? null).catch(() => null)
    : null;
  const viewRoles: string[] = settings?.piiConfig?.find((p: any) => p.module === def.logModule)?.viewRoles ?? [];
  return {
    piiVisible: !hasPii || isAdmin || viewRoles.includes(ctx.identity.role),
    currency: needsCurrency && typeof settings?.currency === 'string' ? settings.currency : null,
    status: status !== undefined ? status : await loadStatusInfo(cap, ctx.tenantId),
    allowedKeys: new Set(readFieldKeysFor(cap.key)),
  };
}

/** How long a list waits, at most, for the tenant's company currencies
 * (recordCurrenciesRead); the same short budget as executor Q's
 * FS_RANKABLE_BUDGET_MS. */
const RECORD_CURRENCY_BUDGET_MS = 400;

/** True when a table of `cap` shows a Field Service amount ('fs_branch' money column). */
function showsBranchAmounts(cap: ModuleCap): boolean {
  return cap.fields.some((f) => f.kind === 'money' && f.money?.currency === 'fs_branch' && f.read === 'list' && f.priority !== undefined);
}

/** The tenant's company currencies, when a list of `cap` labels its amounts
 * record by record: its tables show a Field Service amount and no branch is
 * picked (a picked branch reads only its own records). The one read
 * scoped-match.ts companyCurrenciesFor makes per request (the named totals'
 * and fsAmountsRankable's), waited for at most RECORD_CURRENCY_BUDGET_MS and
 * started alongside the rows; null when not needed, slow or failed (the
 * amounts then keep the caller's currency, as before). Never rejects. */
export async function recordCurrenciesRead(cap: ModuleCap, ctx: ExecContext): Promise<CompanyCurrencies | null> {
  if (ctx.branchId || !showsBranchAmounts(cap)) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RECORD_CURRENCY_BUDGET_MS); });
  try {
    return await Promise.race([
      companyCurrenciesFor(ctx).catch((err) => {
        logger.warn('CRM assist: company currencies unavailable; amounts keep the caller\'s currency', { module: cap.key, error: (err as Error)?.message });
        return null;
      }),
      late,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `read` with each listed record's own Field Service currency
 * (ReadContext.recordCurrency), from the stored rows' branchId (read before
 * the read projection drops it) and recordCurrenciesRead's answer: only when
 * the companies use more than one currency. A record without a company of its
 * own is in the org's currency, as the named totals count it. */
export function withRecordCurrencies(read: ReadContext, rows: readonly unknown[], currencies: CompanyCurrencies | null): ReadContext {
  if (!currencies || !currencies.byBranch.size) return read;
  const byRecord = new Map<string, string>();
  for (const row of rows) {
    const raw = (row && typeof row === 'object' ? row : {}) as { _id?: unknown; branchId?: unknown };
    if (raw._id === null || raw._id === undefined) continue;
    const branch = raw.branchId === null || raw.branchId === undefined ? '' : String(raw.branchId).toLowerCase();
    byRecord.set(String(raw._id), currencies.byBranch.get(branch) ?? currencies.org);
  }
  return byRecord.size ? { ...read, recordCurrency: byRecord } : read;
}

/** list() can't narrow to the caller's own records, so a "mine" plan here
 * would read every record in scope. validate.ts keeps mine on executor Q;
 * this fails closed if a caller ever skips it. */
function refuseMine(plan: QueryPlan): void {
  if (plan.mine !== undefined) throw new Error('"mine" runs on executor Q only.');
}

/** GET /crm-list's read: list(tenantId, { search, limit, page }, branchId,
 * scope, userId), then applyPIIProtection and projectForRead. validate.ts
 * sends every sorted plan to executor Q (list() sorts have no unique
 * tie-breaker), so plans reach here unsorted; a sort given anyway is passed as
 * list()'s own sortBy / sortDir. Field Service amounts are labelled with each
 * record's own company currency (withRecordCurrencies). */
export async function executeList(cap: ModuleCap, plan: QueryPlan, ctx: ExecContext): Promise<ListOutcome> {
  refuseMine(plan);
  const def = moduleDefFor(cap);
  const page = plan.page ?? 1;
  const size = Math.min(Math.max(plan.pageSize ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const search = plan.search?.trim() || undefined;
  const sort = plan.sort ? { sortBy: plan.sort.by, sortDir: plan.sort.dir } : {};
  const currencies = recordCurrenciesRead(cap, ctx);
  const result = await def.list(ctx.tenantId, { search, limit: size, page, ...sort }, ctx.branchId, ctx.scope, ctx.identity.userId);
  const rows = result.items ?? [];
  const items = await protectAndProject(def, rows, ctx);
  const total = typeof result.total === 'number' && Number.isFinite(result.total) ? result.total : items.length;
  return { items, total, page, size, read: withRecordCurrencies(await loadReadContext(cap, def, ctx), rows, await currencies) };
}

/** GET /crm-count's read: countCrmModule (list() with limit 1, .total), with
 * the plan's search text when it has one (so the count matches the list).
 * null when the total isn't a number — never shown as 0. */
export async function executeCount(cap: ModuleCap, plan: QueryPlan, ctx: ExecContext): Promise<{ total: number | null }> {
  refuseMine(plan);
  const search = plan.search?.trim() || undefined;
  const result = await countCrmModule(cap.key, ctx.tenantId, ctx.scope, ctx.branchId, search ? { search } : {}, ctx.identity.userId);
  const total = result && typeof result.total === 'number' && Number.isFinite(result.total) ? result.total : null;
  return { total };
}

/** One record by its business number. Records carrying the number are
 * looked up by id only, and each is then read through the module's own
 * getById under the caller's scope (as GET /crm-get does), so only the ones
 * the caller may see are counted and returned. The caller's branch narrows
 * the lookup where the module has a branch. Work orders, invoices,
 * quotations and contracts have no unique index on their number, so more
 * than one can match. */
export async function executeDetailByNumber(cap: ModuleCap, number: string, ctx: ExecContext): Promise<DetailOutcome> {
  const def = moduleDefFor(cap);
  const field = cap.ids.business;
  if (!field || !def.getById) throw new Error(`"${cap.key}" has no record-number lookup`);
  const candidates = await recordIdsByNumber(cap, ctx, field, number, MAX_NUMBER_MATCHES + 1);

  const seen = new Set<string>();
  const visible: unknown[] = [];
  const fetched = await Promise.all(candidates.map((c) => def.getById!(String(c._id), ctx.tenantId, ctx.scope)));
  for (const record of fetched) {
    if (!record) continue;
    const id = String((record as { _id?: unknown })._id ?? '');
    if (seen.has(id)) continue;
    seen.add(id);
    visible.push(record);
  }
  if (!visible.length) return { kind: 'not_found' };

  const piiSafe = await applyPIIProtection(visible, def.logModule, ctx.tenantId, ctx.branchId, ctx.identity.role ?? 'AGENT');
  // /crm-get's projection without the writable-field union (that lookup reads
  // the field catalog, which can create pipeline stages).
  const projected = piiSafe.map((item) => stripForbidden(projectForDetail(item, def, [])));
  const read = await loadReadContext(cap, def, ctx);
  return projected.length === 1
    ? { kind: 'record', record: projected[0], read }
    : { kind: 'duplicates', matches: projected, read };
}
