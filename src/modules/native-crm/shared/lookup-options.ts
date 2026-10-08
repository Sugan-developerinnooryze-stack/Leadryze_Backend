import mongoose from 'mongoose';
import { NativeTeam } from '../teams/team.model';
import { NativeSite } from '../sites/site.model';
import { NativeStaff } from '../staffs/staff.model';
import { NativeCustomer } from '../customers/customer.model';
import { Branch } from '../branches/branch.model';
import { getOrCreateStages } from '../pipeline-config/pipeline-config.service';
import { PipelineModule } from '../pipeline-config/pipeline-config.model';

export interface OptionPair { value: string; label: string; }

/** This tenant's REAL, currently-configured pipeline stages for `module`
 * (same source the page's own Status dropdown reads via usePipelineStages)
 * — not a hardcoded enum, so a tenant that renames/reorders/adds stages
 * sees the exact same options in the Filters picker as in the Status
 * dropdown, always in sync. */
export async function getStatusOptions(tenantId: string, module: PipelineModule): Promise<OptionPair[]> {
  const stages = await getOrCreateStages(tenantId, module);
  return stages
    .filter((s) => s.isActive)
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ value: s.key, label: s.label }));
}

/** This tenant's real Companies/Branches, as {value: Mongo _id, label:
 * branchName} — matches how branchId is actually stored on every document
 * module (a real ObjectId ref, unlike Team/Site/Staff's business-id
 * strings). "Default Company" (branchId: null) isn't offered as a filter
 * option here — CompanyFilterBar's own tabs already do that switch, more
 * prominently, at the top of every one of these pages. */
export async function getCompanyOptions(tenantId: string): Promise<OptionPair[]> {
  const branches = await Branch.find({ tenantId: new mongoose.Types.ObjectId(tenantId), status: 'active' })
    .select('branchName').sort({ branchName: 1 }).lean();
  return branches.map((b) => ({ value: String(b._id), label: b.branchName }));
}

/** Real Team/Site/Staff records for this tenant+branch, as {value,label}
 * pairs keyed by each model's own business-friendly id (teamId/siteId/
 * staffId — never Mongo _id, matching how these fields are actually stored
 * on Quotations/Contracts/Work Orders/Invoices). Shared by every module's
 * filter catalog that has these lookup-backed fields, so the fetch logic
 * lives in exactly one place. firstName/lastName are plaintext (not in
 * PII_FIELDS['staffs']), safe to read directly without transformPIIResponse. */
export async function getTeamSiteStaffOptions(
  tenantId: string,
  branchId?: string | null,
): Promise<{ teamOptions: OptionPair[]; siteOptions: OptionPair[]; staffOptions: OptionPair[] }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const scopeFilter: Record<string, unknown> = { tenantId: tid, status: 'active' };
  if (branchId) scopeFilter.branchId = new mongoose.Types.ObjectId(branchId);

  const [teams, sites, staff] = await Promise.all([
    NativeTeam.find(scopeFilter).select('teamId name').sort({ name: 1 }).lean(),
    NativeSite.find(scopeFilter).select('siteId name').sort({ name: 1 }).lean(),
    NativeStaff.find(scopeFilter).select('staffId firstName lastName').sort({ firstName: 1 }).lean(),
  ]);

  return {
    teamOptions:  teams.map((t) => ({ value: t.teamId, label: t.name })),
    siteOptions:  sites.map((s) => ({ value: s.siteId, label: s.name })),
    staffOptions: staff.map((s) => ({ value: s.staffId, label: [s.firstName, s.lastName].filter(Boolean).join(' ') })),
  };
}

/** Real Customers for this tenant+branch, as {value,label} pairs keyed by
 * customerId (the same plain business-friendly string every document
 * module stores — not a Mongo ref, matching useCustomerNameMap's own
 * frontend reasoning). Capped at 500, same bound the frontend's own
 * customer lookup dropdowns already use. */
export async function getCustomerOptions(tenantId: string, branchId?: string | null): Promise<OptionPair[]> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid, status: 'active' };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  const customers = await NativeCustomer.find(filter).select('customerId name').sort({ name: 1 }).limit(500).lean();
  return customers.map((c) => ({ value: c.customerId, label: c.name }));
}
