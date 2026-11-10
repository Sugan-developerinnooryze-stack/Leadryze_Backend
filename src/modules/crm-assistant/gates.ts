import { Response } from 'express';
import { Tenant } from '../tenants/tenant.model';
import { getEffectiveFeatureFlags } from '../tenants/tenant.service';
import { resolveDataScope } from '../native-crm/shared/data-scope';
import { hasPermission } from '../rbac/permission.service';
import { effectiveScopeFor, isModuleFlagDisabled, moduleDisabledMessage } from '../internal/crm-gateway.helpers';
import { sendError } from '../../utils/response';
import { DataScope, JwtPayload } from '../../types';

/* The one implementation of "may this caller read this module": tenant
 * active, module flag, view permission, then the caller's data scope and
 * branch. The internal CRM gateway's read routes (guardModuleRead in
 * internal.routes.ts) and the assistant engine (assist.internal.routes.ts)
 * both go through it, in the same order and with the same messages. */

/** A caller as the gates see it. Verified elsewhere: identity.ts for the
 * assistant engine, verifyInternalIdentity (internal.routes.ts) for the
 * gateway routes. An empty object means "no identity". */
export interface GateIdentity {
  role?: string;
  roleId?: string;
  userId?: string;
  branchId?: string | null;
}

export const IDENTITY_REQUIRED_MESSAGE = 'A verified internalAuth identity is required';
/** The same message as requireTenant (tenant.middleware.ts). */
export const TENANT_INACTIVE_MESSAGE = "Your organization's account has been deactivated. Contact support.";

/** What the gateway needs from the Tenant document, loaded once per
 * request: effective feature flags (through accessConfigMode, exactly like
 * requireTenant resolves req.featureFlags), the per-module data-visibility
 * config, the timezone, and whether the tenant is active. A missing tenant
 * means "no flags" — i.e. every module counts as on, the same as
 * requireModuleEnabled with no flags. */
export interface GatewayTenant {
  flags: Record<string, unknown>;
  dataScopeConfig: Record<string, boolean>;
  timezone: string;
  /** False only for a deactivated tenant (Tenant.isActive === false). */
  isActive: boolean;
  /** The assistant's language as the AI service resolves it
   * (aiConfig.language, else settings.language); '' when not set. */
  language: string;
}

export async function loadGatewayTenant(tenantId: string): Promise<GatewayTenant> {
  const tenant = await Tenant.findById(tenantId)
    .select('isActive featureFlags accessConfigMode dataScopeConfig settings.timezone settings.language aiConfig.language')
    .lean() as any;
  const flags = tenant ? ((await getEffectiveFeatureFlags(tenant)) as unknown as Record<string, unknown>) : {};
  const language = tenant?.aiConfig?.language || tenant?.settings?.language;
  return {
    flags: flags ?? {},
    dataScopeConfig: tenant?.dataScopeConfig ?? {},
    timezone: tenant?.settings?.timezone || 'UTC',
    isActive: tenant?.isActive !== false,
    language: typeof language === 'string' ? language.trim() : '',
  };
}

/** True when the tenant's assistant speaks English: no setting, or a value
 * starting with "en" / "English" — the same test the AI service applies
 * before answering directly (ai/src/tools/crm/direct-answers.ts isEnglish). */
export function isEnglishLanguage(language: string | null | undefined): boolean {
  const lang = typeof language === 'string' ? language.trim() : '';
  return !lang || /^(en|english)\b/i.test(lang);
}

export function isAdminIdentity(identity: GateIdentity): boolean {
  return identity.role === 'SUPER_ADMIN' || identity.role === 'TENANT_ADMIN';
}

/** The roleId rule: a userId is always required; a roleId is required
 * unless the role is SUPER_ADMIN or TENANT_ADMIN, whose permission lookups
 * are bypassed anyway (as requirePermission does on the screens), so a
 * legacy admin token without one still works. */
export function meetsRoleIdRule(identity: GateIdentity): boolean {
  return !!identity.userId && (!!identity.roleId || isAdminIdentity(identity));
}

/** A deactivated tenant stops working at once, even on an internalAuth token
 * minted before; SUPER_ADMIN is exempt. Only an explicit isActive: false is
 * refused: a Tenant document without the field counts as active (the schema
 * default), where requireTenant's lean `!tenant.isActive` would refuse it. */
export function isTenantBlocked(tenant: GatewayTenant, identity: GateIdentity): boolean {
  return !tenant.isActive && identity.role !== 'SUPER_ADMIN';
}

/** Sends the 403 (TENANT_INACTIVE_MESSAGE) and returns true when the tenant
 * is deactivated for this caller. */
export function rejectIfTenantInactive(res: Response, tenant: GatewayTenant, identity: GateIdentity): boolean {
  if (!isTenantBlocked(tenant, identity)) return false;
  sendError(res, TENANT_INACTIVE_MESSAGE, 403);
  return true;
}

export async function identityHasPermission(tenantId: string, identity: GateIdentity, permKey: string): Promise<boolean> {
  if (isAdminIdentity(identity)) return true;
  if (!identity.roleId) return false;
  return hasPermission(tenantId, identity.roleId, permKey).catch(() => false);
}

/** The caller's DataScope. With `moduleKey` (the module's logModule — the
 * same data-visibility key every human controller passes to
 * resolveEffectiveScope), the tenant's per-module "data visibility" toggle
 * is applied exactly as on the human screens, so Manager/Agent counts and
 * lists match what they see in the UI. Without it, the raw role scope
 * (unchanged behaviour for any caller that doesn't pass one). No userId:
 * a scope that matches nothing. */
export async function resolveScopeForIdentity(
  tenantId: string, identity: GateIdentity,
  moduleKey?: string, dataScopeConfig?: Record<string, boolean> | null,
): Promise<DataScope> {
  if (!identity.userId) return { kind: 'self', staffIds: [], teamIds: [], createdByUserIds: [] };
  const base = await resolveDataScope(tenantId, {
    tenantId, userId: identity.userId, role: (identity.role as any) ?? 'AGENT', roleId: identity.roleId, email: '',
  } as JwtPayload);
  return moduleKey ? effectiveScopeFor(base, dataScopeConfig, moduleKey) : base;
}

/** What a module's read gates need. */
export interface ModuleReadSpec {
  /** The tenant feature flag (the module map's flagKey). */
  flagKey: string;
  /** Plural label for the "turned off" message (the module map's label). */
  label: string;
  /** The view permission key (`${permissionPrefix}.view`). */
  viewPermission: string;
  /** The data-visibility key for the scope (the module map's logModule). */
  scopeKey: string;
}

export type ModuleReadRefusal = {
  ok: false;
  status: 403;
  reason: 'tenant_inactive' | 'disabled' | 'no_permission';
  message: string;
};

/** Tenant active, then module flag, then view permission — the order (and
 * messages) of the gateway's guardModuleRead. The caller has already passed
 * the identity check (meetsRoleIdRule). */
export async function checkModuleRead(
  tenantId: string, tenant: GatewayTenant, identity: GateIdentity,
  spec: Pick<ModuleReadSpec, 'flagKey' | 'label' | 'viewPermission'>,
): Promise<{ ok: true } | ModuleReadRefusal> {
  if (isTenantBlocked(tenant, identity)) {
    return { ok: false, status: 403, reason: 'tenant_inactive', message: TENANT_INACTIVE_MESSAGE };
  }
  if (isModuleFlagDisabled(tenant.flags, spec.flagKey, identity.role)) {
    return { ok: false, status: 403, reason: 'disabled', message: moduleDisabledMessage(spec.label) };
  }
  if (!(await identityHasPermission(tenantId, identity, spec.viewPermission))) {
    return { ok: false, status: 403, reason: 'no_permission', message: `Not permitted: ${spec.viewPermission}` };
  }
  return { ok: true };
}

/** Every gate a read needs, in order: flag, view permission, then the
 * caller's effective scope for this module and their branch (null = all
 * branches). The scope and branch returned here are the only ones a read
 * may run with. */
export async function gateModuleRead(
  tenantId: string, tenant: GatewayTenant, identity: GateIdentity, spec: ModuleReadSpec,
): Promise<{ ok: true; scope: DataScope; branchId: string | null } | ModuleReadRefusal> {
  const check = await checkModuleRead(tenantId, tenant, identity, spec);
  if (!check.ok) return check;
  const scope = await resolveScopeForIdentity(tenantId, identity, spec.scopeKey, tenant.dataScopeConfig);
  return { ok: true, scope, branchId: identity.branchId ?? null };
}
