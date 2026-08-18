import mongoose from 'mongoose';
import { Response, NextFunction } from 'express';
import { AuthRequest, DataScope, JwtPayload } from '../../../types';
import { NativeTeam } from '../teams/team.model';
import { NativeStaff } from '../staffs/staff.model';
import { Tenant } from '../../tenants/tenant.model';

/** Row-level data-scoping decision for a request, computed once from the
 * authenticated user's role plus the (optional) NativeTeam.managerUserId /
 * NativeStaff.userId links — see the plan's own "closing the role is just
 * a label gap" write-up for why this exists. SUPER_ADMIN/TENANT_ADMIN keep
 * today's exact unscoped behavior; MANAGER/AGENT get a real, new filter. */
export async function resolveDataScope(tenantId: string, user: JwtPayload): Promise<DataScope> {
  if (user.role === 'SUPER_ADMIN' || user.role === 'TENANT_ADMIN') {
    return { kind: 'all', staffIds: [], teamIds: [], createdByUserIds: [] };
  }

  const tid = new mongoose.Types.ObjectId(tenantId);
  const uid = new mongoose.Types.ObjectId(user.userId);

  if (user.role === 'MANAGER') {
    const managedTeams = await NativeTeam.find({ tenantId: tid, managerUserId: uid }).select('_id').lean();
    const teamObjectIds = managedTeams.map((t) => t._id);
    const staffInTeams = teamObjectIds.length
      ? await NativeStaff.find({ tenantId: tid, teamId: { $in: teamObjectIds } }).select('staffId teamId userId').lean()
      : [];
    const ownStaff = await NativeStaff.findOne({ tenantId: tid, userId: uid }).select('staffId teamId').lean();

    const staffIds = new Set(staffInTeams.map((s) => s.staffId));
    const teamIds = new Set(teamObjectIds.map(String));
    const createdByUserIds = new Set<string>([user.userId]);
    staffInTeams.forEach((s) => { if (s.userId) createdByUserIds.add(String(s.userId)); });
    if (ownStaff) {
      staffIds.add(ownStaff.staffId);
      if (ownStaff.teamId) teamIds.add(String(ownStaff.teamId));
    }
    return {
      kind: 'team',
      staffIds: Array.from(staffIds),
      teamIds: Array.from(teamIds),
      createdByUserIds: Array.from(createdByUserIds),
    };
  }

  // AGENT / USER (legacy alias of AGENT) — scoped to their own linked Staff
  // profile only. No linked profile → staffIds/teamIds stay empty, which
  // every caller must treat as "matches nothing", never "unscoped".
  // createdByUserIds always has their own userId regardless — createdBy
  // scoping is about who made the record, not about a Staff-profile link.
  const ownStaff = await NativeStaff.findOne({ tenantId: tid, userId: uid }).select('staffId teamId').lean();
  return {
    kind: 'self',
    staffIds: ownStaff ? [ownStaff.staffId] : [],
    teamIds: ownStaff?.teamId ? [String(ownStaff.teamId)] : [],
    createdByUserIds: [user.userId],
  };
}

/** Per-module "is scoping actually enforced" defaults — read whenever a
 * tenant hasn't explicitly set Tenant.dataScopeConfig[key] yet, so behavior
 * is correct before any admin ever visits the settings page. Catalog/
 * reference modules (shared setup data, not personally owned by one
 * Supervisor) default OFF; everything transactional defaults ON — matches
 * the already-scoped 5 modules' existing behavior exactly. */
export const DEFAULT_DATA_SCOPE_CONFIG: Record<string, boolean> = {
  leads: true, meetings: true, customers: true, teams: true, staffs: true,
  deals: true, tasks: true, workorders: true, contracts: true,
  activities: true, assets: true, vehicles: true,
  contacts: true, companies: true, tickets: true, calls: true, sites: true,
  quotations: true, invoices: true, receipts: true, expenses: true,
  categories: false, services: false, products: false, parts: false, catalog: false,
};

export async function resolveDataScopeMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user || !req.tenantId) { next(); return; }
  try {
    const [scope, tenant] = await Promise.all([
      resolveDataScope(req.tenantId, req.user),
      Tenant.findById(req.tenantId).select('dataScopeConfig').lean(),
    ]);
    req.dataScope = scope;
    req.dataScopeConfig = { ...DEFAULT_DATA_SCOPE_CONFIG, ...(tenant?.dataScopeConfig ?? {}) };
  } catch {
    // Fail closed, not open — an error resolving scope must never silently
    // grant unscoped access. 'self' + empty staffIds/teamIds matches nothing.
    req.dataScope = { kind: 'self', staffIds: [], teamIds: [], createdByUserIds: [] };
    req.dataScopeConfig = DEFAULT_DATA_SCOPE_CONFIG;
  }
  next();
}

/** The one thing every scoped module's filter-builder should actually call
 * — resolves whether THIS module's toggle is on before deciding whether to
 * apply row-level scoping at all. When a module's toggle is off, returns a
 * synthetic 'all' scope so Manager/Agent see everything for that module,
 * exactly like Tenant Admin already does — the toggle only ever WIDENS
 * visibility for Manager/Agent, it never narrows Tenant Admin's. */
export function resolveEffectiveScope(req: AuthRequest, moduleKey: string): DataScope {
  const scope = req.dataScope;
  if (!scope || scope.kind === 'all') return scope ?? { kind: 'all', staffIds: [], teamIds: [], createdByUserIds: [] };
  const enabled = req.dataScopeConfig?.[moduleKey] ?? DEFAULT_DATA_SCOPE_CONFIG[moduleKey] ?? true;
  return enabled ? scope : { kind: 'all', staffIds: [], teamIds: [], createdByUserIds: [] };
}

/** Small shared helpers every scoped module's filter-builder calls the same
 * way — mirrors how branchId scoping is already applied ad hoc per module,
 * just centralizing the "how do I turn a DataScope into a Mongo filter
 * fragment" logic in one place instead of copy-pasting the if/else 5 times. */
export function applyDataScopeToFilter(filter: Record<string, unknown>, scope: DataScope | undefined, ownerField: string): void {
  if (!scope || scope.kind === 'all') return;
  filter[ownerField] = { $in: scope.staffIds };
}

/** Same idea, for modules with no real staff-assignment field — scopes on
 * who CREATED the record instead (Contacts, Companies, Tickets, Calls,
 * Sites, Quotations, Invoices, Receipts, Expenses, and the catalog/
 * reference modules once their own toggle is turned on). */
export function applyDataScopeToCreatedByFilter(filter: Record<string, unknown>, scope: DataScope | undefined, field = 'createdBy'): void {
  if (!scope || scope.kind === 'all') return;
  filter[field] = { $in: scope.createdByUserIds };
}

/** Same idea, for the Teams list itself (keyed on _id/teamIds rather than
 * an ownerField/staffIds — a Manager sees the teams they manage, an Agent
 * sees only their own team, if linked to one). */
export function applyDataScopeToTeamFilter(filter: Record<string, unknown>, scope: DataScope | undefined): void {
  if (!scope || scope.kind === 'all') return;
  filter._id = { $in: scope.teamIds.map((id) => new mongoose.Types.ObjectId(id)) };
}
