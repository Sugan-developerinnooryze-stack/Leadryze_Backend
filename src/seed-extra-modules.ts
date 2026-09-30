/**
 * seed-extra-modules.ts
 * Extends seed-native-crm.ts's Field Service chain with the modules it
 * doesn't touch: Companies, Contacts, Calls, Meetings, Tickets, Expenses,
 * Custom Fields (definitions + values on existing Leads/Customers), and one
 * Custom Module (definition + records). Cross-links to the SAME
 * Leads/Customers/Deals/WorkOrders seed-native-crm.ts already created —
 * run that script first.
 *
 * Run:  npx ts-node --transpile-only src/seed-extra-modules.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { config } from './config';

import { Tenant }         from './modules/tenants/tenant.model';
import { Lead }            from './modules/native-crm/leads/lead.model';
import { NativeCustomer }  from './modules/native-crm/customers/customer.model';
import { Deal }             from './modules/native-crm/deals/deal.model';
import { NativeWorkorder } from './modules/native-crm/workorders/workorder.model';
import { Company }          from './modules/native-crm/companies/company.model';
import { Contact }          from './modules/native-crm/contacts/contact.model';
import { Call }              from './modules/native-crm/calls/call.model';
import { Meeting }          from './modules/native-crm/meetings/meeting.model';
import { Ticket }            from './modules/native-crm/tickets/ticket.model';
import { NativeExpense }   from './modules/native-crm/expenses/expense.model';
import { NativeCustomField } from './modules/native-crm/custom-fields/custom-field.model';
import { CustomModuleDef, CustomRecord } from './modules/custom-modules/custom-module.model';

const ok  = (msg: string) => console.log(`  ✔  ${msg}`);
const sec = (msg: string) => console.log(`\n── ${msg} ${'─'.repeat(Math.max(2, 50 - msg.length))}`);

async function seed() {
  console.log('\n🌱  LeadRyze AI — Extra Modules Seed (Companies/Contacts/Calls/Meetings/Tickets/Expenses/Custom Fields/Custom Module)\n');
  await mongoose.connect(config.mongodb.uri);
  console.log('  Connected to MongoDB:', config.mongodb.uri.split('@').pop());

  const targetSlug = process.env.TENANT_SLUG;
  let tenant: any;
  if (targetSlug) {
    tenant = await Tenant.findOne({ slug: targetSlug });
    if (!tenant) throw new Error(`Tenant with slug "${targetSlug}" not found in DB`);
  } else {
    tenant = await Tenant.findOne({ isActive: true, slug: { $nin: ['leadryze-demo', 'acme-corp', 'leadryze-system'] } }).sort({ createdAt: 1 });
    if (!tenant) tenant = await Tenant.findOne({ slug: 'leadryze-demo' });
    if (!tenant) throw new Error('No active tenant found. Run the main seed first: npm run seed');
  }
  const tenantId = tenant._id;
  ok(`Seeding tenant: "${tenant.name}" (slug: ${tenant.slug})`);

  const customers = await NativeCustomer.find({ tenantId }).sort({ numId: 1 }).lean();
  const leads     = await Lead.find({ tenantId }).sort({ numId: 1 }).lean();
  const deals     = await Deal.find({ tenantId }).sort({ createdAt: 1 }).lean();
  const workorders = await NativeWorkorder.find({ tenantId }).sort({ numId: 1 }).lean();
  if (customers.length === 0 || leads.length === 0) {
    throw new Error('No Leads/Customers found for this tenant — run "npm run seed:crm" first.');
  }
  ok(`Found ${leads.length} leads, ${customers.length} customers, ${deals.length} deals, ${workorders.length} work orders to link against`);

  // ── Wipe this tenant's prior extra-module data (idempotent re-run) ──────
  await Promise.all([
    Company.deleteMany({ tenantId }),
    Contact.deleteMany({ tenantId }),
    Call.deleteMany({ tenantId }),
    Meeting.deleteMany({ tenantId }),
    Ticket.deleteMany({ tenantId }),
    NativeExpense.deleteMany({ tenantId }),
    NativeCustomField.deleteMany({ tenantId }),
    CustomModuleDef.deleteMany({ tenantId, slug: 'equipment' }),
    CustomRecord.deleteMany({ tenantId, moduleSlug: 'equipment' }),
  ]);

  const leadById = new Map(leads.map((l) => [String(l._id), l]));

  // ── 1. Companies — one per seeded Customer, same business identity ──────
  sec('Companies');
  const companies: any[] = [];
  for (const cust of customers) {
    const industryGuess = (cust as any).notes?.match(/\b(HVAC|Electrical|Plumbing|IT|Security|Pharma|Hospitality|Construction)\b/i)?.[0] ?? 'Services';
    const doc = new Company({
      tenantId,
      name: cust.company || cust.name,
      domain: cust.website?.replace(/^https?:\/\//, '') ?? undefined,
      industry: industryGuess,
      employeeCount: [10, 25, 50, 100, 250, 500][Math.floor(Math.random() * 6)],
      phone: cust.phone,
      website: cust.website,
      city: cust.city,
      country: cust.country || 'India',
      companyStatus: 'active',
      notes: `Primary account for ${cust.company || cust.name}.`,
      tags: cust.tags ?? [],
      createdBy: 'seed-script',
    });
    await doc.save();
    companies.push(doc);
    ok(`Company: ${doc.name} (${doc.city ?? 'n/a'})`);
  }

  // ── 2. Contacts — one per Customer, linked back to its originating Lead ─
  sec('Contacts');
  const contacts: any[] = [];
  for (const cust of customers) {
    const lead = (cust as any).leadId ? leadById.get(String((cust as any).leadId)) : undefined;
    const doc = new Contact({
      tenantId,
      firstName: lead?.firstName ?? cust.name.split(' ')[0] ?? cust.name,
      lastName:  lead?.lastName ?? cust.name.split(' ').slice(1).join(' ') ?? 'Contact',
      email: cust.email ?? `contact@${(cust.website ?? 'example.com').replace(/^https?:\/\//, '')}`,
      phone: cust.phone,
      company: cust.company,
      jobTitle: (lead as any)?.designation ?? 'Primary Contact',
      lifecycleStage: 'customer',
      leadStatus: 'connected',
      status: 'customer',
      source: (lead as any)?.source ?? 'other',
      notes: `Primary point of contact for ${cust.company || cust.name}.`,
      tags: cust.tags ?? [],
      createdBy: 'seed-script',
      leadId: (cust as any).leadId ?? undefined,
    });
    await doc.save();
    contacts.push(doc);
    ok(`Contact: ${doc.firstName} ${doc.lastName} — ${doc.company}`);
  }

  // ── 3. Calls — linked to Customers ───────────────────────────────────────
  sec('Calls');
  const callOutcomes = ['completed', 'completed', 'missed', 'completed', 'planned', 'completed', 'cancelled', 'completed'] as const;
  for (let i = 0; i < customers.length; i++) {
    const cust = customers[i];
    const doc = new Call({
      tenantId,
      contactName: cust.name,
      direction: i % 3 === 0 ? 'inbound' : 'outbound',
      duration: callOutcomes[i] === 'completed' ? 180 + i * 45 : 0,
      callStatus: callOutcomes[i],
      date: new Date(Date.now() - (customers.length - i) * 2 * 24 * 60 * 60 * 1000),
      notes: `Follow-up call with ${cust.name} regarding ${cust.company ?? 'their account'}.`,
      tags: ['follow-up'],
      createdBy: 'seed-script',
      relatedModule: 'customer',
      relatedId: String(cust._id),
      relatedLabel: cust.name,
    });
    await doc.save();
    ok(`Call: ${cust.name} [${doc.callStatus}]`);
  }

  // ── 4. Meetings — linked to Deals ────────────────────────────────────────
  sec('Meetings');
  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    const start = new Date(Date.now() + (i - 2) * 3 * 24 * 60 * 60 * 1000);
    const end   = new Date(start.getTime() + 60 * 60 * 1000);
    const status = start < new Date() ? 'completed' : 'scheduled';
    const doc = new Meeting({
      tenantId,
      title: `${deal.title} — Review Meeting`,
      startDate: start,
      endDate: end,
      location: 'Google Meet',
      attendees: [deal.contactName].filter(Boolean),
      meetingStatus: status,
      notes: `Discuss progress on "${deal.title}" (₹${deal.amount?.toLocaleString('en-IN')}).`,
      tags: ['deal-review'],
      createdBy: 'seed-script',
      relatedModule: 'deal',
      relatedId: String(deal._id),
      relatedLabel: deal.title,
      source: 'manual',
    });
    await doc.save();
    ok(`Meeting: ${doc.title} [${status}]`);
  }

  // ── 5. Tickets — linked to Customers/WorkOrders ──────────────────────────
  sec('Tickets');
  const ticketDefs = [
    { subj: 'AC unit not cooling after service',        priority: 'high',     status: 'open' },
    { subj: 'Invoice discrepancy — GST amount mismatch', priority: 'medium',   status: 'in_progress' },
    { subj: 'Request reschedule of next visit',          priority: 'low',      status: 'open' },
    { subj: 'CCTV camera 3 offline since yesterday',     priority: 'critical', status: 'in_progress' },
    { subj: 'AMC renewal query',                         priority: 'low',      status: 'resolved' },
    { subj: 'Technician arrived late — feedback',        priority: 'medium',   status: 'closed' },
  ];
  for (let i = 0; i < ticketDefs.length; i++) {
    const cust = customers[i % customers.length];
    const wo   = workorders[i % Math.max(workorders.length, 1)];
    const def = ticketDefs[i];
    const doc = new Ticket({
      tenantId,
      subject: def.subj,
      priority: def.priority,
      ticketStatus: def.status,
      description: `${def.subj} — raised by ${cust.name} (${cust.company ?? 'n/a'}).`,
      contactName: cust.name,
      tags: ['support'],
      createdBy: 'seed-script',
      relatedModule: wo ? 'workorder' : 'customer',
      relatedId: wo ? String(wo._id) : String(cust._id),
      relatedLabel: wo ? wo.workOrderId : cust.name,
    });
    await doc.save();
    ok(`Ticket: ${doc.subject} [${doc.ticketStatus}/${doc.priority}]`);
  }

  // ── 6. Expenses — tied to WorkOrder human codes ──────────────────────────
  sec('Expenses');
  const expenseDefs = [
    { title: 'Replacement AC compressor part',   category: 'Parts',    amount: 8500,  status: 'approved' },
    { title: 'Technician travel — Chennai site',  category: 'Travel',   amount: 1200,  status: 'approved' },
    { title: 'Copper piping (25m)',               category: 'Parts',    amount: 3400,  status: 'pending' },
    { title: 'Rental — scaffolding for CCTV job', category: 'Equipment',amount: 5000,  status: 'approved' },
    { title: 'Emergency callout — after hours',   category: 'Labor',    amount: 2000,  status: 'pending' },
    { title: 'Fire safety inspection tools',      category: 'Tools',    amount: 6700,  status: 'rejected' },
  ];
  for (let i = 0; i < expenseDefs.length; i++) {
    const wo = workorders[i % Math.max(workorders.length, 1)];
    const def = expenseDefs[i];
    const doc = new NativeExpense({
      tenantId,
      title: def.title,
      category: def.category,
      amount: def.amount,
      date: new Date(Date.now() - i * 3 * 24 * 60 * 60 * 1000),
      paidBy: 'Company Card',
      workOrderId: wo?.workOrderId,
      notes: wo ? `Related to work order ${wo.workOrderId}.` : undefined,
      status: def.status,
      createdBy: 'seed-script',
    });
    await doc.save();
    ok(`Expense: ${doc.expenseId} — ${doc.title} ₹${doc.amount} [${doc.status}]`);
  }

  // ── 7. Custom Fields — definitions on leads + customers, then backfill ──
  sec('Custom Fields');
  const customFieldDefs = [
    { module: 'leads', fieldKey: 'preferred_language', label: 'Preferred Language', fieldType: 'dropdown', options: ['English', 'Tamil', 'Hindi', 'Telugu'], order: 0 },
    { module: 'leads', fieldKey: 'referral_partner',   label: 'Referral Partner',   fieldType: 'text',     order: 1 },
    { module: 'customers', fieldKey: 'vip_tier',              label: 'VIP Tier',              fieldType: 'dropdown', options: ['Standard', 'Gold', 'Platinum'], order: 0 },
    { module: 'customers', fieldKey: 'annual_contract_value', label: 'Annual Contract Value', fieldType: 'currency', order: 1 },
  ];
  for (const def of customFieldDefs) {
    const doc = await NativeCustomField.create({ tenantId, ...def, required: false, isActive: true, createdBy: 'seed-script' });
    ok(`Custom Field: [${def.module}] ${def.label} (${def.fieldType})`);
  }

  const languages = ['English', 'Tamil', 'Hindi', 'Telugu'];
  const tiers      = ['Standard', 'Gold', 'Platinum'];
  for (let i = 0; i < leads.length; i++) {
    await Lead.updateOne({ _id: leads[i]._id }, { $set: {
      customFields: { preferred_language: languages[i % languages.length], referral_partner: i % 2 === 0 ? 'Direct' : 'Partner Network' },
    } });
  }
  for (let i = 0; i < customers.length; i++) {
    await NativeCustomer.updateOne({ _id: customers[i]._id }, { $set: {
      customFields: { vip_tier: tiers[i % tiers.length], annual_contract_value: 50000 + i * 25000 },
    } });
  }
  ok(`Backfilled customFields on ${leads.length} leads + ${customers.length} customers`);

  // ── 8. Custom Module — "Equipment" definition + records ──────────────────
  sec('Custom Module — Equipment');
  const moduleDef = await CustomModuleDef.create({
    tenantId,
    slug: 'equipment',
    name: 'Equipment',
    singularName: 'Equipment Item',
    icon: '🛠️',
    color: '#0891b2',
    showInSidebar: true,
    menuOrder: 100,
    fields: [
      { key: 'name',            label: 'Equipment Name', fieldType: 'text',     required: true,  order: 0 },
      { key: 'serialNumber',    label: 'Serial Number',  fieldType: 'text',     required: false, order: 1 },
      { key: 'customerId',      label: 'Customer',       fieldType: 'text',     required: false, order: 2 },
      { key: 'installedAt',     label: 'Installed On',   fieldType: 'date',     required: false, order: 3 },
      { key: 'warrantyExpiry',  label: 'Warranty Expiry',fieldType: 'date',     required: false, order: 4 },
      { key: 'status', label: 'Status', fieldType: 'select', required: false, order: 5,
        options: ['Active', 'Under Repair', 'Retired'] },
      { key: 'notes',           label: 'Notes',          fieldType: 'textarea', required: false, order: 6 },
    ],
    pipelineFieldKey: 'status',
  });
  ok(`Custom Module defined: ${moduleDef.name} (slug: ${moduleDef.slug}, ${moduleDef.fields.length} fields)`);

  const equipmentNames = ['Split AC Unit — 2 Ton', 'Electrical Panel Board', 'Industrial Water Pump', 'Server Rack Cooling Unit', 'CCTV NVR System', 'Clean Room HEPA Filter Unit', 'Booster Pump Set', 'Fire Alarm Control Panel'];
  for (let i = 0; i < Math.min(customers.length, equipmentNames.length); i++) {
    const cust = customers[i];
    const installed = new Date(Date.now() - (365 + i * 40) * 24 * 60 * 60 * 1000);
    const warranty  = new Date(installed.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);
    const doc = new CustomRecord({
      tenantId,
      moduleSlug: 'equipment',
      data: {
        name: equipmentNames[i],
        serialNumber: `SN-${2024000 + i * 17}`,
        customerId: cust.customerId,
        installedAt: installed,
        warrantyExpiry: warranty,
        status: warranty > new Date() ? (i % 5 === 0 ? 'Under Repair' : 'Active') : 'Retired',
        notes: `Installed at ${cust.company ?? cust.name}.`,
      },
      createdBy: 'seed-script',
    });
    await doc.save();
    ok(`Equipment record: ${equipmentNames[i]} → ${cust.customerId}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  sec('Summary');
  const counts = {
    Companies: await Company.countDocuments({ tenantId }),
    Contacts:  await Contact.countDocuments({ tenantId }),
    Calls:     await Call.countDocuments({ tenantId }),
    Meetings:  await Meeting.countDocuments({ tenantId }),
    Tickets:   await Ticket.countDocuments({ tenantId }),
    Expenses:  await NativeExpense.countDocuments({ tenantId }),
    'Custom Fields': await NativeCustomField.countDocuments({ tenantId }),
    'Equipment records': await CustomRecord.countDocuments({ tenantId, moduleSlug: 'equipment' }),
  };
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);

  console.log('\n✅  Extra modules seed complete!\n');
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('\n❌  Seed failed:', err);
  process.exit(1);
});
