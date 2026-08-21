import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

// One-off seed for the Innooryze test tenant — creates 2 Categories, converts
// 3 existing sparse Leads to Customers (via the real convertLeadToCustomer()
// service, reusing existing Lead data rather than inventing new records),
// and 7 real Tickets via the real createTicket() service so ticketNumber/SLA
// due-dates all compute correctly. Two tickets are backdated afterward to
// demonstrate a real Warning and a real Breached SLA state. Already run once
// (2026-08-18) — kept as a record of what was seeded, matching this
// directory's own convention (seed-demo-configuration.ts,
// seed-site-visit-reports-demo.ts). Re-running is NOT idempotent — it will
// create a second set of tickets and attempt to re-convert the same 3 leads
// (which will throw "Lead has already been converted to a Customer").

async function main() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log('connected');

  const { createCategory } = await import('../src/modules/native-crm/categories/category.service');
  const { convertLeadToCustomer } = await import('../src/modules/native-crm/leads/lead-conversion.service');
  const { createTicket } = await import('../src/modules/native-crm/tickets/ticket.service');
  const { Ticket } = await import('../src/modules/native-crm/tickets/ticket.model');
  const { Lead } = await import('../src/modules/native-crm/leads/lead.model');

  const tenantId = '6a3b5e83ad6fe7498e8823e9';
  const tid = new mongoose.Types.ObjectId(tenantId);
  const performedBy = 'seed-script';

  const STAFF_ID = 'BADE2FF4-ST-0001';
  const TEAM_ID = '6a5883f2bdd9651a5c4759d4';

  // ── 1. Categories ──
  const catTech = await createCategory({ tenantId: tid, name: 'Technical Issue', color: '#ef4444' });
  const catBilling = await createCategory({ tenantId: tid, name: 'Billing Question', color: '#f59e0b' });
  console.log('created categories:', catTech.name, catBilling.name);

  // ── 2. Patch 3 sparse leads with a bit more realistic data, then convert
  //     each to a real Customer via the existing conversion service ──
  const leadPatches: Array<{ id: string; lastName: string; company: string }> = [
    { id: '6a703c9efe8181c5262cdcdf', lastName: 'Kumar', company: 'Innooryze Test Co' },
    { id: '6a717ae456b747806fe1c1c5', lastName: 'Raghavan', company: 'Bright Path Traders' },
    { id: '6a719cbbfb0cc653f66081e1', lastName: 'Pillai', company: 'Skyline Freight Co' },
  ];
  const customers: any[] = [];
  for (const p of leadPatches) {
    await Lead.updateOne({ _id: p.id, tenantId: tid }, { $set: { lastName: p.lastName, company: p.company } });
    const { customer } = await convertLeadToCustomer(tid, p.id, performedBy);
    customers.push(customer);
    console.log('converted lead -> customer:', customer.name, customer._id.toString());
  }
  const [cust1, cust2, cust3] = customers;

  // ── 3. Seven real tickets, spanning every filterable dimension ──
  const created: any[] = [];
  const mk = async (dto: any) => { const t = await createTicket(tenantId, dto); created.push(t); return t; };

  await mk({
    subject: 'Login page throwing 500 error', priority: 'high', source: 'web',
    categoryId: String(catTech._id), staffId: STAFF_ID, teamId: TEAM_ID, tags: ['urgent'],
    ticketStatus: 'in_progress', description: 'Customer reports a 500 error on every login attempt since this morning.',
    relatedModule: 'customer', relatedId: String(cust1._id), relatedLabel: cust1.name,
  });

  await mk({
    subject: 'Unable to reset password', priority: 'medium', source: 'ai_chatbot',
    categoryId: String(catTech._id), ticketStatus: 'open',
    description: 'Password reset email never arrives.',
    relatedModule: 'customer', relatedId: String(cust2._id), relatedLabel: cust2.name,
  });

  await mk({
    subject: 'Invoice amount incorrect', priority: 'medium', source: 'manual',
    categoryId: String(catBilling._id), staffId: STAFF_ID, tags: ['billing'],
    ticketStatus: 'open', description: 'Latest invoice shows a higher amount than the quoted plan.',
    relatedModule: 'customer', relatedId: String(cust3._id), relatedLabel: cust3.name,
  });

  await mk({
    subject: 'Refund request for duplicate charge', priority: 'high', source: 'manual',
    categoryId: String(catBilling._id), teamId: TEAM_ID,
    ticketStatus: 'resolved', description: 'Customer was charged twice for the same order.',
    relatedModule: 'customer', relatedId: String(cust1._id), relatedLabel: cust1.name,
  });

  await mk({
    subject: 'Feature request: dark mode', priority: 'low', source: 'web',
    tags: ['feature-request'], ticketStatus: 'open',
    description: 'Visitor asked whether a dark theme is planned.',
  });

  const breachTicket = await mk({
    subject: 'Mobile app crashes on startup', priority: 'critical', source: 'ai_chatbot',
    categoryId: String(catTech._id), staffId: STAFF_ID, teamId: TEAM_ID, tags: ['urgent', 'vip'],
    ticketStatus: 'open', description: 'App crashes immediately on launch for several customers today.',
  });

  const warnTicket = await mk({
    subject: 'Slow page load on dashboard', priority: 'medium', source: 'manual',
    categoryId: String(catTech._id), staffId: STAFF_ID, tags: ['performance'],
    ticketStatus: 'in_progress', description: 'Dashboard takes 8-10 seconds to load for one customer.',
  });

  // Backdate SLA timestamps on 2 tickets so the new Warning/Breached states
  // are immediately visible in the UI, not just a theoretical filter option.
  const now = new Date();
  await Ticket.updateOne({ _id: breachTicket._id }, { $set: { resolutionDueAt: new Date(now.getTime() - 3_600_000) } });
  await Ticket.updateOne({ _id: warnTicket._id }, { $set: {
    resolutionWarningAt: new Date(now.getTime() - 1_800_000),
    resolutionDueAt: new Date(now.getTime() + 3_600_000),
  } });

  console.log(`\ncreated ${created.length} tickets:`);
  for (const t of created) console.log(' -', t.ticketNumber, '|', t.subject, '|', t.priority, '|', t.ticketStatus);

  console.log('\ndone. Backend server (nodemon) will pick this data up automatically — no restart needed.');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => { console.error('SEED FAILED:', err); process.exit(1); });
