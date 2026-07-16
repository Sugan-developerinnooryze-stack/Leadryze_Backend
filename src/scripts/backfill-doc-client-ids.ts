/**
 * Migration: stamp the tenant's clientId onto every Native CRM / Field Service /
 * Custom Module document that is missing one. Safe to re-run — only touches
 * docs where clientId is absent/null/empty.
 *
 * Also assigns a clientId to any tenant still missing one (same logic as
 * backfill-client-ids.ts), so every document ends up with a real 8-char code.
 *
 * Run with: npx ts-node --project tsconfig.json src/scripts/backfill-doc-client-ids.ts
 */
import crypto from 'crypto';
import mongoose, { Model } from 'mongoose';
import { config } from '../config';
import { Tenant } from '../modules/tenants/tenant.model';

// Core FS/CRM data models
import { NativeCustomer }  from '../modules/native-crm/customers/customer.model';
import { Lead }            from '../modules/native-crm/leads/lead.model';
import { Deal }            from '../modules/native-crm/deals/deal.model';
import { Contact }         from '../modules/native-crm/contacts/contact.model';
import { Company }         from '../modules/native-crm/companies/company.model';
import { Task }            from '../modules/native-crm/tasks/task.model';
import { Ticket }          from '../modules/native-crm/tickets/ticket.model';
import { Call }            from '../modules/native-crm/calls/call.model';
import { Meeting }         from '../modules/native-crm/meetings/meeting.model';
import { NativeActivity }  from '../modules/native-crm/activities/activity.model';
import { NativeWorkorder } from '../modules/native-crm/workorders/workorder.model';
import { NativeQuotation } from '../modules/native-crm/quotations/quotation.model';
import { NativeContract }  from '../modules/native-crm/contracts/contract.model';
import { NativeInvoice }   from '../modules/native-crm/invoices/invoice.model';
import { NativeReceipt }   from '../modules/native-crm/receipts/receipt.model';
import { NativeExpense }   from '../modules/native-crm/expenses/expense.model';
import { NativePart }      from '../modules/native-crm/parts/part.model';
import { NativeService }   from '../modules/native-crm/services/service.model';
import { NativeCategory }  from '../modules/native-crm/categories/category.model';
import { NativeTeam }      from '../modules/native-crm/teams/team.model';
import { NativeStaff }     from '../modules/native-crm/staffs/staff.model';
import { NativeSite }      from '../modules/native-crm/sites/site.model';
import { NativeProduct }   from '../modules/native-crm/products/product.model';
import { NativeAsset }     from '../modules/native-crm/assets/asset.model';
import { NativeVehicle }   from '../modules/native-crm/vehicles/vehicle.model';
// Newly covered models
import { Branch }                   from '../modules/native-crm/branches/branch.model';
import { NativeCustomField }        from '../modules/native-crm/custom-fields/custom-field.model';
import { NativeCustomFormTemplate } from '../modules/native-crm/custom-fields/custom-form-template.model';
import { CustomTemplate }           from '../modules/native-crm/custom-templates/custom-template.model';
import { WorkflowTemplate }         from '../modules/native-crm/workflow/workflow-template.model';
import { NativeTimeline }           from '../modules/native-crm/timeline/timeline.model';
import { CustomModuleDef, CustomRecord } from '../modules/custom-modules/custom-module.model';
import { NativeCrmLog }             from '../modules/logs/native-crm-log.model';

const MODELS: Array<[string, Model<any>]> = [
  ['customers', NativeCustomer], ['leads', Lead], ['deals', Deal],
  ['contacts', Contact], ['companies', Company], ['tasks', Task],
  ['tickets', Ticket], ['calls', Call], ['meetings', Meeting],
  ['activities', NativeActivity], ['workorders', NativeWorkorder],
  ['quotations', NativeQuotation], ['contracts', NativeContract],
  ['invoices', NativeInvoice], ['receipts', NativeReceipt],
  ['expenses', NativeExpense], ['parts', NativePart],
  ['services', NativeService], ['categories', NativeCategory],
  ['teams', NativeTeam], ['staffs', NativeStaff], ['sites', NativeSite],
  ['products', NativeProduct], ['assets', NativeAsset], ['vehicles', NativeVehicle],
  ['branches', Branch], ['custom-fields', NativeCustomField],
  ['custom-form-templates', NativeCustomFormTemplate],
  ['custom-templates', CustomTemplate], ['workflow-templates', WorkflowTemplate],
  ['timeline', NativeTimeline],
  ['custom-module-defs', CustomModuleDef], ['custom-records', CustomRecord],
];

const MISSING = { $or: [{ clientId: { $exists: false } }, { clientId: null }, { clientId: '' }] };

async function run() {
  await mongoose.connect(config.mongodb.uri);
  console.log('Connected to MongoDB');

  // 1. Ensure every tenant has a clientId; build the tenantId → clientId map
  const tenants = await Tenant.find({}).select('_id name clientId').lean();
  const map = new Map<string, string>();
  for (const t of tenants) {
    let cid = (t as any).clientId as string | undefined;
    if (!cid) {
      let tries = 0;
      do {
        cid = crypto.randomBytes(4).toString('hex').toUpperCase();
        tries++;
      } while (tries < 20 && await Tenant.exists({ clientId: cid }));
      await Tenant.updateOne({ _id: t._id }, { $set: { clientId: cid } });
      console.log(`  ✓ tenant ${(t as any).name ?? t._id} → new clientId ${cid}`);
    }
    map.set(String(t._id), cid!);
  }
  console.log(`${map.size} tenant(s) mapped\n`);

  // 2. Stamp clientId on every doc missing it, per tenant, per collection
  let grandTotal = 0;
  for (const [label, model] of MODELS) {
    let modified = 0;
    for (const [tid, cid] of map) {
      // NativeCrmLog stores tenantId as a String; ObjectId models cast automatically
      const res = await model.updateMany(
        { tenantId: tid as any, ...MISSING },
        { $set: { clientId: cid } },
      );
      modified += res.modifiedCount ?? 0;
    }
    grandTotal += modified;
    console.log(`  ${label.padEnd(24)} ${modified ? `✓ ${modified} doc(s) stamped` : '— none missing'}`);
  }

  console.log(`\nDone. ${grandTotal} document(s) backfilled.`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
