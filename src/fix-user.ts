import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from './config';
import { Tenant } from './modules/tenants/tenant.model';
import { User } from './modules/auth/auth.model';

const TARGET_EMAIL = 'suganth2501@gmail.com';
const TARGET_PASSWORD = '123456789';

async function fixUser() {
  console.log('\n🔧  LeadRyze — Fix user account\n');

  await mongoose.connect(config.mongodb.uri);
  console.log('  Connected to MongoDB:', config.mongodb.uri, '\n');

  const hashedPwd = await bcrypt.hash(TARGET_PASSWORD, 12);

  // Find first available tenant to attach the user to
  let tenant = await Tenant.findOne({ isActive: true });
  if (!tenant) {
    console.log('  No active tenant found — creating a default one...');
    tenant = await Tenant.create({
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
      branding: { primaryColor: '#2563eb', companyName: 'LeadRyze Demo Co.' },
      aiConfig: { agentName: 'LeadBot', language: 'en', fallbackToHuman: true },
    });
    console.log(`  Created tenant: "${tenant.name}"`);
  } else {
    console.log(`  Using tenant: "${tenant.name}" (${tenant._id})`);
  }

  const existing = await User.findOne({ email: TARGET_EMAIL });

  if (existing) {
    // Update: set emailVerified + reset password
    await User.updateOne(
      { _id: existing._id },
      {
        $set: {
          password: hashedPwd,
          emailVerified: true,
          isActive: true,
        },
      }
    );
    console.log(`  ✔  Updated existing user: ${TARGET_EMAIL}`);
    console.log(`     Role: ${existing.role}`);
  } else {
    // Create new TENANT_ADMIN user
    await User.create({
      email: TARGET_EMAIL,
      password: hashedPwd,
      firstName: 'Suganth',
      lastName: 'User',
      role: 'TENANT_ADMIN',
      tenantId: tenant._id,
      isActive: true,
      emailVerified: true,
    });
    console.log(`  ✔  Created new user: ${TARGET_EMAIL}`);
    console.log(`     Role: TENANT_ADMIN`);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('  Login credentials');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Email    : ${TARGET_EMAIL}`);
  console.log(`  Password : ${TARGET_PASSWORD}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  Frontend : http://localhost:3000');
  console.log('─'.repeat(50) + '\n');

  await mongoose.disconnect();
}

fixUser().catch((err) => {
  console.error('\n❌  Fix failed:', err.message);
  process.exit(1);
});
