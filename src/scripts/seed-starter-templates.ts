/**
 * Seeds a "Classic (Starter)" PDF Designer template for every tenant/docType
 * combination that has NO designer templates yet. Non-default, so seeding never
 * changes any tenant's PDF output — it only gives them an editable starting
 * point in the designer.
 *
 * Idempotent: re-running adds nothing where a template (any template) exists.
 *
 * Run with: npx ts-node --project tsconfig.json src/scripts/seed-starter-templates.ts
 */
import mongoose from 'mongoose';
import { config } from '../config';
import { Tenant } from '../modules/tenants/tenant.model';
import { CustomTemplate, TemplateDocType } from '../modules/native-crm/custom-templates/custom-template.model';
import { buildStarterElements, STARTER_PAGE, STARTER_NAME } from '../modules/native-crm/custom-templates/starter-templates';

const DOC_TYPES: TemplateDocType[] = ['invoice', 'quotation', 'contract', 'workorder'];

async function run() {
  await mongoose.connect(config.mongodb.uri);
  console.log('Connected to MongoDB');

  const tenants = await Tenant.find({}).select('_id name').lean();
  console.log(`Tenants: ${tenants.length}`);

  let created = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    for (const docType of DOC_TYPES) {
      const exists = await CustomTemplate.exists({ tenantId: tenant._id, docType });
      if (exists) { skipped++; continue; }
      await CustomTemplate.create({
        tenantId:  tenant._id,
        docType,
        name:      STARTER_NAME,
        isDefault: false,
        elements:  buildStarterElements(docType),
        page:      STARTER_PAGE,
      });
      created++;
      console.log(`  + ${tenant.name ?? tenant._id} / ${docType}`);
    }
  }

  console.log(`Done. Created ${created}, skipped ${skipped} (already had templates).`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
