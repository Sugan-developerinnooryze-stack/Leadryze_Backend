/**
 * seed-branches.ts
 * Seeds 4–5 records per module for subcompany1 and subcompany2.
 * Run:  npm run seed:branches
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { config } from './config';
import { Tenant }          from './modules/tenants/tenant.model';
import { Branch }          from './modules/native-crm/branches/branch.model';
void Tenant; // ensure Tenant schema is registered so resolveClientPrefix works
import { Lead }            from './modules/native-crm/leads/lead.model';
import { NativeCustomer }  from './modules/native-crm/customers/customer.model';
import { NativeCategory }  from './modules/native-crm/categories/category.model';
import { NativeService }   from './modules/native-crm/services/service.model';
import { NativeTeam }      from './modules/native-crm/teams/team.model';
import { NativeStaff }     from './modules/native-crm/staffs/staff.model';
import { NativeSite }      from './modules/native-crm/sites/site.model';
import { NativeWorkorder } from './modules/native-crm/workorders/workorder.model';
import { NativeQuotation } from './modules/native-crm/quotations/quotation.model';
import { NativeContract }  from './modules/native-crm/contracts/contract.model';
import { NativeInvoice }   from './modules/native-crm/invoices/invoice.model';
import { NativeReceipt }   from './modules/native-crm/receipts/receipt.model';
import { NativeExpense }   from './modules/native-crm/expenses/expense.model';
import { NativeActivity }  from './modules/native-crm/activities/activity.model';
import { NativePart }      from './modules/native-crm/parts/part.model';
import { NativeProduct }   from './modules/native-crm/products/product.model';
import { NativeAsset }     from './modules/native-crm/assets/asset.model';
import { NativeVehicle }   from './modules/native-crm/vehicles/vehicle.model';

const ok  = (msg: string) => console.log(`  ✔  ${msg}`);
const sec = (label: string) => console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}`);

function calcAmounts(services: Array<{ amount: number; count: number }>, discount = 0, gst = 18) {
  const sub = services.reduce((s, l) => s + l.amount * l.count, 0);
  return { servicesAmount: sub, servicesAmountWithTax: Math.round((sub - discount) * (1 + gst / 100)) };
}

async function seedBranch(tenantId: mongoose.Types.ObjectId, branchId: mongoose.Types.ObjectId, label: string) {
  const B = String(branchId);
  const isA = label === 'subcompany1';

  sec(`${label} — Customers`);
  const customerData = isA
    ? [
        { name: 'Arjun Verma',    company: 'Verma Constructions',   phone: '+91 9800001001', city: 'Delhi',     email: `arjun.${B.slice(-4)}@vermaconst.in` },
        { name: 'Kavitha Nair',   company: 'Nair Infrastructure',   phone: '+91 9800001002', city: 'Kochi',     email: `kavitha.${B.slice(-4)}@nairinfra.in` },
        { name: 'Deepak Sharma',  company: 'Sharma Builders',       phone: '+91 9800001003', city: 'Jaipur',    email: `deepak.${B.slice(-4)}@sharmabuild.in` },
        { name: 'Meera Pillai',   company: 'Pillai Projects',       phone: '+91 9800001004', city: 'Trivandrum', email: `meera.${B.slice(-4)}@pillaipro.in` },
      ]
    : [
        { name: 'Rohan Mehta',    company: 'Mehta Tech Services',   phone: '+91 9800002001', city: 'Pune',      email: `rohan.${B.slice(-4)}@mehtatech.in` },
        { name: 'Sneha Reddy',    company: 'Reddy Digital',         phone: '+91 9800002002', city: 'Hyderabad', email: `sneha.${B.slice(-4)}@reddydigital.in` },
        { name: 'Vikram Iyer',    company: 'Iyer IT Solutions',     phone: '+91 9800002003', city: 'Chennai',   email: `vikram.${B.slice(-4)}@iyerit.in` },
        { name: 'Anjali Gupta',   company: 'Gupta Softwares',       phone: '+91 9800002004', city: 'Bengaluru', email: `anjali.${B.slice(-4)}@guptasoft.in` },
      ];

  const customers: any[] = [];
  for (const d of customerData) {
    const c = await new NativeCustomer({ ...d, tenantId, branchId, status: 'active' }).save();
    customers.push(c);
    ok(`Customer: ${d.name}`);
  }

  sec(`${label} — Leads`);
  const leadData = isA
    ? [
        { firstName: 'Suresh',   lastName: 'Joshi',    company: 'Joshi Constructions', phone: '+91 9800001011', email: `sjoshi.${B.slice(-4)}@joshiconst.in`,   status: 'new',       rating: 'hot',  source: 'referral' },
        { firstName: 'Lakshmi',  lastName: 'Rao',      company: 'Rao Real Estate',     phone: '+91 9800001012', email: `lrao.${B.slice(-4)}@raorealty.in`,       status: 'contacted', rating: 'warm', source: 'website' },
        { firstName: 'Manoj',    lastName: 'Tiwari',   company: 'Tiwari Cement',       phone: '+91 9800001013', email: `mtiwari.${B.slice(-4)}@tiwaricem.in`,    status: 'qualified', rating: 'hot',  source: 'google' },
        { firstName: 'Pooja',    lastName: 'Pandey',   company: 'Pandey Interiors',    phone: '+91 9800001014', email: `ppandey.${B.slice(-4)}@pandeyint.in`,    status: 'new',       rating: 'cold', source: 'manual' },
      ]
    : [
        { firstName: 'Kiran',    lastName: 'Desai',    company: 'Desai Cloud Corp',    phone: '+91 9800002011', email: `kdesai.${B.slice(-4)}@desaicloud.in`,    status: 'new',       rating: 'hot',  source: 'website' },
        { firstName: 'Neha',     lastName: 'Kapoor',   company: 'Kapoor Analytics',    phone: '+91 9800002012', email: `nkapoor.${B.slice(-4)}@kapoorana.in`,    status: 'contacted', rating: 'warm', source: 'referral' },
        { firstName: 'Rahul',    lastName: 'Singh',    company: 'Singh Cyber',         phone: '+91 9800002013', email: `rsingh.${B.slice(-4)}@singhcyber.in`,    status: 'qualified', rating: 'hot',  source: 'google' },
        { firstName: 'Divya',    lastName: 'Shetty',   company: 'Shetty SaaS',         phone: '+91 9800002014', email: `dshetty.${B.slice(-4)}@shettysaas.in`,   status: 'new',       rating: 'warm', source: 'manual' },
      ];

  for (const d of leadData) {
    await new Lead({ ...d, tenantId, branchId, priority: 'medium', score: 50 }).save();
    ok(`Lead: ${d.firstName} ${d.lastName}`);
  }

  sec(`${label} — Categories`);
  const catNames = isA
    ? ['Civil Works', 'Electrical', 'Plumbing', 'Interior Design']
    : ['Software Dev', 'Cloud Services', 'Cybersecurity', 'Data Analytics'];

  const catDocs: any[] = [];
  for (const name of catNames) {
    const c = await new NativeCategory({ name, tenantId, branchId, status: 'active', description: `${name} category for ${label}` }).save();
    catDocs.push(c);
    ok(`Category: ${name}`);
  }

  sec(`${label} — Services`);
  const serviceData = isA
    ? [
        { name: 'Foundation Inspection', price: 12000, unit: 'visit' },
        { name: 'Electrical Wiring',     price: 8500,  unit: 'unit' },
        { name: 'Plumbing Install',      price: 6000,  unit: 'floor' },
        { name: 'Painting & Finishing',  price: 4500,  unit: 'sqft' },
      ]
    : [
        { name: 'Web App Development',   price: 50000, unit: 'project' },
        { name: 'Cloud Migration',       price: 35000, unit: 'server' },
        { name: 'Security Audit',        price: 20000, unit: 'audit' },
        { name: 'Data Pipeline Setup',   price: 28000, unit: 'pipeline' },
      ];

  for (let i = 0; i < serviceData.length; i++) {
    await new NativeService({ ...serviceData[i], tenantId, branchId, status: 'active', categoryId: catDocs[i % catDocs.length]._id }).save();
    ok(`Service: ${serviceData[i].name}`);
  }

  sec(`${label} — Teams`);
  const teamNames = isA
    ? ['Civil Team Alpha', 'Electrical Squad']
    : ['Dev Team Bravo', 'Infra Squad'];

  const teams: any[] = [];
  for (const name of teamNames) {
    const t = await new NativeTeam({ name, tenantId, branchId, status: 'active' }).save();
    teams.push(t);
    ok(`Team: ${name}`);
  }

  sec(`${label} — Staffs`);
  const staffData = isA
    ? [
        { firstName: 'Ganesh',   lastName: 'Murthy',   role: 'Site Engineer',    phone: '+91 9800001021', email: `gmurthy.${B.slice(-4)}@co.in` },
        { firstName: 'Lakshman', lastName: 'Prasad',   role: 'Electrician',      phone: '+91 9800001022', email: `lprasad.${B.slice(-4)}@co.in` },
        { firstName: 'Sunita',   lastName: 'Devi',     role: 'Project Manager',  phone: '+91 9800001023', email: `sdevi.${B.slice(-4)}@co.in` },
        { firstName: 'Ramesh',   lastName: 'Yadav',    role: 'Plumber',          phone: '+91 9800001024', email: `ryadav.${B.slice(-4)}@co.in` },
      ]
    : [
        { firstName: 'Aditya',   lastName: 'Kumar',    role: 'Backend Developer', phone: '+91 9800002021', email: `akumar.${B.slice(-4)}@co.in` },
        { firstName: 'Pallavi',  lastName: 'Shah',     role: 'Cloud Architect',   phone: '+91 9800002022', email: `pshah.${B.slice(-4)}@co.in` },
        { firstName: 'Siddharth',lastName: 'Bose',     role: 'Security Engineer', phone: '+91 9800002023', email: `sbose.${B.slice(-4)}@co.in` },
        { firstName: 'Tanvi',    lastName: 'Jain',     role: 'Data Scientist',    phone: '+91 9800002024', email: `tjain.${B.slice(-4)}@co.in` },
      ];

  for (let i = 0; i < staffData.length; i++) {
    await new NativeStaff({ ...staffData[i], tenantId, branchId, status: 'active', teamId: teams[i % teams.length]._id }).save();
    ok(`Staff: ${staffData[i].firstName} ${staffData[i].lastName}`);
  }

  sec(`${label} — Sites`);
  const siteData = isA
    ? [
        { name: 'Sector 18 Building Site', address: 'Sector 18, Noida',   city: 'Noida',     state: 'UP' },
        { name: 'MG Road Commercial',      address: '12 MG Road',         city: 'Delhi',     state: 'Delhi' },
        { name: 'Anna Nagar Residence',    address: '5 Anna Nagar',       city: 'Chennai',   state: 'TN' },
      ]
    : [
        { name: 'Technopark Campus',       address: 'Technopark Phase 1', city: 'Trivandrum',state: 'Kerala' },
        { name: 'Whitefield IT Hub',       address: 'Whitefield Rd',      city: 'Bengaluru', state: 'Karnataka' },
        { name: 'Hinjewadi Office',        address: 'Hinjewadi Phase 2',  city: 'Pune',      state: 'Maharashtra' },
      ];

  for (const d of siteData) {
    await new NativeSite({ ...d, tenantId, branchId, status: 'active', customerId: customers[0]._id }).save();
    ok(`Site: ${d.name}`);
  }

  sec(`${label} — Work Orders`);
  const woData = isA
    ? [
        { title: 'Foundation Survey — Block A',     customerId: customers[0].customerId, priority: 'high',   status: 'in_progress' },
        { title: 'Electrical Panel Upgrade',        customerId: customers[1].customerId, priority: 'medium', status: 'scheduled' },
        { title: 'Plumbing Repair — 3rd Floor',    customerId: customers[2].customerId, priority: 'low',    status: 'draft' },
        { title: 'Interior Painting — Block C',     customerId: customers[3].customerId, priority: 'medium', status: 'draft' },
      ]
    : [
        { title: 'API Integration — Phase 1',       customerId: customers[0].customerId, priority: 'high',   status: 'in_progress' },
        { title: 'Cloud Server Migration',          customerId: customers[1].customerId, priority: 'high',   status: 'scheduled' },
        { title: 'Penetration Testing',             customerId: customers[2].customerId, priority: 'medium', status: 'draft' },
        { title: 'ETL Pipeline Build',              customerId: customers[3].customerId, priority: 'low',    status: 'draft' },
      ];

  const woDocs: any[] = [];
  for (const d of woData) {
    const wo = await new NativeWorkorder({
      ...d, tenantId, branchId,
      services: [{ name: 'Labour', amount: 5000, count: 2 }],
      parts:    [],
      checklists: [],
      photos:     [],
    }).save();
    woDocs.push(wo);
    ok(`Work Order: ${d.title}`);
  }

  sec(`${label} — Quotations`);
  const qoData = isA
    ? [
        { title: 'Foundation Quote',     customerId: customers[0].customerId },
        { title: 'Electrical Quote',     customerId: customers[1].customerId },
        { title: 'Plumbing Quote',       customerId: customers[2].customerId },
        { title: 'Painting Quote',       customerId: customers[3].customerId },
      ]
    : [
        { title: 'App Dev Proposal',     customerId: customers[0].customerId },
        { title: 'Cloud Migration Quote',customerId: customers[1].customerId },
        { title: 'Security Audit Quote', customerId: customers[2].customerId },
        { title: 'Data Pipeline Quote',  customerId: customers[3].customerId },
      ];

  const qDocs: any[] = [];
  for (const d of qoData) {
    const svc = [{ name: 'Service Fee', amount: 15000, count: 1 }];
    const amt = calcAmounts(svc);
    const q = await new NativeQuotation({
      ...d, tenantId, branchId,
      services: svc,
      parts: [],
      partsAmount: 0,
      discount: 0,
      gstPercentage: 18,
      ...amt,
      status: 'draft',
    }).save();
    qDocs.push(q);
    ok(`Quotation: ${d.title}`);
  }

  sec(`${label} — Contracts`);
  const ctData = isA
    ? [
        { title: 'Annual Civil Maintenance',  customerId: customers[0].customerId },
        { title: 'Electrical AMC',            customerId: customers[1].customerId },
        { title: 'Plumbing Service Contract', customerId: customers[2].customerId },
        { title: 'Interior Upkeep Contract',  customerId: customers[3].customerId },
      ]
    : [
        { title: 'Annual Dev Retainer',       customerId: customers[0].customerId },
        { title: 'Cloud Support Contract',    customerId: customers[1].customerId },
        { title: 'Security Monitoring AMC',   customerId: customers[2].customerId },
        { title: 'Data Analytics Retainer',   customerId: customers[3].customerId },
      ];

  const ctDocs: any[] = [];
  for (const d of ctData) {
    const svc = [{ name: 'Monthly Service', amount: 20000, count: 12 }];
    const amt = calcAmounts(svc);
    const ct = await new NativeContract({
      ...d, tenantId, branchId,
      services: svc,
      parts: [],
      partsAmount: 0,
      discount: 0,
      gstPercentage: 18,
      ...amt,
      status: 'active',
      startDate: new Date(),
      endDate:   new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    }).save();
    ctDocs.push(ct);
    ok(`Contract: ${d.title}`);
  }

  sec(`${label} — Invoices`);
  const invData = isA
    ? [
        { customerId: customers[0].customerId, desc: 'Foundation Work Invoice' },
        { customerId: customers[1].customerId, desc: 'Electrical Work Invoice' },
        { customerId: customers[2].customerId, desc: 'Plumbing Work Invoice' },
        { customerId: customers[3].customerId, desc: 'Interior Work Invoice' },
      ]
    : [
        { customerId: customers[0].customerId, desc: 'Development Invoice - Phase 1' },
        { customerId: customers[1].customerId, desc: 'Cloud Setup Invoice' },
        { customerId: customers[2].customerId, desc: 'Security Audit Invoice' },
        { customerId: customers[3].customerId, desc: 'Data Pipeline Invoice' },
      ];

  const invDocs: any[] = [];
  for (const d of invData) {
    const svc = [{ name: d.desc, amount: 25000, count: 1 }];
    const amt = calcAmounts(svc);
    const inv = await new NativeInvoice({
      tenantId, branchId,
      customerId: d.customerId,
      services: svc,
      parts: [],
      partsAmount: 0,
      discount: 0,
      gstPercentage: 18,
      ...amt,
      paid: false,
      status: 'sent',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).save();
    invDocs.push(inv);
    ok(`Invoice: ${d.desc}`);
  }

  sec(`${label} — Receipts`);
  for (let i = 0; i < 3; i++) {
    await new NativeReceipt({
      tenantId, branchId,
      invoiceId:  invDocs[i].invoiceId,
      customerId: customers[i].customerId,
      amount:     10000,
      paymentMethod: 'bank_transfer',
      paymentDate:   new Date(),
      status: 'completed',
    }).save();
    ok(`Receipt for invoice: ${invDocs[i].invoiceId}`);
  }

  sec(`${label} — Expenses`);
  const expData = isA
    ? [
        { title: 'Cement & Steel Purchase', amount: 45000, category: 'Materials' },
        { title: 'Equipment Rental',        amount: 18000, category: 'Equipment' },
        { title: 'Site Labour Wages',       amount: 32000, category: 'Labour' },
        { title: 'Transport & Logistics',   amount: 8500,  category: 'Transport' },
      ]
    : [
        { title: 'AWS Cloud Credits',        amount: 22000, category: 'Cloud' },
        { title: 'Software Licenses',        amount: 15000, category: 'Software' },
        { title: 'Developer Tools',          amount: 9500,  category: 'Tools' },
        { title: 'Team Training Program',    amount: 12000, category: 'Training' },
      ];

  for (const d of expData) {
    await new NativeExpense({ ...d, tenantId, branchId, date: new Date(), status: 'approved' }).save();
    ok(`Expense: ${d.title}`);
  }

  sec(`${label} — Activities`);
  const actData = isA
    ? [
        { type: 'visit', subject: 'Site Inspection — Block A',  description: 'Visited site for initial survey' },
        { type: 'call',  subject: 'Client Call — Kavitha Nair', description: 'Discussed project timeline' },
        { type: 'email', subject: 'Quotation Follow-up',        description: 'Sent revised quotation' },
        { type: 'note',  subject: 'Site Delay Note',            description: 'Rains delayed foundation work by 3 days' },
      ]
    : [
        { type: 'call',  subject: 'Sales Call — Rohan Mehta',   description: 'Discussed app requirements' },
        { type: 'email', subject: 'Project Kickoff Email',       description: 'Sent onboarding docs' },
        { type: 'task',  subject: 'Setup Dev Environment',       description: 'Configure staging servers' },
        { type: 'note',  subject: 'Client Feedback Note',        description: 'Client wants dark mode support' },
      ];

  for (const d of actData) {
    await new NativeActivity({ ...d, tenantId, branchId, status: 'completed', scheduledAt: new Date() }).save();
    ok(`Activity: ${d.subject}`);
  }

  sec(`${label} — Parts`);
  const partData = isA
    ? [
        { name: 'Steel Rebar 12mm',    partNumber: 'STL-RBR-12', price: 850,  unit: 'kg',    quantity: 500 },
        { name: 'PVC Pipe 4 inch',     partNumber: 'PVC-4IN',    price: 320,  unit: 'meter', quantity: 200 },
        { name: 'Circuit Breaker 30A', partNumber: 'CB-30A',     price: 1200, unit: 'piece', quantity: 50 },
        { name: 'Cement Bag 50kg',     partNumber: 'CEM-50KG',   price: 380,  unit: 'bag',   quantity: 1000 },
      ]
    : [
        { name: 'Network Switch 24P',  partNumber: 'NSW-24P',    price: 8500, unit: 'piece', quantity: 10 },
        { name: 'SSD 1TB NVMe',        partNumber: 'SSD-1TB',    price: 6200, unit: 'piece', quantity: 25 },
        { name: 'UPS 2KVA',            partNumber: 'UPS-2KVA',   price: 12000,unit: 'piece', quantity: 5 },
        { name: 'CAT6 Cable 305m',     partNumber: 'CAT6-305',   price: 4800, unit: 'roll',  quantity: 15 },
      ];

  for (const d of partData) {
    await new NativePart({ ...d, tenantId, branchId, status: 'active' }).save();
    ok(`Part: ${d.name}`);
  }

  sec(`${label} — Products`);
  const prodData = isA
    ? [
        { name: 'Ceramic Floor Tile 2x2', sku: 'TILE-2X2', costPrice: 45,   sellingPrice: 65,   stock: 5000, unit: 'sqft' },
        { name: 'Paint — White 20L',      sku: 'PAINT-W20',costPrice: 1800,  sellingPrice: 2200, stock: 200,  unit: 'can' },
        { name: 'Wooden Door Frame',      sku: 'DFR-WD',   costPrice: 3200,  sellingPrice: 4500, stock: 50,   unit: 'piece' },
        { name: 'Gypsum Ceiling Panel',   sku: 'GYP-CLG',  costPrice: 280,   sellingPrice: 380,  stock: 1000, unit: 'sqft' },
      ]
    : [
        { name: 'Dell Monitor 27"',       sku: 'MON-D27',  costPrice: 22000, sellingPrice: 27000,stock: 20,   unit: 'piece' },
        { name: 'Mechanical Keyboard',    sku: 'KBD-MCH',  costPrice: 3500,  sellingPrice: 4800, stock: 35,   unit: 'piece' },
        { name: 'Ergonomic Chair',        sku: 'CHR-ERG',  costPrice: 8500,  sellingPrice: 12000,stock: 15,   unit: 'piece' },
        { name: 'Webcam 4K',              sku: 'CAM-4K',   costPrice: 5200,  sellingPrice: 7200, stock: 25,   unit: 'piece' },
      ];

  for (const d of prodData) {
    await new NativeProduct({ ...d, tenantId, branchId, status: 'active' }).save();
    ok(`Product: ${d.name}`);
  }

  sec(`${label} — Assets`);
  const assetData = isA
    ? [
        { name: 'Tower Crane TC-200',   category: 'Heavy Equipment', serialNumber: 'TC200-001', condition: 'good',  status: 'in_use' },
        { name: 'Concrete Mixer CM-10', category: 'Heavy Equipment', serialNumber: 'CM10-001',  condition: 'fair',  status: 'active' },
        { name: 'Scaffolding Set A',    category: 'Tools',           serialNumber: 'SCAF-001A', condition: 'good',  status: 'active' },
      ]
    : [
        { name: 'Dell Server R740',     category: 'Servers',         serialNumber: 'SRV-R740-01', condition: 'new',  status: 'in_use' },
        { name: 'Cisco Router 4321',    category: 'Networking',      serialNumber: 'RTR-4321-01', condition: 'good', status: 'active' },
        { name: 'MacBook Pro 16" M3',   category: 'Laptops',         serialNumber: 'MBP16-M3-01', condition: 'new',  status: 'in_use' },
      ];

  for (const d of assetData) {
    await new NativeAsset({ ...d, tenantId, branchId, purchaseDate: new Date('2024-01-15') }).save();
    ok(`Asset: ${d.name}`);
  }

  sec(`${label} — Vehicles`);
  const vehData = isA
    ? [
        { name: 'Tata Truck TT-01', registrationNumber: 'DL 01 AB 1001', make: 'Tata', vehicleModel: 'LPT 1109', year: 2022, fuelType: 'diesel', status: 'active' },
        { name: 'JCB Excavator',    registrationNumber: 'DL 01 AB 1002', make: 'JCB',  vehicleModel: '3DX Plus',  year: 2021, fuelType: 'diesel', status: 'active' },
      ]
    : [
        { name: 'Toyota Innova TN-01', registrationNumber: 'TN 09 CX 2001', make: 'Toyota', vehicleModel: 'Innova Crysta', year: 2023, fuelType: 'diesel', status: 'active' },
        { name: 'Maruti Swift MH-01',  registrationNumber: 'MH 12 DX 3002', make: 'Maruti', vehicleModel: 'Swift Dzire',   year: 2022, fuelType: 'petrol', status: 'active' },
      ];

  for (const d of vehData) {
    await new NativeVehicle({ ...d, tenantId, branchId }).save();
    ok(`Vehicle: ${d.name}`);
  }
}

async function main() {
  console.log('\n🌱  Branch Seed — subcompany1 & subcompany2\n');

  await mongoose.connect(config.mongodb.uri, { maxPoolSize: 5 });
  console.log('✔  MongoDB connected');

  const branches = await Branch.find({
    branchName: { $in: ['subcompany1', 'subcompany2'] },
  }).lean();

  if (branches.length === 0) {
    console.error('❌  No branches named "subcompany1" or "subcompany2" found. Create them in FS Settings first.');
    process.exit(1);
  }

  for (const branch of branches) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏢  Seeding: ${branch.branchName}  (${branch._id})`);
    console.log(`${'═'.repeat(60)}`);
    await seedBranch(branch.tenantId as mongoose.Types.ObjectId, branch._id as mongoose.Types.ObjectId, branch.branchName);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('✅  All branch data seeded successfully!');
  console.log(`${'═'.repeat(60)}\n`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌  Seed failed:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
