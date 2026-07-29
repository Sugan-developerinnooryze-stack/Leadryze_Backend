/**
 * One-time demo seed: adds a handful of realistic core-CRM records (staff,
 * teams, customers, sites, leads, deals) plus 6 example Automation Rules
 * that each demonstrate a DIFFERENT configuration approach — different
 * trigger types, action types, and recipient strategies, across both
 * built-in modules and the tenant's own "sample test" Custom Module — so
 * a tenant admin unfamiliar with the Configuration area has real, working
 * examples to look at instead of an empty page.
 *
 * Also gives the "sample test" Custom Module an actual pipeline: adds a new
 * `work_status` select field, designates it as the module's pipeline field,
 * and configures 3 stages for it (Open / In Progress / Completed) — none of
 * that existed before this script ran.
 *
 * Run ONCE:
 *   cd backend && npx ts-node scripts/seed-demo-configuration.ts
 *
 * Not safe to re-run blindly — it always inserts new records rather than
 * checking for existing ones (this is a one-off demo seed, not an
 * idempotent migration).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Tenant } from '../src/modules/tenants/tenant.model';
import { createStaff } from '../src/modules/native-crm/staffs/staff.service';
import { createTeam } from '../src/modules/native-crm/teams/team.service';
import { createCustomer } from '../src/modules/native-crm/customers/customer.service';
import { createSite } from '../src/modules/native-crm/sites/site.service';
import { createLead } from '../src/modules/native-crm/leads/lead.service';
import { createDeal } from '../src/modules/native-crm/deals/deal.service';
import { createRule } from '../src/modules/native-crm/automation-rules/automation-rule.service';
import { updateCustomModule, createCustomRecord } from '../src/modules/custom-modules/custom-module.service';
import { CustomModuleDef } from '../src/modules/custom-modules/custom-module.model';
import { updateStages } from '../src/modules/native-crm/pipeline-config/pipeline-config.service';
import { Template } from '../src/modules/templates/template.model';

async function run() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const tenant = await Tenant.findOne({}).lean();
  if (!tenant) throw new Error('No tenant found');
  const tenantId = String((tenant as any)._id);
  const ts = Date.now();
  console.log('Seeding demo configuration for tenant', (tenant as any).name ?? tenantId);

  /* ── 1. Staff ──────────────────────────────────────────────────────────── */
  const staff1 = await createStaff({
    tenantId, firstName: 'Meera', lastName: 'Nair',
    email: `meera.nair.${ts}@innooryze-demo.in`, phone: '9876500001',
    role: 'Sales Executive', status: 'active',
  });
  const staff2 = await createStaff({
    tenantId, firstName: 'Suresh', lastName: 'Iyer',
    email: `suresh.iyer.${ts}@innooryze-demo.in`, phone: '9876500002',
    role: 'Service Engineer', status: 'active',
  });
  console.log('Staff created:', staff1.staffId, staff2.staffId);

  /* ── 2. Teams ──────────────────────────────────────────────────────────── */
  const team1 = await createTeam({
    tenantId, name: 'Rapid Response Team', description: 'Fast-turnaround service calls', status: 'active',
  });
  const team2 = await createTeam({
    tenantId, name: 'Enterprise Accounts Team', description: 'Dedicated to large enterprise clients', status: 'active',
  });
  console.log('Teams created:', team1.teamId, team2.teamId);

  /* ── 3. Customers ──────────────────────────────────────────────────────── */
  const cust1 = await createCustomer({
    tenantId, name: 'Nexon Manufacturing Pvt Ltd',
    email: `contact.nexon.${ts}@nexonmfg-demo.in`, phone: '9876511001',
    company: 'Nexon Manufacturing Pvt Ltd', address: 'Plot 14, Industrial Estate', city: 'Coimbatore', status: 'active',
  });
  const cust2 = await createCustomer({
    tenantId, name: 'Greenfield Hospitality Group',
    email: `ops.greenfield.${ts}@greenfieldhg-demo.in`, phone: '9876511002',
    company: 'Greenfield Hospitality Group', address: '22 MG Road', city: 'Bengaluru', status: 'active',
  });
  console.log('Customers created:', cust1.customerId, cust2.customerId);

  /* ── 4. Sites ──────────────────────────────────────────────────────────── */
  const site1 = await createSite({
    tenantId, name: 'Nexon Coimbatore Plant', address: 'Plot 14, Industrial Estate',
    city: 'Coimbatore', customerId: cust1._id, contactPerson: 'Ravi Kumar', phone: '9876511001',
  });
  const site2 = await createSite({
    tenantId, name: 'Greenfield MG Road Property', address: '22 MG Road',
    city: 'Bengaluru', customerId: cust2._id, contactPerson: 'Anjali Rao', phone: '9876511002',
  });
  console.log('Sites created:', site1.siteId, site2.siteId);

  /* ── 5. Leads ──────────────────────────────────────────────────────────── */
  const lead1 = await createLead({
    tenantId, firstName: 'Vikram', lastName: 'Malhotra', company: 'Malhotra Textiles',
    email: `vikram.malhotra.${ts}@malhotratex-demo.in`, phone: '9876522001',
    source: 'referral', status: 'new', priority: 'high', expectedRevenue: 320000,
  });
  const lead2 = await createLead({
    tenantId, firstName: 'Anita', lastName: 'Desai', company: 'Desai Retail Chain',
    email: `anita.desai.${ts}@desairetail-demo.in`, phone: '9876522002',
    source: 'website', status: 'new', priority: 'medium', expectedRevenue: 180000,
  });
  console.log('Leads created:', lead1.leadId, lead2.leadId);

  /* ── 6. Deals ──────────────────────────────────────────────────────────── */
  const deal1 = await createDeal(tenantId, {
    title: 'Nexon Manufacturing — Annual HVAC Contract', amount: 450000, currency: 'INR', stage: 'negotiation',
    contactName: 'Ravi Kumar', companyName: 'Nexon Manufacturing Pvt Ltd', assignedStaffId: staff1.staffId,
  } as any);
  const deal2 = await createDeal(tenantId, {
    title: 'Greenfield Hospitality — Fire Safety Audit', amount: 275000, currency: 'INR', stage: 'proposal',
    contactName: 'Anjali Rao', companyName: 'Greenfield Hospitality Group', assignedStaffId: staff2.staffId,
  } as any);
  console.log('Deals created:', deal1.title, deal2.title);

  /* ── 7. Message templates (required by any send_email/send_sms rule) ───── */
  const emailTemplate = await Template.create({
    tenantId, name: 'Demo — Status update email', type: 'email', category: 'followup',
    subject: 'Update on your {{title}}', isActive: true,
    body: 'Hi {{name}},<br><br>Just letting you know your {{title}} has been updated to "{{status}}".<br><br>Thanks,<br>{{company}}',
  });
  const smsTemplate = await Template.create({
    tenantId, name: 'Demo — Deal won SMS', type: 'sms', category: 'followup', isActive: true,
    body: 'Heads up: "{{title}}" just moved to {{status}}. Check your dashboard for details.',
  });
  console.log('Templates created:', emailTemplate.name, smsTemplate.name);

  /* ── 8. Give the "sample test" Custom Module a real pipeline ────────────── */
  const sampleTest = await CustomModuleDef.findOne({ tenantId, slug: 'sample-test' }).lean();
  if (!sampleTest) throw new Error('Expected the "sample test" custom module to already exist');
  const existingFields = (sampleTest as any).fields;
  const withStatusField = [
    ...existingFields,
    { key: 'work_status', label: 'Work Status', fieldType: 'select', required: false, options: ['open', 'in_progress', 'completed'], order: existingFields.length },
  ];
  await updateCustomModule(tenantId, String((sampleTest as any)._id), {
    fields: withStatusField, pipelineFieldKey: 'work_status',
  } as any);
  await updateStages(tenantId, `custom:sample-test` as any, [
    { key: 'open', label: 'Open', color: '#0ea5e9', order: 0, isTerminal: false, outcome: null, isActive: true },
    { key: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 1, isTerminal: false, outcome: null, isActive: true },
    { key: 'completed', label: 'Completed', color: '#10b981', order: 2, isTerminal: true, outcome: null, isActive: true },
  ] as any);
  console.log('"sample test" module: added work_status field + Open/In Progress/Completed pipeline');

  // A couple of realistic sample-test records, linked to real customers/staff
  const wo1 = await createCustomRecord(tenantId, 'sample-test', {
    customers: cust1.customerId, staffs: staff2.staffId, teams: team1.teamId, work_status: 'in_progress',
  }, 'demo-seed');
  const wo2 = await createCustomRecord(tenantId, 'sample-test', {
    customers: cust2.customerId, staffs: staff2.staffId, teams: team2.teamId, work_status: 'open',
  }, 'demo-seed');
  console.log('Sample work-order records created:', wo1.recordId, wo2.recordId);

  /* ── 9. Six automation rules, each a different approach ─────────────────── */

  // (1) Built-in, status_changed, send_email, record_contact
  const rule1 = await createRule(tenantId, {
    module: 'lead', name: 'Notify contact when lead is qualified', enabled: true,
    triggerType: 'status_changed', triggerStage: 'qualified',
    actionType: 'send_email', templateId: emailTemplate._id.toString(), recipientStrategy: 'record_contact',
  } as any);

  // (2) Built-in, record_created, create_linked_record (Lead -> Task)
  const rule2 = await createRule(tenantId, {
    module: 'lead', name: 'New lead -> auto-create follow-up task', enabled: true,
    triggerType: 'record_created', actionType: 'create_linked_record', targetModule: 'task',
    fieldMappings: [
      { targetField: 'title', sourceType: 'static', staticValue: 'Follow up with new lead' },
      { targetField: 'priority', sourceType: 'static', staticValue: 'high' },
      { targetField: 'notes', sourceType: 'field', sourceField: 'company' },
    ],
  } as any);

  // (3) Built-in, status_changed, send_sms, assigned_user
  const rule3 = await createRule(tenantId, {
    module: 'deal', name: 'SMS assigned staff when deal is won', enabled: true,
    triggerType: 'status_changed', triggerStage: 'closed_won',
    actionType: 'send_sms', templateId: smsTemplate._id.toString(), recipientStrategy: 'assigned_user',
  } as any);

  // (4) Built-in, status_changed, create_linked_record (Deal -> Task)
  const rule4 = await createRule(tenantId, {
    module: 'deal', name: 'Deal won -> auto-create onboarding task', enabled: true,
    triggerType: 'status_changed', triggerStage: 'closed_won',
    actionType: 'create_linked_record', targetModule: 'task',
    fieldMappings: [
      { targetField: 'title', sourceType: 'static', staticValue: 'Kick off customer onboarding' },
      { targetField: 'priority', sourceType: 'static', staticValue: 'high' },
      { targetField: 'notes', sourceType: 'field', sourceField: 'companyName' },
    ],
  } as any);

  // (5) Custom Module, record_created, send_email, record_contact (resolves via its own 'customers' relationship field)
  const rule5 = await createRule(tenantId, {
    module: 'custom:sample-test', name: 'Notify customer on new work order', enabled: true,
    triggerType: 'record_created',
    actionType: 'send_email', templateId: emailTemplate._id.toString(), recipientStrategy: 'record_contact',
  } as any);

  // (6) Custom Module, status_changed, create_linked_record (sample-test -> Invoice), reading the
  // work order's own linked customer straight out of its data blob
  const rule6 = await createRule(tenantId, {
    module: 'custom:sample-test', name: 'Work order completed -> draft an invoice', enabled: true,
    triggerType: 'status_changed', triggerStage: 'completed',
    actionType: 'create_linked_record', targetModule: 'invoice',
    fieldMappings: [
      { targetField: 'customerId', sourceType: 'field', sourceField: 'data.customers' },
      { targetField: 'status', sourceType: 'static', staticValue: 'draft' },
      { targetField: 'notes', sourceType: 'static', staticValue: 'Auto-generated from a completed work order' },
    ],
  } as any);

  console.log('\nAutomation rules created:');
  [rule1, rule2, rule3, rule4, rule5, rule6].forEach((r: any) =>
    console.log(`- ${r.name} | ${r.module} | ${r.triggerType}${r.triggerStage ? `/${r.triggerStage}` : ''} -> ${r.actionType}${r.targetModule ? ` (${r.targetModule})` : ''}`));

  console.log('\nDone. Nothing further to clean up — this is persistent demo data.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
