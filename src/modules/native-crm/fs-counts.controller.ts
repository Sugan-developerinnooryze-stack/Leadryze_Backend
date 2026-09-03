import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthRequest }                   from '../../types';
import { sendSuccess, sendError }        from '../../utils/response';
import { NativeCategory }  from './categories/category.model';
import { NativeService }   from './services/service.model';
import { NativeTeam }      from './teams/team.model';
import { NativeStaff }     from './staffs/staff.model';
import { NativeCustomer }  from './customers/customer.model';
import { NativeSite }      from './sites/site.model';
import { NativePart }      from './parts/part.model';
import { NativeWorkorder } from './workorders/workorder.model';
import { NativeQuotation } from './quotations/quotation.model';
import { NativeContract }  from './contracts/contract.model';
import { NativeInvoice }   from './invoices/invoice.model';
import { NativeReceipt }   from './receipts/receipt.model';
import { NativeExpense }   from './expenses/expense.model';
import { NativeActivity }  from './activities/activity.model';
import { NativeProduct }   from './products/product.model';
import { NativeAsset }     from './assets/asset.model';
import { NativeVehicle }   from './vehicles/vehicle.model';
import { Lead }            from './leads/lead.model';
import { Deal }            from './deals/deal.model';
import {
  resolveEffectiveScope, applyDataScopeToFilter, applyDataScopeToCreatedByFilter, applyDataScopeToTeamFilter,
} from './shared/data-scope';

/** Sidebar badge counts — same tenant-scoped shape as before, now ALSO
 * respecting the per-module Data Visibility toggle (native-crm/shared/
 * data-scope.ts), same as every list/stats endpoint. Without this, a
 * Manager/Agent's sidebar badge showed the raw tenant-wide count even
 * though the module's own list page correctly showed their scoped subset —
 * a real, confusing mismatch (e.g. "Teams 2" in the sidebar, but only 1
 * team actually visible on the Teams page). */
export async function fsCounts(req: AuthRequest, res: Response) {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const base = () => ({ tenantId: tid }) as Record<string, unknown>;

    const staffAnchored = (moduleKey: string, field: string) => {
      const f = base();
      applyDataScopeToFilter(f, resolveEffectiveScope(req, moduleKey), field);
      return f;
    };
    const createdByAnchored = (moduleKey: string) => {
      const f = base();
      applyDataScopeToCreatedByFilter(f, resolveEffectiveScope(req, moduleKey));
      return f;
    };
    const teamFilter = (() => {
      const f = base();
      applyDataScopeToTeamFilter(f, resolveEffectiveScope(req, 'teams'));
      return f;
    })();

    const [
      leads, deals,
      categories, services, teams, staffs, customers, sites, parts,
      workorders, quotations, contracts, invoices, receipts,
      expenses, activities, products, assets, vehicles,
    ] = await Promise.all([
      Lead.countDocuments(staffAnchored('leads', 'leadOwnerStaffId')),
      Deal.countDocuments(staffAnchored('deals', 'assignedStaffId')),
      NativeCategory.countDocuments(createdByAnchored('categories')),
      NativeService.countDocuments(createdByAnchored('services')),
      NativeTeam.countDocuments(teamFilter),
      NativeStaff.countDocuments(staffAnchored('staffs', 'staffId')),
      NativeCustomer.countDocuments(staffAnchored('customers', 'assignedStaffId')),
      NativeSite.countDocuments(createdByAnchored('sites')),
      NativePart.countDocuments(createdByAnchored('parts')),
      NativeWorkorder.countDocuments(staffAnchored('workorders', 'staffIds')),
      NativeQuotation.countDocuments(createdByAnchored('quotations')),
      NativeContract.countDocuments(staffAnchored('contracts', 'staffIds')),
      NativeInvoice.countDocuments(createdByAnchored('invoices')),
      NativeReceipt.countDocuments(createdByAnchored('receipts')),
      NativeExpense.countDocuments(createdByAnchored('expenses')),
      NativeActivity.countDocuments(createdByAnchored('activities')),
      NativeProduct.countDocuments(createdByAnchored('products')),
      NativeAsset.countDocuments(createdByAnchored('assets')),
      NativeVehicle.countDocuments(createdByAnchored('vehicles')),
    ]);

    sendSuccess(res, {
      leads, deals,
      categories, services, teams, staffs, customers, sites, parts,
      workorders, quotations, contracts, invoices, receipts,
      expenses, activities, products, assets, vehicles,
    });
  } catch {
    sendError(res, 'Failed to fetch FS counts', 500);
  }
}
