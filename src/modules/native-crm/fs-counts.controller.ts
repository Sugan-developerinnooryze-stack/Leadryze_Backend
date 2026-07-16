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

export async function fsCounts(req: AuthRequest, res: Response) {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const q   = { tenantId: tid };

    const [
      categories, services, teams, staffs, customers, sites, parts,
      workorders, quotations, contracts, invoices, receipts,
      expenses, activities, products, assets, vehicles,
    ] = await Promise.all([
      NativeCategory.countDocuments(q),
      NativeService.countDocuments(q),
      NativeTeam.countDocuments(q),
      NativeStaff.countDocuments(q),
      NativeCustomer.countDocuments(q),
      NativeSite.countDocuments(q),
      NativePart.countDocuments(q),
      NativeWorkorder.countDocuments(q),
      NativeQuotation.countDocuments(q),
      NativeContract.countDocuments(q),
      NativeInvoice.countDocuments(q),
      NativeReceipt.countDocuments(q),
      NativeExpense.countDocuments(q),
      NativeActivity.countDocuments(q),
      NativeProduct.countDocuments(q),
      NativeAsset.countDocuments(q),
      NativeVehicle.countDocuments(q),
    ]);

    sendSuccess(res, {
      categories, services, teams, staffs, customers, sites, parts,
      workorders, quotations, contracts, invoices, receipts,
      expenses, activities, products, assets, vehicles,
    });
  } catch {
    sendError(res, 'Failed to fetch FS counts', 500);
  }
}
