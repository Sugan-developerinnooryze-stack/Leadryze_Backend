import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from './config';

// ── Models ──────────────────────────────────────────────────────────────────
import { Tenant } from './modules/tenants/tenant.model';
import { User } from './modules/auth/auth.model';

// ── Helpers ─────────────────────────────────────────────────────────────────
const hash = (pw: string) => bcrypt.hash(pw, 12);
const log  = (msg: string) => console.log(`  ✔  ${msg}`);

async function seed() {
  console.log('\n🌱  LeadRyze AI — Seeding database...\n');

  await mongoose.connect(config.mongodb.uri);
  console.log('  Connected to MongoDB\n');

  // ── 1. Wipe existing seed data ───────────────────────────────────────────
  await Tenant.deleteMany({ slug: { $in: ['leadryze-demo', 'acme-corp'] } });
  await User.deleteMany({ email: { $in: [
    'admin@leadryze.ai',
    'tenant@leadryze.ai',
    'manager@leadryze.ai',
    'agent@leadryze.ai',
  ]}});
  log('Cleared previous seed data');

  // ── 2. Tenants ───────────────────────────────────────────────────────────
  const demoTenant = await Tenant.create({
    name: 'LeadRyze Demo',
    slug: 'leadryze-demo',
    plan: 'enterprise',
    isActive: true,
    settings: {
      allowedChannels: ['web', 'whatsapp', 'email', 'sms', 'instagram'],
      maxUsers: 50,
      maxLeadsPerMonth: 10000,
      timezone: 'Asia/Singapore',
      language: 'en',
      crmOption: 'no_crm',
    },
    branding: {
      primaryColor: '#2563eb',
      companyName: 'LeadRyze Demo Co.',
    },
    aiConfig: {
      agentName: 'LeadBot',
      language: 'en',
      fallbackToHuman: true,
      systemPrompt: 'You are LeadBot, a friendly AI assistant for LeadRyze Demo Co. Help capture leads and answer questions about our services.',
    },
  });
  log(`Tenant created: "${demoTenant.name}" (id: ${demoTenant._id})`);

  const acmeTenant = await Tenant.create({
    name: 'Acme Corp',
    slug: 'acme-corp',
    plan: 'professional',
    isActive: true,
    settings: {
      allowedChannels: ['web', 'whatsapp', 'email'],
      maxUsers: 10,
      maxLeadsPerMonth: 2000,
      timezone: 'Asia/Kuala_Lumpur',
      language: 'en',
      crmOption: 'no_crm',
    },
    branding: {
      primaryColor: '#7c3aed',
      companyName: 'Acme Corp',
    },
    aiConfig: {
      agentName: 'Aria',
      language: 'en',
      fallbackToHuman: true,
    },
  });
  log(`Tenant created: "${acmeTenant.name}" (id: ${acmeTenant._id})`);

  // ── 3. Users ─────────────────────────────────────────────────────────────
  const tenantId = demoTenant._id as mongoose.Types.ObjectId;

  const users = await User.insertMany([
    {
      email: 'admin@leadryze.ai',
      password: await hash('Admin@123'),
      firstName: 'Super',
      lastName: 'Admin',
      role: 'SUPER_ADMIN',
      tenantId,
      isActive: true,
      emailVerified: true,
    },
    {
      email: 'tenant@leadryze.ai',
      password: await hash('Tenant@123'),
      firstName: 'Tenant',
      lastName: 'Admin',
      role: 'TENANT_ADMIN',
      tenantId,
      isActive: true,
      emailVerified: true,
    },
    {
      email: 'manager@leadryze.ai',
      password: await hash('Manager@123'),
      firstName: 'Sales',
      lastName: 'Manager',
      role: 'MANAGER',
      tenantId,
      isActive: true,
      emailVerified: true,
    },
    {
      email: 'agent@leadryze.ai',
      password: await hash('Agent@123'),
      firstName: 'AI',
      lastName: 'Agent',
      role: 'AGENT',
      tenantId,
      isActive: true,
      emailVerified: true,
    },
  ]);
  log(`Created ${users.length} users`);

  // ── 4. Dynamic model seeding (customers, templates, campaigns) ───────────
  // Load models after connection to avoid registration issues
  const customerModel = mongoose.modelNames().includes('Customer')
    ? mongoose.model('Customer')
    : (() => {
        const s = new mongoose.Schema({
          tenantId: mongoose.Schema.Types.ObjectId,
          name: String, email: String, phone: String,
          channel: { type: String, default: 'web' },
          status: { type: String, default: 'new' },
          tags: [String],
          notes: String,
          customFields: mongoose.Schema.Types.Mixed,
          isActive: { type: Boolean, default: true },
        }, { timestamps: true });
        return mongoose.model('Customer', s);
      })();

  await customerModel.deleteMany({ tenantId });

  await customerModel.insertMany([
    { tenantId, name: 'Ahmad Razif',   email: 'ahmad@example.com',  phone: '+601112345678', channel: 'whatsapp', status: 'qualified', tags: ['hot-lead', 'enterprise'] },
    { tenantId, name: 'Priya Nair',    email: 'priya@example.com',  phone: '+601223456789', channel: 'web',      status: 'new',       tags: ['inquiry'] },
    { tenantId, name: 'Tan Wei Liang', email: 'weilian@example.com',phone: '+601334567890', channel: 'email',    status: 'booked',    tags: ['demo-scheduled'] },
    { tenantId, name: 'Siti Rahimah',  email: 'siti@example.com',   phone: '+601445678901', channel: 'instagram',status: 'contacted', tags: ['sme'] },
    { tenantId, name: 'Raj Kumar',     email: 'raj@example.com',    phone: '+601556789012', channel: 'whatsapp', status: 'new',       tags: ['startup'] },
    { tenantId, name: 'Li Mei',        email: 'limei@example.com',  phone: '+601667890123', channel: 'web',      status: 'qualified', tags: ['hot-lead'] },
    { tenantId, name: 'Hassan Omar',   email: 'hassan@example.com', phone: '+601778901234', channel: 'sms',      status: 'closed',    tags: ['converted'] },
    { tenantId, name: 'Kavitha S.',    email: 'kavitha@example.com',phone: '+601889012345', channel: 'web',      status: 'lost',      tags: ['price-sensitive'] },
  ]);
  log('Created 8 sample customers');

  // Templates
  const templateModel = mongoose.modelNames().includes('Template')
    ? mongoose.model('Template')
    : (() => {
        const s = new mongoose.Schema({
          tenantId: mongoose.Schema.Types.ObjectId,
          name: String, type: String, channel: String,
          subject: String, body: String,
          variables: [String],
          language: { type: String, default: 'en' },
          isActive: { type: Boolean, default: true },
        }, { timestamps: true });
        return mongoose.model('Template', s);
      })();

  await templateModel.deleteMany({ tenantId });

  await templateModel.insertMany([
    {
      tenantId,
      name: 'WhatsApp Welcome',
      type: 'welcome',
      channel: 'whatsapp',
      body: 'Hi {{name}}! 👋 Welcome to {{companyName}}. I\'m {{agentName}}, your AI assistant. How can I help you today?',
      variables: ['name', 'companyName', 'agentName'],
    },
    {
      tenantId,
      name: 'Lead Follow-up Day 1',
      type: 'followup',
      channel: 'whatsapp',
      body: 'Hi {{name}}, just checking in! Did you get a chance to review the information I shared yesterday? Happy to answer any questions. 😊',
      variables: ['name'],
    },
    {
      tenantId,
      name: 'Appointment Confirmation',
      type: 'appointment',
      channel: 'email',
      subject: 'Your appointment is confirmed — {{date}} at {{time}}',
      body: 'Dear {{name}},\n\nYour appointment with {{companyName}} is confirmed for {{date}} at {{time}}.\n\nLocation: {{location}}\n\nSee you then!\n\nBest regards,\n{{agentName}}',
      variables: ['name', 'companyName', 'date', 'time', 'location', 'agentName'],
    },
    {
      tenantId,
      name: 'Promotional Blast',
      type: 'marketing',
      channel: 'whatsapp',
      body: '🎉 Special offer for you, {{name}}! Get {{discount}}% off our {{service}} this week only. Reply YES to claim your offer!',
      variables: ['name', 'discount', 'service'],
    },
    {
      tenantId,
      name: 'Feedback Request',
      type: 'feedback',
      channel: 'whatsapp',
      body: 'Hi {{name}}! Thank you for choosing {{companyName}} 🙏 How was your experience? Rate us 1-5 ⭐',
      variables: ['name', 'companyName'],
    },
  ]);
  log('Created 5 message templates');

  // Campaigns
  const campaignModel = mongoose.modelNames().includes('Campaign')
    ? mongoose.model('Campaign')
    : (() => {
        const s = new mongoose.Schema({
          tenantId: mongoose.Schema.Types.ObjectId,
          name: String, type: String, channel: String,
          status: { type: String, default: 'draft' },
          stats: { sent: Number, delivered: Number, replied: Number, converted: Number },
          isActive: { type: Boolean, default: true },
        }, { timestamps: true });
        return mongoose.model('Campaign', s);
      })();

  await campaignModel.deleteMany({ tenantId });

  await campaignModel.insertMany([
    {
      tenantId,
      name: 'June WhatsApp Blast',
      type: 'broadcast',
      channel: 'whatsapp',
      status: 'completed',
      stats: { sent: 250, delivered: 241, replied: 67, converted: 18 },
    },
    {
      tenantId,
      name: 'New Lead Nurture Sequence',
      type: 'drip',
      channel: 'email',
      status: 'active',
      stats: { sent: 88, delivered: 85, replied: 23, converted: 9 },
    },
    {
      tenantId,
      name: 'Re-engagement SMS',
      type: 'reengagement',
      channel: 'sms',
      status: 'draft',
      stats: { sent: 0, delivered: 0, replied: 0, converted: 0 },
    },
  ]);
  log('Created 3 sample campaigns');

  // ── 5. Summary ───────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(55));
  console.log('  🎉  Seed complete!\n');
  console.log('  LOGIN CREDENTIALS');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  Role          Email                    Password');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  SUPER_ADMIN   admin@leadryze.ai        Admin@123');
  console.log('  TENANT_ADMIN  tenant@leadryze.ai       Tenant@123');
  console.log('  MANAGER       manager@leadryze.ai      Manager@123');
  console.log('  AGENT         agent@leadryze.ai        Agent@123');
  console.log('  ─────────────────────────────────────────────────');
  console.log(`\n  Tenant ID: ${tenantId}`);
  console.log('  Frontend:  http://localhost:3000');
  console.log('  Backend:   http://localhost:5000');
  console.log('  Swagger:   http://localhost:5000/api-docs');
  console.log('─'.repeat(55) + '\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('\n❌  Seed failed:', err.message);
  process.exit(1);
});
