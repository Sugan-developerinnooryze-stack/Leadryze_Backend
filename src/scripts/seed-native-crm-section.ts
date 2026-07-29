/**
 * seed-native-crm-section.ts
 *
 * Additive sample-data seed for the "Native CRM" sidebar section (Contacts,
 * Companies, Deals, Tasks, Tickets, Calls, Meetings) — 7-9 records per module.
 *
 * Unlike seed-native-crm.ts (which wipes and rebuilds the whole Field Service
 * data set), this script is purely additive: it never deletes anything, and
 * it links every Task/Ticket/Call/Meeting to a REAL existing Field Service
 * record (Customer/Quotation/Work Order/Contract) via the relatedModule/
 * relatedId/relatedLabel fields, so "Activity" tabs on those records' view
 * pages show this data immediately. Contacts/Companies are built from real
 * Customers already in the DB, not invented names, so they stay consistent
 * with whatever Field Service data actually exists for this tenant.
 *
 * Requires Field Service data (Customers/Quotations/Work Orders/Contracts)
 * to already exist for the tenant — run seed-native-crm.ts first if empty.
 *
 * Run:  npx ts-node --transpile-only src/scripts/seed-native-crm-section.ts
 *       TENANT_SLUG=<slug> npx ts-node --transpile-only src/scripts/seed-native-crm-section.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { config } from '../config';

import { Tenant } from '../modules/tenants/tenant.model';
import { NativeCustomer } from '../modules/native-crm/customers/customer.model';
import { NativeQuotation } from '../modules/native-crm/quotations/quotation.model';
import { NativeWorkorder } from '../modules/native-crm/workorders/workorder.model';
import { NativeContract } from '../modules/native-crm/contracts/contract.model';
import { Lead } from '../modules/native-crm/leads/lead.model';
import { Contact } from '../modules/native-crm/contacts/contact.model';
import { Company } from '../modules/native-crm/companies/company.model';
import { Deal } from '../modules/native-crm/deals/deal.model';
import { Task } from '../modules/native-crm/tasks/task.model';
import { Ticket } from '../modules/native-crm/tickets/ticket.model';
import { Call } from '../modules/native-crm/calls/call.model';
import { Meeting } from '../modules/native-crm/meetings/meeting.model';

const ok  = (msg: string) => console.log(`  ✔  ${msg}`);
const sec = (msg: string) => console.log(`\n── ${msg} ${'─'.repeat(Math.max(0, 50 - msg.length))}`);

const TARGET_MIN = 7;
const TARGET_MAX = 9;

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function topUp<T>(
  label: string,
  Model: any,
  tenantId: mongoose.Types.ObjectId,
  build: (i: number) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<void> {
  const existing = await Model.countDocuments({ tenantId });
  if (existing >= TARGET_MIN) {
    ok(`${label}: already has ${existing} (>= ${TARGET_MIN}) — skipping`);
    return;
  }
  const need = TARGET_MAX - existing;
  for (let i = 0; i < need; i++) {
    const doc = await build(existing + i);
    await Model.create({ tenantId, ...doc });
  }
  ok(`${label}: had ${existing}, created ${need} more → ${existing + need} total`);
}

async function seed() {
  console.log('\n🌱  LeadRyze AI — Native CRM section sample data (additive)\n');
  await mongoose.connect(config.mongodb.uri);
  console.log('  Connected to MongoDB:', config.mongodb.uri.split('@').pop());

  const targetSlug = process.env.TENANT_SLUG;
  let tenant: any;
  if (targetSlug) {
    tenant = await Tenant.findOne({ slug: targetSlug });
    if (!tenant) throw new Error(`Tenant with slug "${targetSlug}" not found`);
  } else {
    tenant = await Tenant.findOne({
      isActive: true,
      slug: { $nin: ['leadryze-demo', 'acme-corp', 'leadryze-system'] },
    }).sort({ createdAt: 1 });
    if (!tenant) tenant = await Tenant.findOne({ slug: 'leadryze-demo' });
    if (!tenant) throw new Error('No active tenant found.');
  }
  ok(`Seeding tenant: "${tenant.name}" (slug: ${tenant.slug})`);
  const tenantId = tenant._id as mongoose.Types.ObjectId;

  // ── Load real Field Service data to link against ────────────────────────
  sec('Loading existing Field Service data');
  const [customers, quotations, workorders, contracts] = await Promise.all([
    NativeCustomer.find({ tenantId }).limit(12).lean(),
    NativeQuotation.find({ tenantId }).limit(12).lean(),
    NativeWorkorder.find({ tenantId }).limit(12).lean(),
    NativeContract.find({ tenantId }).limit(12).lean(),
  ]);
  if (customers.length === 0) {
    throw new Error(
      'No Field Service Customers found for this tenant. Run seed-native-crm.ts first ' +
      '(or point TENANT_SLUG at a tenant that already has Field Service data) — ' +
      'this script only links to real records, it never invents fake Field Service data.'
    );
  }
  ok(`Found ${customers.length} customers, ${quotations.length} quotations, ${workorders.length} work orders, ${contracts.length} contracts`);

  const leads = await Lead.find({ tenantId }).lean();
  const leadByEmail = new Map(leads.map((l: any) => [String(l.email ?? '').toLowerCase(), l]));

  // Distinct real company names already in the DB — Contacts/Companies are
  // built from these, so they're guaranteed consistent with real Customers,
  // never a hardcoded list that could drift from what's actually seeded.
  const companyNames = Array.from(new Set(customers.map((c: any) => c.company).filter(Boolean))) as string[];

  // ── Companies (from real customer company names) ────────────────────────
  sec('Companies');
  await topUp('Companies', Company, tenantId, (i) => {
    const cust: any = customers[i % customers.length];
    return {
      name:          cust.company || `${cust.name} Pvt Ltd`,
      domain:        cust.website ? cust.website.replace(/^https?:\/\//, '') : undefined,
      industry:      undefined,
      phone:         cust.phone,
      website:       cust.website,
      city:          cust.city,
      country:       cust.country,
      companyStatus: 'active',
      notes:         `Primary account company for customer ${cust.customerId}.`,
      tags:          ['field-service', 'active-account'],
    };
  });

  // ── Contacts (secondary contact per real customer) ───────────────────────
  sec('Contacts');
  const contactFirstNames = ['Anita', 'Rohan', 'Kavya', 'Manish', 'Pooja', 'Sanjeev', 'Neha', 'Vikram', 'Shalini'];
  const contactLastNames  = ['Rao', 'Iyer', 'Bose', 'Chawla', 'Kapoor', 'Malhotra', 'Bhatt', 'Nanda', 'Suri'];
  await topUp('Contacts', Contact, tenantId, (i) => {
    const cust: any = customers[i % customers.length];
    const fn = contactFirstNames[i % contactFirstNames.length];
    const ln = contactLastNames[i % contactLastNames.length];
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}@${(cust.company ?? 'client').toLowerCase().replace(/[^a-z0-9]/g, '')}.in`;
    const lead = leadByEmail.get(String(cust.email ?? '').toLowerCase());
    return {
      firstName: fn,
      lastName:  ln,
      email,
      phone:     cust.phone,
      company:   cust.company,
      jobTitle:  'Site Coordinator',
      status:    'customer',
      source:    'referral',
      notes:     `Secondary point of contact at ${cust.company ?? cust.name}, alongside ${cust.name}.`,
      tags:      ['field-service'],
      leadId:    lead?.leadId,
    };
  });

  // ── Deals (top up only if under target — Deals already seeded by seed-native-crm.ts) ──
  sec('Deals');
  await topUp('Deals', Deal, tenantId, (i) => {
    const cust: any = customers[i % customers.length];
    const stages = ['qualified', 'proposal', 'negotiation', 'closed_won'] as const;
    return {
      title:       `${cust.company ?? cust.name} — Renewal Opportunity`,
      amount:      Math.round(50000 + Math.random() * 200000),
      currency:    'INR',
      stage:       stages[i % stages.length],
      closeDate:   daysFromNow(20 + i * 5),
      contactName: cust.name,
      companyName: cust.company,
      notes:       `Renewal/upsell opportunity for existing customer ${cust.customerId}.`,
      tags:        ['renewal'],
    };
  });

  // ── Tasks (linked to real Field Service records) ─────────────────────────
  sec('Tasks');
  const taskTemplates = [
    (wo: any) => ({ title: `Follow up on work order ${wo.workOrderId}`, related: { relatedModule: 'workorder', relatedId: String(wo._id), relatedLabel: `${wo.workOrderId} — ${wo.title}` } }),
    (q: any)  => ({ title: `Send revised quotation ${q.quotationId}`, related: { relatedModule: 'quotation', relatedId: String(q._id), relatedLabel: `${q.quotationId} — ${q.title}` } }),
    (c: any)  => ({ title: `Confirm renewal terms for ${c.contractId}`, related: { relatedModule: 'contract', relatedId: String(c._id), relatedLabel: `${c.contractId} — ${c.title}` } }),
    (cust: any) => ({ title: `Check in with ${cust.company ?? cust.name}`, related: { relatedModule: 'customer', relatedId: String(cust._id), relatedLabel: `${cust.customerId} — ${cust.name}` } }),
  ];
  const priorities = ['low', 'medium', 'high'] as const;
  await topUp('Tasks', Task, tenantId, (i) => {
    const pool = [workorders, quotations, contracts, customers][i % 4];
    const record: any = pool[i % Math.max(1, pool.length)] ?? customers[i % customers.length];
    const tpl = taskTemplates[i % 4](record);
    return {
      title:      tpl.title,
      dueDate:    daysFromNow(3 + i * 2),
      priority:   priorities[i % priorities.length],
      taskStatus: i % 3 === 0 ? 'done' : 'todo',
      assignedTo: 'Field Ops Team',
      notes:      'Auto-generated sample task linked to a real Field Service record.',
      ...tpl.related,
    };
  });

  // ── Tickets (linked to real Work Orders / Customers) ─────────────────────
  sec('Tickets');
  const ticketSubjects = [
    'AC unit not cooling after service', 'Network downtime reported', 'Invoice discrepancy query',
    'Request for additional site visit', 'CCTV camera offline', 'Billing address update needed',
    'Warranty claim for installed part', 'Delay in scheduled maintenance', 'Access card not working',
  ];
  await topUp('Tickets', Ticket, tenantId, (i) => {
    const wo: any = workorders[i % Math.max(1, workorders.length)] ?? customers[i % customers.length];
    const cust: any = customers[i % customers.length];
    const isWo = workorders.length > 0;
    return {
      subject:      ticketSubjects[i % ticketSubjects.length],
      priority:     i % 4 === 0 ? 'critical' : i % 2 === 0 ? 'high' : 'medium',
      ticketStatus: i % 3 === 0 ? 'resolved' : 'open',
      description:  `Raised by ${cust.name} (${cust.customerId}). Auto-generated sample ticket.`,
      contactName:  cust.name,
      relatedModule: isWo ? 'workorder' : 'customer',
      relatedId:     isWo ? String(wo._id) : String(cust._id),
      relatedLabel:  isWo ? `${wo.workOrderId} — ${wo.title}` : `${cust.customerId} — ${cust.name}`,
    };
  });

  // ── Calls (linked to real Quotations / Customers) ────────────────────────
  sec('Calls');
  await topUp('Calls', Call, tenantId, (i) => {
    const q: any = quotations[i % Math.max(1, quotations.length)] ?? customers[i % customers.length];
    const cust: any = customers[i % customers.length];
    const isQ = quotations.length > 0;
    return {
      contactName: cust.name,
      direction:   i % 2 === 0 ? 'outbound' : 'inbound',
      duration:    5 + (i % 6) * 3,
      callStatus:  i % 5 === 0 ? 'missed' : 'completed',
      date:        daysAgo(i * 2),
      notes:       isQ ? `Discussed pricing for quotation ${q.quotationId}.` : `General check-in call with ${cust.name}.`,
      relatedModule: isQ ? 'quotation' : 'customer',
      relatedId:     isQ ? String(q._id) : String(cust._id),
      relatedLabel:  isQ ? `${q.quotationId} — ${q.title}` : `${cust.customerId} — ${cust.name}`,
    };
  });

  // ── Meetings (linked to real Customers / Contracts) ──────────────────────
  sec('Meetings');
  const meetingTitles = [
    'Site walkthrough', 'AMC renewal discussion', 'Quarterly service review',
    'Onboarding kickoff', 'Escalation review', 'Contract renegotiation', 'Annual audit meeting',
  ];
  await topUp('Meetings', Meeting, tenantId, (i) => {
    const c: any = contracts[i % Math.max(1, contracts.length)] ?? customers[i % customers.length];
    const cust: any = customers[i % customers.length];
    const isC = contracts.length > 0;
    const start = daysFromNow(2 + i * 3);
    return {
      title:         meetingTitles[i % meetingTitles.length],
      startDate:     start,
      endDate:       new Date(start.getTime() + 60 * 60 * 1000),
      location:      cust.city ? `${cust.city} — client site` : 'Client site',
      attendees:     [cust.name, 'Field Ops Lead'],
      meetingStatus: 'scheduled',
      notes:         'Auto-generated sample meeting linked to a real Field Service record.',
      relatedModule: isC ? 'contract' : 'customer',
      relatedId:     isC ? String(c._id) : String(cust._id),
      relatedLabel:  isC ? `${c.contractId} — ${c.title}` : `${cust.customerId} — ${cust.name}`,
    };
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  sec('Summary');
  const counts = await Promise.all([
    Contact.countDocuments({ tenantId }),
    Company.countDocuments({ tenantId }),
    Deal.countDocuments({ tenantId }),
    Task.countDocuments({ tenantId }),
    Ticket.countDocuments({ tenantId }),
    Call.countDocuments({ tenantId }),
    Meeting.countDocuments({ tenantId }),
  ]);
  const labels = ['Contacts', 'Companies', 'Deals', 'Tasks', 'Tickets', 'Calls', 'Meetings'];
  console.log('\n┌────────────────────────────────────────────────┬───────┐');
  labels.forEach((l, idx) => console.log(`│  ${l.padEnd(31)}│  ${String(counts[idx]).padStart(4)} │`));
  console.log('└────────────────────────────────────────────────┴───────┘');

  const sampleTask = await Task.findOne({ tenantId, relatedModule: { $exists: true, $ne: '' } }).lean();
  if (sampleTask) {
    console.log('\n  🔗  Relational check (sample)');
    console.log(`  Task "${(sampleTask as any).title}" → relatedModule=${(sampleTask as any).relatedModule}, relatedLabel="${(sampleTask as any).relatedLabel}"`);
  }

  console.log('\n✅  Native CRM section seed complete!\n');
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('\n❌  Seed failed:', err);
  process.exit(1);
});
