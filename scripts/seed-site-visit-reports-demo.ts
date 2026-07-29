/**
 * One-time demo seed #2: builds a BRAND NEW Custom Module from scratch —
 * "Site Visit Reports" — fully wired end to end (fields, a real pipeline,
 * sample records, and 3 automation rules), deliberately covering
 * configuration patterns the first demo seed (seed-demo-configuration.ts)
 * did NOT show:
 *
 *  - a Custom Module with its OWN relationship field pointing at another
 *    Custom Module ("sample test"), not just at built-in modules
 *  - a create_linked_record rule targeting that OTHER Custom Module
 *    (custom -> custom, vs. the first seed's custom -> built-in Invoice)
 *  - the automatic source-side back-reference writeback actually visible
 *    (the new module's own relationship field gets populated with the
 *    created work-order's ID, with nothing extra to configure for it)
 *
 * Run ONCE:
 *   cd backend && npx ts-node scripts/seed-site-visit-reports-demo.ts
 *
 * Requires seed-demo-configuration.ts to have already been run once (reuses
 * its "sample test" pipeline/fields and its two message templates).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Tenant } from '../src/modules/tenants/tenant.model';
import { NativeCustomer } from '../src/modules/native-crm/customers/customer.model';
import { NativeStaff } from '../src/modules/native-crm/staffs/staff.model';
import { NativeSite } from '../src/modules/native-crm/sites/site.model';
import { Template } from '../src/modules/templates/template.model';
import { createCustomModule, createCustomRecord } from '../src/modules/custom-modules/custom-module.service';
import { updateStages } from '../src/modules/native-crm/pipeline-config/pipeline-config.service';
import { createRule } from '../src/modules/native-crm/automation-rules/automation-rule.service';

async function run() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const tenant = await Tenant.findOne({}).lean();
  if (!tenant) throw new Error('No tenant found');
  const tenantId = String((tenant as any)._id);
  console.log('Seeding "Site Visit Reports" demo for tenant', (tenant as any).name ?? tenantId);

  /* ── 1. Create the module, fresh, with a real pipeline field from the start ── */
  const mod = await createCustomModule(tenantId, {
    name: 'Site Visit Reports',
    singularName: 'Site Visit Report',
    icon: '🧰',
    color: '#0ea5e9',
    showInSidebar: true,
    fields: [
      { key: 'customer', label: 'Customer', fieldType: 'relationship', required: false, options: [], meta: { targetModule: 'customers', subFields: ['name', 'email'] }, order: 0 },
      { key: 'technician', label: 'Technician', fieldType: 'relationship', required: false, options: [], meta: { targetModule: 'staffs' }, order: 1 },
      { key: 'site', label: 'Site', fieldType: 'relationship', required: false, options: [], meta: { targetModule: 'sites' }, order: 2 },
      { key: 'visitDate', label: 'Visit Date', fieldType: 'date', required: false, order: 3 },
      { key: 'findings', label: 'Findings', fieldType: 'textarea', required: false, order: 4 },
      { key: 'visitStatus', label: 'Visit Status', fieldType: 'select', required: false, options: ['scheduled', 'in_progress', 'completed'], order: 5 },
      // Points at the OTHER custom module ("sample test") — this is what
      // lets the automatic back-reference writeback (see
      // automation-rule.service.ts's writeSourceBackReference) find a home
      // once rule #3 below creates a linked sample-test record.
      { key: 'relatedWorkOrder', label: 'Related Work Order', fieldType: 'relationship', required: false, options: [], meta: { targetModule: 'sample-test' }, order: 6 },
    ],
    pipelineFieldKey: 'visitStatus',
  } as any);
  console.log('Created module:', mod.name, '(slug:', mod.slug, ')');

  /* ── 2. Give it real pipeline stages ─────────────────────────────────────── */
  await updateStages(tenantId, `custom:${mod.slug}` as any, [
    { key: 'scheduled', label: 'Scheduled', color: '#0ea5e9', order: 0, isTerminal: false, outcome: null, isActive: true },
    { key: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 1, isTerminal: false, outcome: null, isActive: true },
    { key: 'completed', label: 'Completed', color: '#10b981', order: 2, isTerminal: true, outcome: null, isActive: true },
  ] as any);
  console.log('Pipeline configured: Scheduled -> In Progress -> Completed');

  /* ── 3. Sample records, referencing REAL customers/staff/sites already in this tenant ── */
  const customers = await NativeCustomer.find({ tenantId }).select('customerId name').limit(3).sort({ createdAt: -1 }).lean();
  const staff = await NativeStaff.find({ tenantId }).select('staffId firstName').limit(3).sort({ createdAt: -1 }).lean();
  const sites = await NativeSite.find({ tenantId }).select('siteId name').limit(3).sort({ createdAt: -1 }).lean();
  if (customers.length < 2 || staff.length < 2 || sites.length < 2) {
    throw new Error('Expected at least 2 customers/staff/sites to already exist — run seed-demo-configuration.ts first');
  }

  const rec1 = await createCustomRecord(tenantId, mod.slug, {
    customer: (customers[0] as any).customerId, technician: (staff[0] as any).staffId, site: (sites[0] as any).siteId,
    visitDate: new Date().toISOString(), findings: 'Routine inspection — all systems normal.', visitStatus: 'scheduled',
  }, 'demo-seed');
  const rec2 = await createCustomRecord(tenantId, mod.slug, {
    customer: (customers[1] as any).customerId, technician: (staff[1] as any).staffId, site: (sites[1] as any).siteId,
    visitDate: new Date().toISOString(), findings: 'Compressor running hot — recommend follow-up service.', visitStatus: 'in_progress',
  }, 'demo-seed');
  const rec3 = await createCustomRecord(tenantId, mod.slug, {
    customer: (customers[0] as any).customerId, technician: (staff[1] as any).staffId, site: (sites[0] as any).siteId,
    visitDate: new Date().toISOString(), findings: 'Panel wiring re-secured, tested load.', visitStatus: 'scheduled',
  }, 'demo-seed');
  console.log('Sample records created:', rec1.recordId, rec2.recordId, rec3.recordId);

  /* ── 4. Three automation rules — deliberately different patterns from the first demo ── */
  const emailTemplate = await Template.findOne({ tenantId, name: 'Demo — Status update email' }).lean();
  if (!emailTemplate) throw new Error('Expected the email template from seed-demo-configuration.ts to already exist');

  // (1) record_created -> send_email -> record_contact (resolves via this module's OWN 'customer' relationship field)
  const rule1 = await createRule(tenantId, {
    module: `custom:${mod.slug}`, name: 'Notify customer when a visit is logged', enabled: true,
    triggerType: 'record_created', actionType: 'send_email',
    templateId: (emailTemplate as any)._id.toString(), recipientStrategy: 'record_contact',
  } as any);

  // (2) status_changed -> completed -> create_linked_record -> Task (custom -> built-in),
  // copying from a TEXTAREA field this time (not a relationship id like the first demo did)
  const rule2 = await createRule(tenantId, {
    module: `custom:${mod.slug}`, name: 'Completed visit -> create invoice-prep task', enabled: true,
    triggerType: 'status_changed', triggerStage: 'completed',
    actionType: 'create_linked_record', targetModule: 'task',
    fieldMappings: [
      { targetField: 'title', sourceType: 'static', staticValue: 'Prepare invoice for completed site visit' },
      { targetField: 'priority', sourceType: 'static', staticValue: 'medium' },
      { targetField: 'notes', sourceType: 'field', sourceField: 'data.findings' },
    ],
  } as any);

  // (3) status_changed -> completed -> create_linked_record -> ANOTHER Custom Module
  // ("sample test") — custom-to-custom, not demonstrated in the first seed.
  // No explicit backReferenceField needed here: this module's own
  // 'relatedWorkOrder' relationship field (pointed at sample-test) is enough
  // for the automatic source-side writeback to find and populate on its own.
  const rule3 = await createRule(tenantId, {
    module: `custom:${mod.slug}`, name: 'Completed visit -> log a work order', enabled: true,
    triggerType: 'status_changed', triggerStage: 'completed',
    actionType: 'create_linked_record', targetModule: 'custom:sample-test',
    fieldMappings: [
      { targetField: 'customers', sourceType: 'field', sourceField: 'data.customer' },
      { targetField: 'staffs', sourceType: 'field', sourceField: 'data.technician' },
      { targetField: 'work_status', sourceType: 'static', staticValue: 'open' },
    ],
  } as any);

  console.log('\nAutomation rules created:');
  [rule1, rule2, rule3].forEach((r: any) =>
    console.log(`- ${r.name} | ${r.module} | ${r.triggerType}${r.triggerStage ? `/${r.triggerStage}` : ''} -> ${r.actionType}${r.targetModule ? ` (${r.targetModule})` : ''}`));

  console.log('\nDone. Drag "Kavitha Nair" or the in-progress record to Completed on the Site Visit Reports Kanban board to watch rules #2 and #3 fire live.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
