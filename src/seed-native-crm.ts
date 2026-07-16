/**
 * seed-native-crm.ts
 * Full Native-CRM + Field-Service seed for LeadRyze AI.
 * Run:  npx ts-node -r tsconfig-paths/register src/seed-native-crm.ts
 *
 * Data chain:
 *   Lead → Customer → Site → WorkOrder → Invoice → Receipt
 *                  → Quotation → Contract
 *   Category → Service
 *   Team     → Staff
 *   Deal (native CRM)
 *   FSSettings
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { config } from './config';

// ── Models ──────────────────────────────────────────────────────────────────
import { Tenant }            from './modules/tenants/tenant.model';
import { Lead }              from './modules/native-crm/leads/lead.model';
import { NativeCustomer }    from './modules/native-crm/customers/customer.model';
import { NativeSite }        from './modules/native-crm/sites/site.model';
import { NativeCategory }    from './modules/native-crm/categories/category.model';
import { NativeService }     from './modules/native-crm/services/service.model';
import { NativeTeam }        from './modules/native-crm/teams/team.model';
import { NativeStaff }       from './modules/native-crm/staffs/staff.model';
import { NativePart }        from './modules/native-crm/parts/part.model';
import { NativeWorkorder }   from './modules/native-crm/workorders/workorder.model';
import { NativeQuotation }   from './modules/native-crm/quotations/quotation.model';
import { NativeContract }    from './modules/native-crm/contracts/contract.model';
import { NativeInvoice }     from './modules/native-crm/invoices/invoice.model';
import { NativeReceipt }     from './modules/native-crm/receipts/receipt.model';
import { NativeTimeline }    from './modules/native-crm/timeline/timeline.model';
import { Deal }              from './modules/native-crm/deals/deal.model';
import { FSSettings }        from './modules/native-crm/fs-settings/fs-settings.model';

// ── Helpers ─────────────────────────────────────────────────────────────────
const ok  = (msg: string) => console.log(`  ✔  ${msg}`);
const sec = (msg: string) => console.log(`\n── ${msg} ${'─'.repeat(50 - msg.length)}`);

function calcAmounts(
  services: Array<{ amount: number; count: number }>,
  discount = 0,
  gstPct   = 18,
) {
  const sub     = services.reduce((s, l) => s + l.amount * l.count, 0);
  const withTax = Math.round((sub - discount) * (1 + gstPct / 100));
  return { servicesAmount: sub, servicesAmountWithTax: withTax };
}

// ── Core business data ───────────────────────────────────────────────────────
// 8 Indian companies — each becomes a Lead → Customer → Site → WO → Invoice
const BUSINESSES = [
  {
    firstName: 'Rajesh',   lastName: 'Kumar',   company: 'Balaji Tech Solutions',
    designation: 'CTO',   email: 'rajesh@balajitechsolutions.in', phone: '+91 9876541001',
    mobile: '+91 9876541001', website: 'https://balajitechsolutions.in',
    address: '12 Anna Salai', city: 'Chennai',   state: 'Tamil Nadu', postalCode: '600002', country: 'India',
    gstNumber: '33AABCB1234C1Z5', industry: 'Technology',
    service: 'HVAC Maintenance', category: 0, tags: ['hvac', 'enterprise'],
    leadSource: 'website', leadRating: 'hot',  revenue: 180000,
    notes: 'Long-term HVAC maintenance contract for server room cooling.',
  },
  {
    firstName: 'Priya',    lastName: 'Sharma',  company: 'Sharma Electronics',
    designation: 'Director', email: 'priya@sharmaelectronics.in', phone: '+91 9876541002',
    mobile: '+91 9876541002', website: 'https://sharmaelectronics.in',
    address: '45 MG Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'India',
    gstNumber: '29AADFS1234D1Z3', industry: 'Electronics Retail',
    service: 'Electrical Panel Inspection', category: 1, tags: ['electrical', 'retail'],
    leadSource: 'referral', leadRating: 'hot', revenue: 95000,
    notes: 'Quarterly electrical safety audit and panel inspection.',
  },
  {
    firstName: 'Amit',     lastName: 'Patel',   company: 'Patel Industries',
    designation: 'CEO',    email: 'amit@patelindustries.in', phone: '+91 9876541003',
    mobile: '+91 9876541003', website: 'https://patelindustries.in',
    address: '78 Ring Road', city: 'Ahmedabad', state: 'Gujarat', postalCode: '380015', country: 'India',
    gstNumber: '24AAACI1234E1Z7', industry: 'Manufacturing',
    service: 'Industrial Plumbing', category: 2, tags: ['plumbing', 'industrial'],
    leadSource: 'google', leadRating: 'warm', revenue: 220000,
    notes: 'Industrial plumbing system installation across factory units.',
  },
  {
    firstName: 'Venkat',   lastName: 'Reddy',   company: 'Reddy IT Solutions',
    designation: 'MD',     email: 'venkat@reddyit.in', phone: '+91 9876541004',
    mobile: '+91 9876541004', website: 'https://reddyit.in',
    address: '23 Hitech City', city: 'Hyderabad', state: 'Telangana', postalCode: '500081', country: 'India',
    gstNumber: '36AADCR1234F1Z1', industry: 'IT Services',
    service: 'IT Infrastructure Support', category: 3, tags: ['it-support', 'infra'],
    leadSource: 'whatsapp', leadRating: 'hot', revenue: 150000,
    notes: 'Annual IT infrastructure support and network monitoring.',
  },
  {
    firstName: 'Sanjay',   lastName: 'Kumar',   company: 'Kumar Security Systems',
    designation: 'Owner',  email: 'sanjay@kumarsecurity.in', phone: '+91 9876541005',
    mobile: '+91 9876541005', website: 'https://kumarsecurity.in',
    address: '67 Connaught Place', city: 'New Delhi', state: 'Delhi', postalCode: '110001', country: 'India',
    gstNumber: '07AAFCK1234G1Z9', industry: 'Security',
    service: 'CCTV Installation & Monitoring', category: 4, tags: ['security', 'cctv'],
    leadSource: 'facebook', leadRating: 'warm', revenue: 125000,
    notes: 'CCTV installation across 3 floors, with 24x7 monitoring.',
  },
  {
    firstName: 'Ritu',     lastName: 'Mehta',   company: 'Mehta Pharma Ltd',
    designation: 'GM',     email: 'ritu@mehtapharma.in', phone: '+91 9876541006',
    mobile: '+91 9876541006', website: 'https://mehtapharma.in',
    address: '34 MIDC Phase 2', city: 'Pune', state: 'Maharashtra', postalCode: '411019', country: 'India',
    gstNumber: '27AABCM1234H1Z6', industry: 'Pharmaceuticals',
    service: 'Clean Room HVAC + Electrical', category: 0, tags: ['pharma', 'hvac', 'electrical'],
    leadSource: 'landing_page', leadRating: 'hot', revenue: 350000,
    notes: 'GMP-compliant clean room HVAC and electrical installation.',
  },
  {
    firstName: 'Suresh',   lastName: 'Nair',    company: 'Suresh Hospitality Pvt Ltd',
    designation: 'GM',     email: 'suresh@sureshhospitality.in', phone: '+91 9876541007',
    mobile: '+91 9876541007', website: 'https://sureshhospitality.in',
    address: '89 Marine Drive', city: 'Mumbai', state: 'Maharashtra', postalCode: '400001', country: 'India',
    gstNumber: '27AACCS1234I1Z4', industry: 'Hospitality',
    service: 'Plumbing Maintenance + AMC', category: 2, tags: ['hospitality', 'amc'],
    leadSource: 'chatbot', leadRating: 'warm', revenue: 280000,
    notes: 'Annual maintenance contract for 150-room hotel plumbing systems.',
  },
  {
    firstName: 'Vijay',    lastName: 'Singh',   company: 'Vijay Constructions',
    designation: 'Director', email: 'vijay@vijayconstructions.in', phone: '+91 9876541008',
    mobile: '+91 9876541008', website: 'https://vijayconstructions.in',
    address: '12 Sector 17', city: 'Noida', state: 'Uttar Pradesh', postalCode: '201301', country: 'India',
    gstNumber: '09AABCV1234J1Z2', industry: 'Real Estate',
    service: 'Fire Safety + Access Control', category: 4, tags: ['construction', 'safety'],
    leadSource: 'manual', leadRating: 'cold', revenue: 195000,
    notes: 'Fire safety system and access control for 20-floor commercial tower.',
  },
] as const;

// ── Main seed ────────────────────────────────────────────────────────────────
async function seed() {
  console.log('\n🌱  LeadRyze AI — Native CRM + Field Service Seed\n');
  await mongoose.connect(config.mongodb.uri);
  console.log('  Connected to MongoDB:', config.mongodb.uri.split('@').pop());

  // ── 1. Get tenant ─────────────────────────────────────────────────────────
  // Priority: TENANT_SLUG env var → first non-demo active tenant → leadryze-demo
  const targetSlug = process.env.TENANT_SLUG;
  let tenant: any;

  if (targetSlug) {
    tenant = await Tenant.findOne({ slug: targetSlug });
    if (!tenant) throw new Error(`Tenant with slug "${targetSlug}" not found in DB`);
  } else {
    // Auto-detect: find first real tenant (not demo/system seeds)
    tenant = await Tenant.findOne({
      isActive: true,
      slug: { $nin: ['leadryze-demo', 'acme-corp', 'leadryze-system'] },
    }).sort({ createdAt: 1 });

    if (!tenant) {
      // Fall back to leadryze-demo
      tenant = await Tenant.findOne({ slug: 'leadryze-demo' });
    }
    if (!tenant) throw new Error('No active tenant found. Run the main seed first: npm run seed');
  }

  ok(`Seeding tenant: "${tenant.name}" (slug: ${tenant.slug}, clientId: ${tenant.clientId ?? 'auto-hex'})`);
  const tenantId = tenant._id as mongoose.Types.ObjectId;

  // ── 2. Clear existing native-CRM data for this tenant ─────────────────────
  sec('Clearing old seed data');
  const COLLECTIONS = [
    'native_leads', 'native_customers', 'native_sites', 'native_categories',
    'native_services', 'native_teams', 'native_staffs', 'native_parts',
    'native_workorders', 'native_quotations', 'native_contracts',
    'native_invoices', 'native_receipts', 'native_timeline', 'crm_deals',
    'native_fs_settings',
  ];
  await Promise.all(COLLECTIONS.map((c) => mongoose.connection.collection(c).deleteMany({ tenantId })));
  ok('Cleared all native-CRM collections for this tenant');

  // ── 3. FS Settings ─────────────────────────────────────────────────────────
  sec('FS Settings');
  const fsSettings = await FSSettings.create({
    tenantId,
    companyName:        'Acme Services Pvt Ltd',
    companyLogo:        'https://pyyevfuxxsmlocluztxq.supabase.co/storage/v1/object/public/Leadryze_Bucket/logos/acme-logo.png',
    gstin:              '27AABCA1234A1Z5',
    pan:                'AABCA1234A',
    businessRegNumber:  'MH-2018-0045632',
    companyEmail:       'info@acmeservices.in',
    phone:              '+91 22 4567 8900',
    whatsapp:           '+91 9876540000',
    website:            'https://acmeservices.in',
    address1:           '501, Tower B, BKC Complex',
    address2:           'Bandra Kurla Complex',
    city:               'Mumbai',
    state:              'Maharashtra',
    country:            'India',
    postalCode:         '400051',
    timezone:           'Asia/Kolkata',
    currency:           'INR',
    taxPercentage:      18,
    bankName:           'HDFC Bank Ltd',
    accountName:        'Acme Services Pvt Ltd',
    accountNumber:      '50200012345678',
    ifscCode:           'HDFC0001234',
    branch:             'BKC, Mumbai',
    upiId:              'acmeservices@hdfcbank',
    termsAndConditions: '1. Payment due within 30 days of invoice.\n2. GST as applicable.\n3. Disputes subject to Mumbai jurisdiction.',
    invoiceFooter:      'Thank you for your business! For support: support@acmeservices.in',
    quotationFooter:    'This quotation is valid for 30 days from the date of issue.',
    contractFooter:     'This contract is governed by Indian law. Signed copies required.',
    workingDays:        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    autoClientIdPrefix: 'LRZ',
  });
  ok(`FSSettings created for ${fsSettings.companyName}`);

  // ── 4. Categories ──────────────────────────────────────────────────────────
  sec('Categories');
  const catData = [
    { name: 'HVAC',            description: 'Heating, Ventilation & Air Conditioning services', color: '#0ea5e9', icon: 'fan' },
    { name: 'Electrical',      description: 'Electrical installation, inspection & repair',     color: '#f59e0b', icon: 'bolt' },
    { name: 'Plumbing',        description: 'Industrial & residential plumbing services',       color: '#3b82f6', icon: 'droplets' },
    { name: 'IT Support',      description: 'Network, server and IT infrastructure support',    color: '#8b5cf6', icon: 'server' },
    { name: 'Security Systems',description: 'CCTV, access control and fire safety systems',    color: '#ef4444', icon: 'shield' },
  ];
  const cats: any[] = [];
  for (const d of catData) {
    const cat = new NativeCategory({ tenantId, ...d });
    await cat.save();
    cats.push(cat);
    ok(`Category: ${cat.categoryId} — ${cat.name}`);
  }

  // ── 5. Services ────────────────────────────────────────────────────────────
  sec('Services');
  const svcData = [
    { name: 'AC Installation',           categoryId: cats[0]._id, price: 8500,  unit: 'per unit',  duration: 4,  description: 'Split AC installation including indoor & outdoor unit fitting' },
    { name: 'AC Annual Maintenance',     categoryId: cats[0]._id, price: 3500,  unit: 'per unit',  duration: 2,  description: 'Annual maintenance contract for split/cassette AC' },
    { name: 'Electrical Panel Audit',    categoryId: cats[1]._id, price: 5000,  unit: 'per visit', duration: 3,  description: 'Comprehensive electrical panel safety audit & report' },
    { name: 'Wiring & Rewiring',         categoryId: cats[1]._id, price: 120,   unit: 'per meter', duration: 8,  description: 'Commercial grade wiring installation with MCB protection' },
    { name: 'Plumbing Installation',     categoryId: cats[2]._id, price: 6500,  unit: 'per point', duration: 6,  description: 'Commercial plumbing point installation with CPVC pipes' },
    { name: 'Drain Cleaning & Repair',   categoryId: cats[2]._id, price: 2500,  unit: 'per drain', duration: 2,  description: 'High-pressure drain cleaning and blockage removal' },
    { name: 'Network Infrastructure',    categoryId: cats[3]._id, price: 15000, unit: 'per floor', duration: 8,  description: 'Structured cabling, switches and wireless access points' },
    { name: 'CCTV Camera Installation',  categoryId: cats[4]._id, price: 4500,  unit: 'per camera',duration: 1,  description: '2MP HD IP camera installation with NVR configuration' },
  ];
  const svcs: any[] = [];
  for (const d of svcData) {
    const svc = new NativeService({ tenantId, ...d });
    await svc.save();
    svcs.push(svc);
    ok(`Service: ${svc.serviceId} — ${svc.name} ₹${svc.price}`);
  }

  // ── 6. Teams ───────────────────────────────────────────────────────────────
  sec('Teams');
  const teamData = [
    { name: 'North Zone Team',   description: 'Covers Delhi, Noida, Gurgaon and NCR region' },
    { name: 'South Zone Team',   description: 'Covers Chennai, Bengaluru, Hyderabad region' },
    { name: 'West Zone Team',    description: 'Covers Mumbai, Pune, Ahmedabad region' },
  ];
  const teams: any[] = [];
  for (const d of teamData) {
    const team = new NativeTeam({ tenantId, ...d });
    await team.save();
    teams.push(team);
    ok(`Team: ${team.teamId} — ${team.name}`);
  }

  // ── 7. Staffs ──────────────────────────────────────────────────────────────
  sec('Staffs');
  const staffData = [
    // North Zone
    { firstName: 'Arjun',   lastName: 'Sharma',  email: 'arjun.sharma@acme.in',  phone: '+91 9811001001', teamId: teams[0]._id, role: 'Senior Technician' },
    { firstName: 'Deepak',  lastName: 'Verma',   email: 'deepak.verma@acme.in',  phone: '+91 9811001002', teamId: teams[0]._id, role: 'Electrician' },
    { firstName: 'Pradeep', lastName: 'Yadav',   email: 'pradeep.yadav@acme.in', phone: '+91 9811001003', teamId: teams[0]._id, role: 'Plumber' },
    // South Zone
    { firstName: 'Karthik', lastName: 'Rajan',   email: 'karthik.rajan@acme.in', phone: '+91 9944001001', teamId: teams[1]._id, role: 'HVAC Specialist' },
    { firstName: 'Divya',   lastName: 'Menon',   email: 'divya.menon@acme.in',   phone: '+91 9944001002', teamId: teams[1]._id, role: 'IT Engineer' },
    { firstName: 'Arun',    lastName: 'Pillai',  email: 'arun.pillai@acme.in',   phone: '+91 9944001003', teamId: teams[1]._id, role: 'Security Technician' },
    // West Zone
    { firstName: 'Nikhil',  lastName: 'Patil',   email: 'nikhil.patil@acme.in',  phone: '+91 9920001001', teamId: teams[2]._id, role: 'Lead Technician' },
    { firstName: 'Sneha',   lastName: 'Joshi',   email: 'sneha.joshi@acme.in',   phone: '+91 9920001002', teamId: teams[2]._id, role: 'Electrical Engineer' },
    { firstName: 'Rahul',   lastName: 'Desai',   email: 'rahul.desai@acme.in',   phone: '+91 9920001003', teamId: teams[2]._id, role: 'Plumbing Supervisor' },
  ];
  const staffs: any[] = [];
  for (const d of staffData) {
    const st = new NativeStaff({ tenantId, ...d });
    await st.save();
    staffs.push(st);
    ok(`Staff: ${st.staffId} — ${st.firstName} ${st.lastName} (${st.role})`);
  }

  // ── 8. Parts / Inventory ────────────────────────────────────────────────────
  sec('Parts');
  const partData = [
    { name: 'Copper Pipe 20mm',       partNumber: 'CP-20MM', price: 85,    unit: 'meter', quantity: 500, description: 'CPVC copper pipe 20mm for plumbing' },
    { name: 'PVC Conduit 25mm',       partNumber: 'PV-25MM', price: 45,    unit: 'meter', quantity: 800, description: 'Rigid PVC conduit for electrical wiring' },
    { name: 'MCB 32A Single Pole',    partNumber: 'MCB-32A', price: 320,   unit: 'piece', quantity: 200, description: 'Schneider Electric MCB 32A 1P' },
    { name: 'CCTV IP Camera 2MP',     partNumber: 'CAM-2MP', price: 2800,  unit: 'piece', quantity: 50,  description: 'Hikvision 2MP dome IP camera' },
    { name: 'CAT6 Network Cable',     partNumber: 'CAT6',    price: 18,    unit: 'meter', quantity: 2000,description: 'CAT6 UTP network cable 305m box' },
    { name: 'AC Gas R-32 (1kg)',       partNumber: 'GAS-R32', price: 450,   unit: 'kg',    quantity: 100, description: 'R-32 refrigerant gas for inverter ACs' },
    { name: 'Ball Valve 1 inch',      partNumber: 'BV-1IN',  price: 180,   unit: 'piece', quantity: 300, description: 'Brass ball valve 1 inch for plumbing' },
    { name: 'Cable Tray 100x50mm',    partNumber: 'CT-100',  price: 220,   unit: 'meter', quantity: 400, description: 'GI perforated cable tray 100x50mm' },
  ];
  const parts: any[] = [];
  for (const d of partData) {
    const p = new NativePart({ tenantId, ...d });
    await p.save();
    parts.push(p);
    ok(`Part: ${p.partId} — ${p.name} ₹${p.price}`);
  }

  // ── 9. Leads ───────────────────────────────────────────────────────────────
  sec('Leads');
  const leadStatuses = ['new', 'contacted', 'qualified', 'meeting_scheduled', 'proposal_sent', 'negotiation', 'won', 'lost'] as const;
  const leads: any[] = [];
  for (let i = 0; i < BUSINESSES.length; i++) {
    const b = BUSINESSES[i];
    const lead = new Lead({
      tenantId,
      firstName:       b.firstName,
      lastName:        b.lastName,
      company:         b.company,
      designation:     b.designation,
      email:           b.email,
      phone:           b.phone,
      mobile:          b.mobile,
      website:         b.website,
      address:         b.address,
      city:            b.city,
      state:           b.state,
      country:         b.country,
      postalCode:      b.postalCode,
      gstNumber:       b.gstNumber,
      industry:        b.industry,
      status:          leadStatuses[i],
      source:          b.leadSource,
      rating:          b.leadRating,
      score:           b.leadRating === 'hot' ? 85 : b.leadRating === 'warm' ? 60 : 35,
      priority:        b.leadRating === 'hot' ? 'high' : 'medium',
      expectedRevenue: b.revenue,
      budget:          Math.round(b.revenue * 0.9),
      requirement:     b.notes,
      tags:            [...b.tags],
      notes:           b.notes,
      lastActivityAt:  new Date(),
    });
    await lead.save();
    leads.push(lead);
    ok(`Lead: ${lead.leadId} — ${lead.firstName} ${lead.lastName}, ${lead.company} [${lead.status}]`);
  }

  // ── 10. Customers (converted from leads) ────────────────────────────────────
  sec('Customers');
  const customers: any[] = [];
  for (let i = 0; i < BUSINESSES.length; i++) {
    const b = BUSINESSES[i];
    const lead = leads[i];
    const cust = new NativeCustomer({
      tenantId,
      name:        `${b.firstName} ${b.lastName}`,
      company:     b.company,
      designation: b.designation,
      email:       b.email,
      phone:       b.phone,
      mobile:      b.mobile,
      website:     b.website,
      address:     b.address,
      city:        b.city,
      state:       b.state,
      postcode:    b.postalCode,
      country:     b.country,
      notes:       `Converted from Lead ${lead.leadId}. ${b.notes}`,
      tags:        [...b.tags],
      status:      'active',
    });
    await cust.save();
    customers.push(cust);

    // Update lead to mark as converted (keep original pipeline status)
    lead.isConverted         = true;
    lead.convertedCustomerId = cust.customerId;
    lead.convertedAt         = new Date();
    await lead.save();

    ok(`Customer: ${cust.customerId} — ${cust.name}, ${cust.company}`);
  }

  // ── 11. Sites ──────────────────────────────────────────────────────────────
  sec('Sites');
  const siteNames = [
    'Server Room & Data Centre', 'Main Showroom Floor', 'Factory Unit A',
    'IT Infrastructure Floor 3', 'Headquarters Office', 'Clean Room GMP Zone',
    'Hotel Block A & B', 'Commercial Tower - All Floors',
  ];
  const sites: any[] = [];
  for (let i = 0; i < customers.length; i++) {
    const b    = BUSINESSES[i];
    const cust = customers[i];
    const site = new NativeSite({
      tenantId,
      name:          siteNames[i],
      address:       b.address,
      city:          b.city,
      state:         b.state,
      postcode:      b.postalCode,
      country:       b.country,
      customerId:    cust._id,
      contactPerson: `${b.firstName} ${b.lastName}`,
      phone:         b.phone,
      notes:         `Primary site for ${cust.company}`,
    });
    await site.save();
    sites.push(site);
    ok(`Site: ${site.siteId} — ${site.name} → ${cust.customerId}`);
  }

  // ── 12. Deals (Native CRM) ─────────────────────────────────────────────────
  sec('Deals (Native CRM)');
  const dealStages = ['qualified', 'proposal', 'negotiation', 'closed_won', 'closed_won', 'closed_won', 'negotiation', 'proposal'] as const;
  const deals: any[] = [];
  for (let i = 0; i < BUSINESSES.length; i++) {
    const b    = BUSINESSES[i];
    const cust = customers[i];
    const deal = new Deal({
      tenantId,
      title:       `${b.company} — ${b.service}`,
      amount:      b.revenue,
      currency:    'INR',
      stage:       dealStages[i],
      closeDate:   new Date(Date.now() + (30 + i * 15) * 24 * 60 * 60 * 1000),
      contactName: `${b.firstName} ${b.lastName}`,
      companyName: b.company,
      notes:       b.notes,
      tags:        [...b.tags],
    });
    await deal.save();
    deals.push(deal);
    ok(`Deal: ${deal.title.slice(0, 40)} [${deal.stage}] ₹${deal.amount?.toLocaleString('en-IN')}`);
  }

  // ── 13. Quotations ─────────────────────────────────────────────────────────
  sec('Quotations');
  const quotationServices = [
    [{ name: 'AC Annual Maintenance', description: 'AMC for 8 units server room AC', amount: 3500, count: 8 }, { name: 'AC Gas R-32 Refilling', description: 'Refrigerant top-up 2 units', amount: 1800, count: 2 }],
    [{ name: 'Electrical Panel Audit', description: 'Full audit with report', amount: 5000, count: 1 }, { name: 'Wiring & Rewiring', description: '50m commercial rewiring', amount: 120, count: 50 }],
    [{ name: 'Plumbing Installation', description: 'Factory plumbing 12 points', amount: 6500, count: 12 }, { name: 'Ball Valve Supply & Fit', description: 'Shut-off valves', amount: 350, count: 10 }],
    [{ name: 'Network Infrastructure', description: 'Structured cabling 3 floors', amount: 15000, count: 3 }, { name: 'CAT6 Cable (100m)', description: 'Network cabling material', amount: 1800, count: 1 }],
    [{ name: 'CCTV Camera Installation', description: '16 cameras with NVR', amount: 4500, count: 16 }, { name: 'Cable Tray Installation', description: '20m cable routing', amount: 220, count: 20 }],
    [{ name: 'AC Installation', description: 'Clean room precision AC units', amount: 8500, count: 4 }, { name: 'Electrical Panel Audit', description: 'GMP compliance audit', amount: 5000, count: 1 }],
    [{ name: 'Plumbing Installation', description: '30 plumbing points hotel', amount: 6500, count: 30 }, { name: 'Drain Cleaning', description: 'All floor drains cleaning', amount: 2500, count: 8 }],
    [{ name: 'CCTV Camera Installation', description: '32 cameras tower security', amount: 4500, count: 32 }, { name: 'Network Infrastructure', description: 'Access control network', amount: 15000, count: 1 }],
  ];
  const quotationStatuses = ['approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'sent', 'draft'] as const;
  const quotations: any[] = [];
  for (let i = 0; i < customers.length; i++) {
    const cust  = customers[i];
    const b     = BUSINESSES[i];
    const svcLines = quotationServices[i];
    const { servicesAmount, servicesAmountWithTax } = calcAmounts(svcLines, 0, 18);
    const quot = new NativeQuotation({
      tenantId,
      customerId:            cust.customerId,
      title:                 `${b.service} — ${cust.company}`,
      address:               `${b.address}, ${b.city}, ${b.state} ${b.postalCode}`,
      services:              svcLines,
      discount:              0,
      gstPercentage:         18,
      servicesAmount,
      servicesAmountWithTax,
      status:                quotationStatuses[i],
      validUntil:            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      notes:                 `Quotation for ${b.service} at ${cust.company}. Site: ${siteNames[i]}.`,
    });
    await quot.save();
    quotations.push(quot);
    ok(`Quotation: ${quot.quotationId} — ${quot.title.slice(0, 40)} ₹${servicesAmountWithTax.toLocaleString('en-IN')}`);
  }

  // ── 14. Work Orders ────────────────────────────────────────────────────────
  sec('Work Orders');
  const woStatuses  = ['completed', 'completed', 'completed', 'completed', 'in_progress', 'completed', 'scheduled', 'draft'] as const;
  const woPriorities = ['high', 'medium', 'high', 'high', 'medium', 'high', 'medium', 'low'] as const;
  // Team and staff assignments: [teamIdx, staffIdx]
  const woAssignments = [[1,3],[1,5],[2,6],[1,4],[0,0],[2,7],[2,8],[0,1]];
  const workorders: any[] = [];
  const woChecklists = [
    [{item:'Inspect all AC units',completed:true},{item:'Clean filters & coils',completed:true},{item:'Check refrigerant levels',completed:true},{item:'Test thermostat settings',completed:true}],
    [{item:'Inspect main panel breakers',completed:true},{item:'Check earthing continuity',completed:true},{item:'Test MCB trip ratings',completed:true},{item:'Issue compliance certificate',completed:true}],
    [{item:'Survey existing plumbing',completed:true},{item:'Install CPVC pipes',completed:true},{item:'Fit ball valves',completed:true},{item:'Pressure test all joints',completed:true},{item:'Commission system',completed:true}],
    [{item:'Audit existing network',completed:true},{item:'Install CAT6 cabling',completed:true},{item:'Configure switches & router',completed:true},{item:'Test all ports',completed:true}],
    [{item:'Install camera mounts',completed:false},{item:'Run cable to NVR room',completed:false},{item:'Configure IP cameras',completed:false},{item:'Setup remote viewing',completed:false}],
    [{item:'Install precision AC units',completed:true},{item:'Commission BMS integration',completed:true},{item:'Validate room temp',completed:true},{item:'GMP validation report',completed:true}],
    [{item:'Replace worn fixtures',completed:false},{item:'Clean all drains',completed:false},{item:'Check water pressure',completed:false}],
    [{item:'Site survey complete',completed:false},{item:'Design layout approved',completed:false}],
  ];
  for (let i = 0; i < customers.length; i++) {
    const cust   = customers[i];
    const b      = BUSINESSES[i];
    const site   = sites[i];
    const [ti, si] = woAssignments[i];
    const svcLines = quotationServices[i].map((s) => ({ ...s }));
    const wo = new NativeWorkorder({
      tenantId,
      customerId:    cust.customerId,
      siteId:        site.siteId,
      teamId:        teams[ti].teamId,
      staffId:       staffs[si].staffId,
      title:         `${b.service} — ${cust.company}`,
      scheduledDate: new Date(Date.now() - (30 - i * 3) * 24 * 60 * 60 * 1000),
      completedDate: woStatuses[i] === 'completed' ? new Date(Date.now() - i * 2 * 24 * 60 * 60 * 1000) : undefined,
      services:      svcLines,
      priority:      woPriorities[i],
      status:        woStatuses[i],
      notes:         `Work order for ${b.service}. Customer: ${cust.name}, ${cust.company}. Site: ${siteNames[i]}.`,
      checklists:    woChecklists[i],
      photos:        [],
    });
    await wo.save();
    workorders.push(wo);
    ok(`WorkOrder: ${wo.workOrderId} — ${wo.title.slice(0,40)} [${wo.status}] → ${cust.customerId}`);
  }

  // ── 15. Contracts ──────────────────────────────────────────────────────────
  sec('Contracts');
  const contractStatuses = ['active', 'active', 'active', 'active', 'active', 'active', 'draft', 'draft'] as const;
  const contracts: any[] = [];
  for (let i = 0; i < customers.length; i++) {
    const cust = customers[i];
    const b    = BUSINESSES[i];
    const quot = quotations[i];
    const svcLines = quotationServices[i].map((s) => ({ ...s }));
    const { servicesAmount, servicesAmountWithTax } = calcAmounts(svcLines, 0, 18);
    const startDate = new Date();
    const endDate   = new Date(startDate.getTime() + 365 * 24 * 60 * 60 * 1000);
    const con = new NativeContract({
      tenantId,
      customerId:            cust.customerId,
      quotationId:           quot.quotationId,
      title:                 `AMC — ${b.service} (${cust.company})`,
      startDate,
      endDate,
      services:              svcLines,
      serviceFrequency:      i < 3 ? 'Quarterly' : i < 6 ? 'Monthly' : 'Annual',
      discount:              0,
      gstPercentage:         18,
      servicesAmount,
      servicesAmountWithTax,
      status:                contractStatuses[i],
      notes:                 `Annual Maintenance Contract for ${b.service}. Renewed from quotation ${quot.quotationId}.`,
    });
    await con.save();
    contracts.push(con);
    ok(`Contract: ${con.contractId} — ${con.title.slice(0,40)} [${con.status}] → ${cust.customerId}`);
  }

  // ── 16. Invoices ───────────────────────────────────────────────────────────
  sec('Invoices');
  const invoiceStatuses = ['paid', 'paid', 'paid', 'paid', 'sent', 'paid', 'draft', 'draft'] as const;
  const invoices: any[] = [];
  for (let i = 0; i < customers.length; i++) {
    const cust = customers[i];
    const b    = BUSINESSES[i];
    const wo   = workorders[i];
    const svcLines = quotationServices[i].map((s) => ({ ...s }));
    const { servicesAmount, servicesAmountWithTax } = calcAmounts(svcLines, 0, 18);
    const inv = new NativeInvoice({
      tenantId,
      customerId:            cust.customerId,
      workOrderId:           wo.workOrderId,
      address:               `${b.address}, ${b.city}, ${b.state} ${b.postalCode}`,
      services:              svcLines,
      discount:              0,
      gstPercentage:         18,
      servicesAmount,
      servicesAmountWithTax,
      dueDate:               new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      paid:                  invoiceStatuses[i] === 'paid',
      status:                invoiceStatuses[i],
      notes:                 `Invoice for work order ${wo.workOrderId}. Services rendered at ${siteNames[i]}.`,
    });
    await inv.save();
    invoices.push(inv);
    ok(`Invoice: ${inv.invoiceId} — ₹${servicesAmountWithTax.toLocaleString('en-IN')} [${inv.status}] → ${cust.customerId}`);
  }

  // ── 17. Receipts ───────────────────────────────────────────────────────────
  sec('Receipts');
  const paymentMethods = ['bank_transfer', 'online', 'bank_transfer', 'card', 'online', 'bank_transfer'] as const;
  const receipts: any[] = [];
  for (let i = 0; i < 6; i++) {   // Only for paid invoices
    const cust  = customers[i];
    const inv   = invoices[i];
    const { servicesAmountWithTax } = calcAmounts(quotationServices[i].map((s) => ({...s})), 0, 18);
    const rcp = new NativeReceipt({
      tenantId,
      invoiceId:     inv.invoiceId,
      customerId:    cust.customerId,
      amount:        servicesAmountWithTax,
      paymentMethod: paymentMethods[i],
      paymentDate:   new Date(Date.now() - (i + 1) * 3 * 24 * 60 * 60 * 1000),
      notes:         `Full payment received for ${inv.invoiceId}. Method: ${paymentMethods[i].replace('_',' ')}.`,
      status:        'completed',
    });
    await rcp.save();
    receipts.push(rcp);
    ok(`Receipt: ${rcp.receiptId} — ₹${rcp.amount.toLocaleString('en-IN')} via ${rcp.paymentMethod} → ${inv.invoiceId}`);
  }

  // ── 18. Timeline Events ────────────────────────────────────────────────────
  sec('Timeline Events');
  const timelineEvents: any[] = [];
  for (let i = 0; i < Math.min(leads.length, 4); i++) {
    // Lead created
    timelineEvents.push({ tenantId, entityModule: 'leads', entityId: leads[i]._id.toString(), action: 'created',        description: `Lead ${leads[i].leadId} created from ${leads[i].source}`,    performedBy: 'seed' });
    timelineEvents.push({ tenantId, entityModule: 'leads', entityId: leads[i]._id.toString(), action: 'status_changed', description: `Stage moved: new → ${leads[i].status}`,                       performedBy: 'seed' });
    timelineEvents.push({ tenantId, entityModule: 'leads', entityId: leads[i]._id.toString(), action: 'status_changed', description: `Lead converted to Customer ${customers[i].customerId}`,        performedBy: 'seed', metadata: { customerId: customers[i].customerId } });
    // Customer timeline
    timelineEvents.push({ tenantId, entityModule: 'customers', entityId: customers[i]._id.toString(), action: 'created', description: `Customer ${customers[i].customerId} created from Lead ${leads[i].leadId}`, performedBy: 'seed' });
    // WorkOrder timeline
    timelineEvents.push({ tenantId, entityModule: 'workorders', entityId: workorders[i]._id.toString(), action: 'created',        description: `Work order ${workorders[i].workOrderId} created`,               performedBy: 'seed' });
    if (workorders[i].status === 'completed') {
      timelineEvents.push({ tenantId, entityModule: 'workorders', entityId: workorders[i]._id.toString(), action: 'status_changed', description: `Work order marked completed`,                                    performedBy: 'seed' });
    }
    // Invoice timeline
    timelineEvents.push({ tenantId, entityModule: 'invoices', entityId: invoices[i]._id.toString(), action: 'created',        description: `Invoice ${invoices[i].invoiceId} generated from ${workorders[i].workOrderId}`, performedBy: 'seed' });
    if (invoices[i].status === 'paid') {
      timelineEvents.push({ tenantId, entityModule: 'invoices', entityId: invoices[i]._id.toString(), action: 'status_changed', description: `Invoice marked paid — receipt ${receipts[i]?.receiptId}`,               performedBy: 'seed' });
    }
  }
  await NativeTimeline.insertMany(timelineEvents);
  ok(`Created ${timelineEvents.length} timeline events`);

  // ── 19. Summary Report ─────────────────────────────────────────────────────
  sec('Summary');
  const counts = await Promise.all([
    Lead.countDocuments({ tenantId }),
    NativeCustomer.countDocuments({ tenantId }),
    NativeSite.countDocuments({ tenantId }),
    NativeCategory.countDocuments({ tenantId }),
    NativeService.countDocuments({ tenantId }),
    NativeTeam.countDocuments({ tenantId }),
    NativeStaff.countDocuments({ tenantId }),
    NativePart.countDocuments({ tenantId }),
    NativeWorkorder.countDocuments({ tenantId }),
    NativeQuotation.countDocuments({ tenantId }),
    NativeContract.countDocuments({ tenantId }),
    NativeInvoice.countDocuments({ tenantId }),
    NativeReceipt.countDocuments({ tenantId }),
    Deal.countDocuments({ tenantId }),
    NativeTimeline.countDocuments({ tenantId }),
  ]);
  const labels = ['Leads','Customers','Sites','Categories','Services','Teams','Staffs','Parts','WorkOrders','Quotations','Contracts','Invoices','Receipts','Deals','Timeline'];

  console.log('\n┌─────────────────────────────────┬───────┐');
  console.log('│  Collection                     │ Count │');
  console.log('├─────────────────────────────────┼───────┤');
  labels.forEach((l, idx) => {
    console.log(`│  ${l.padEnd(31)}│  ${String(counts[idx]).padStart(4)} │`);
  });
  console.log('└─────────────────────────────────┴───────┘');

  // ── 20. Relational Integrity Check ────────────────────────────────────────
  console.log('\n  🔗  Relational Check');
  console.log(`  Lead[0]     ${leads[0].leadId} → Customer ${customers[0].customerId} (isConverted: ${leads[0].isConverted})`);
  console.log(`  Customer[0] ${customers[0].customerId} → Site ${sites[0].siteId}`);
  console.log(`  WorkOrder[0] ${workorders[0].workOrderId} → customerId: ${workorders[0].customerId}`);
  console.log(`  Invoice[0]  ${invoices[0].invoiceId} → workOrderId: ${invoices[0].workOrderId}`);
  console.log(`  Receipt[0]  ${receipts[0].receiptId} → invoiceId: ${receipts[0].invoiceId}`);
  console.log(`  Contract[0] ${contracts[0].contractId} → quotationId: ${contracts[0].quotationId}`);

  console.log('\n✅  Native CRM seed complete!\n');
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('\n❌  Seed failed:', err);
  process.exit(1);
});
