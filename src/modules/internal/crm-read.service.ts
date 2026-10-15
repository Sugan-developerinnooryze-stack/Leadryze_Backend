import mongoose from 'mongoose';
import { CRM_WRITE_MODULE_MAP } from './crm-write.module-map';
import { DataScope } from '../../types';
import { applyDataScopeToFilter, applyDataScopeToCreatedByFilter } from '../native-crm/shared/data-scope';
import { getFieldCatalog } from '../native-crm/automation-rules/automation-rule.service';
import { PipelineModule, BuiltInPipelineModule } from '../native-crm/pipeline-config/pipeline-config.model';
import { ITargetFieldDef } from '../native-crm/automation-rules/target-field-catalog';
import { transformPIIResponse } from '../../platform/pii/pii.service';
import { PII_FIELDS } from '../../platform/pii/constants';
import { getSettings } from '../native-crm/fs-settings/fs-settings.service';

/** Modules whose schema getFieldCatalog() already covers — everything else
 * in CRM_WRITE_MODULE_MAP gets its schema from its own hand-authored
 * `schemaFields` allowlist instead (see that file's own comment on why:
 * extending getFieldCatalog()'s BuiltInPipelineModule type would touch the
 * automation engine for a reason unrelated to automations). */
const FIELD_CATALOG_MODULES = new Set<BuiltInPipelineModule>(['lead', 'workorder', 'invoice', 'task', 'ticket']);

/** Counting reuses each module's own `list()` function (limit:1, read
 * .total) — deliberately NOT a separate `countDocuments` call. `list` is
 * the exact same function the module's own human-facing list screen
 * already calls, so whatever filtering that screen applies today (active/
 * archived flags, branch scoping, anything not independently re-verified
 * per module here) is automatically inherited by the chatbot's count,
 * rather than risking a second, hand-written filter drifting out of sync
 * with the real one. */
export async function countCrmModule(
  module: string, tenantId: string, scope: DataScope, branchId?: string | null,
): Promise<{ total: number } | null> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return null;
  const result = await def.list(tenantId, { limit: 1 }, branchId, scope);
  return { total: result.total };
}

/** The one deliberate exception to "always reuse list()" — "overdue" isn't
 * exposed through any module's existing list() options today. Mirrors the
 * exact shape Task/WorkOrder/Ticket's own getXStats() functions already use
 * for this (confirmed by reading them): a date field in the past AND status
 * not in a terminal set, scoped via the SAME applyDataScopeToFilter/
 * applyDataScopeToCreatedByFilter helpers those stats functions already
 * call — never a third, independent implementation of DataScope filtering. */
export async function getOverdueCrmModule(
  module: string, tenantId: string, scope: DataScope,
  options?: { includeItems?: boolean; limit?: number; branchId?: string | null; role?: string },
): Promise<{ count: number; items?: any[] } | null> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def?.overdueConfig || !def.model) return null;

  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(tenantId) };
  if (def.overdueConfig.scopeAnchor === 'staffIds') {
    applyDataScopeToFilter(filter, scope, 'staffIds');
  } else {
    applyDataScopeToCreatedByFilter(filter, scope);
  }

  const terminalStatuses = typeof def.overdueConfig.terminalStatuses === 'function'
    ? await def.overdueConfig.terminalStatuses(tenantId)
    : def.overdueConfig.terminalStatuses;

  filter[def.overdueConfig.dateField] = { $lt: new Date() };
  filter[def.statusField ?? 'status'] = { $nin: terminalStatuses };

  // Same filter object for both queries — never a second, divergent filter
  // construction for "the list" vs "the count."
  if (!options?.includeItems) {
    const count = await def.model.countDocuments(filter);
    return { count };
  }
  const [count, rawItems] = await Promise.all([
    def.model.countDocuments(filter),
    def.model.find(filter).sort({ [def.overdueConfig.dateField]: 1 }).limit(Math.min(options.limit ?? 10, 25)),
  ]);
  const piiSafe = await applyPIIProtection(rawItems, def.logModule, tenantId, options.branchId, options.role ?? 'AGENT');
  const items = def.schemaFields ? projectToSchemaFields(piiSafe, def.schemaFields) : piiSafe;
  return { count, items };
}

/** Applies the SAME PII decrypt/mask step every human-facing controller for
 * a PII_FIELDS-registered module (leads/customers/contacts/staffs/sites)
 * already calls on its own list/getOne results — found missing here during
 * Stage A live verification: GET /crm-list calls `moduleDef.list()` (the
 * module's service function) directly, bypassing the controller entirely,
 * so Level 2/3 PII fields (email/phone/address/etc.) rode through to the AI
 * service as raw ciphertext instead of being decrypted-for-admins or
 * masked-for-everyone-else like the real UI does. Mirrors each controller's
 * own `getPIIViewRoles` helper (tenant fs-settings piiConfig for that
 * module) rather than reimplementing the lookup. A no-op for any module not
 * in PII_FIELDS (most of Stage A's modules have no registered PII fields at
 * all). Affects lead (Phase 1) too — same gap, same fix. */
export async function applyPIIProtection(
  items: any[], logModule: string, tenantId: string, branchId: string | null | undefined, role: string,
): Promise<any[]> {
  if (!PII_FIELDS[logModule]) return items;
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  const viewRoles: string[] = (settings as any)?.piiConfig?.find((p: any) => p.module === logModule)?.viewRoles ?? [];
  return transformPIIResponse(items, logModule, role, viewRoles);
}

/** Projects raw list()/search results down to a module's own `schemaFields`
 * allowlist before they ever leave this service — closes a real gap found
 * during Stage A live verification: `schemaFields` only governed what
 * getCrmModuleSchema() described and what the prompt told the model to
 * mention, but GET /crm-list returned each item's full Mongoose document
 * unfiltered, so a credential-adjacent field with no `select: false`
 * (Staff/Customer's `appUsername`, `appCredentialsGeneratedAt`,
 * `appLastLoginAt` — real mobile-app login identifiers, not secrets
 * themselves, but still never meant to reach a third-party LLM provider)
 * rode along into the AI service's tool-result payload regardless of what
 * the final chat response said. Only applied to modules with `schemaFields`
 * declared — the 5 getFieldCatalog()-covered modules (lead/workorder/
 * invoice/task/ticket) are untouched, exactly as Phase 1 already
 * live-verified them. `_id` is always kept (an opaque identifier, needed by
 * any future write-side follow-up — Stage A itself never writes). */
export function projectToSchemaFields(items: any[], schemaFields: ITargetFieldDef[]): Record<string, unknown>[] {
  const keys = schemaFields.map((f) => f.key);
  return items.map((item) => {
    const doc = typeof item.toObject === 'function' ? item.toObject() : item;
    const projected: Record<string, unknown> = { _id: doc._id };
    for (const key of keys) {
      if (key in doc) projected[key] = doc[key];
    }
    return projected;
  });
}

export interface CrmModuleSchemaResult {
  module: string;
  fields: ITargetFieldDef[];
  /** True when this came from the automation engine's own field catalog
   * (lead/workorder/invoice/task/ticket) rather than this file's
   * hand-authored allowlist — informational only, lets a caller note the
   * source if useful, never changes the shape returned. */
  fromAutomationCatalog: boolean;
}

/** Schema introspection — getFieldCatalog() for the 5 modules it already
 * covers (lead/workorder/invoice/task/ticket — the automation engine's own
 * BuiltInPipelineModule values), each module's own hand-authored
 * `schemaFields` allowlist otherwise. Never a raw Mongoose-schema
 * reflection — see crm-write.module-map.ts's own comment on why (keeping
 * credential/internal-only fields, e.g. Staff's app-login fields,
 * impossible to expose even by accident). */
export async function getCrmModuleSchema(module: string, tenantId: string): Promise<CrmModuleSchemaResult | null> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return null;

  if (FIELD_CATALOG_MODULES.has(module as BuiltInPipelineModule)) {
    const fields = await getFieldCatalog(tenantId, module as PipelineModule);
    return { module, fields, fromAutomationCatalog: true };
  }

  return { module, fields: def.schemaFields ?? [], fromAutomationCatalog: false };
}
