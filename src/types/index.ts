import { Request } from 'express';
import { Document } from 'mongoose';

export type UserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MANAGER' | 'AGENT' | 'USER';

export interface JwtPayload {
  userId:   string;
  tenantId: string;
  role:     UserRole;
  email:    string;
  roleId?:  string;   // DB role ID — undefined for legacy sessions (TENANT_ADMIN fast-path)
  iat?:     number;
  exp?:     number;
}

/** Row-level data-scoping decision, set once per request by
 * native-crm/shared/data-scope.ts's resolveDataScope middleware, additive
 * alongside (not a replacement for) the existing branchId scoping. Used by
 * every native-crm module that opts in — the original 5 (leads/meetings/
 * customers/teams/staffs) key off staffIds; modules with no staff-assignment
 * field of their own (Contacts, Companies, Tickets, ...) key off
 * createdByUserIds instead via applyDataScopeToCreatedByFilter(). */
export interface DataScope {
  kind: 'all' | 'team' | 'self';
  /** Populated for 'team' (every staffId across every team this MANAGER
   * manages) and for 'self' (a single-entry array with the requester's own
   * linked staffId) — empty for 'all', and empty for 'self' when the
   * requester has no linked Staff profile (deliberately matches nothing,
   * never falls back to showing everything). */
  staffIds: string[];
  /** Which NativeTeam _ids this scope covers — 'team' (MANAGER): every team
   * they manage; 'self' (AGENT): the single team their own linked Staff
   * profile belongs to, if any. Used only by the Teams list's own scoping
   * (Leads/Meetings/Customers/Staffs all key off staffIds instead). */
  teamIds: string[];
  /** Which login User ids this scope covers, for modules with no real
   * staff-assignment field — 'team' (MANAGER): their own userId plus every
   * User linked (via NativeStaff.userId) to staff on the team(s) they
   * manage; 'self' (AGENT): just their own userId; empty for 'all'. */
  createdByUserIds: string[];
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  tenantId?: string;
  branchId?: string;
  dataScope?: DataScope;
  /** Per-module "is row-level scoping actually enforced for this module"
   * decision, resolved once per request alongside dataScope — merges the
   * tenant's own saved Tenant.dataScopeConfig over DEFAULT_DATA_SCOPE_CONFIG
   * (native-crm/shared/data-scope.ts) so every module has a correct answer
   * even before a Tenant Admin ever visits the settings page. Read via
   * resolveEffectiveScope(req, moduleKey), never this map directly. */
  dataScopeConfig?: Record<string, boolean>;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: unknown;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export interface PaginationOptions {
  page: number;
  limit: number;
  sort: string;
  order: 'asc' | 'desc';
}

export interface AuditLogEntry {
  tenantId: string;
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string;
  userAgent: string;
  payload?: unknown;
  duration: number;
  timestamp: Date;
}
