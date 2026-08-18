import mongoose from 'mongoose';
import { getLeadRaw } from './lead.service';
import { Contact }        from '../contacts/contact.model';
import { Deal }           from '../deals/deal.model';
import { NativeCustomer } from '../customers/customer.model';
import { logTimeline }    from '../timeline/timeline.service';
import { getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';
import { runAutomations } from '../automation-rules/automation-rule.service';

const CONTACT_SOURCE_MAP: Record<string, string> = {
  website: 'website', referral: 'referral', social: 'social',
  email: 'email', landing_page: 'website', google: 'website',
  facebook: 'social', whatsapp: 'other', chatbot: 'other',
  manual: 'other', csv: 'other', api: 'other', other: 'other',
};

export async function convertLeadToContact(
  tenantId: mongoose.Types.ObjectId,
  leadId:   string,
  performedBy: string,
) {
  const lead = await getLeadRaw(leadId, tenantId.toString());
  if (!lead) throw new Error('Lead not found');

  const alreadyDone = lead.conversionHistory?.some((h) => h.type === 'contact');
  if (alreadyDone) throw new Error('Lead has already been converted to a Contact');

  const contact = await Contact.create({
    tenantId,
    firstName:      lead.firstName,
    lastName:       lead.lastName || '',
    email:          lead.email || '',
    phone:          lead.phone || lead.mobile || '',
    company:        lead.company,
    jobTitle:       lead.designation,
    source:         CONTACT_SOURCE_MAP[lead.source] ?? 'other',
    status:         'contact',
    lifecycleStage: 'sales_qualified_lead',
    notes:          `Created from Lead ${lead.leadId}`,
    tags:           lead.tags ?? [],
    leadId:         lead._id.toString(),
    createdBy:      performedBy,
  });

  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  lead.contactId      = contact._id.toString();
  lead.isConverted    = true;
  lead.lastActivityAt = new Date();
  (lead.conversionHistory as any[]).push({ type: 'contact', entityId: contact._id.toString(), name, createdAt: new Date(), createdBy: performedBy });
  await lead.save();

  logTimeline(tenantId, 'leads', lead._id.toString(), 'status_changed',
    `Converted to Contact: ${name}`, performedBy,
    { type: 'contact', entityId: contact._id.toString() },
  ).catch(() => {});

  return { lead, contact };
}

export async function convertLeadToOpportunity(
  tenantId: mongoose.Types.ObjectId,
  leadId:   string,
  performedBy: string,
) {
  const lead = await getLeadRaw(leadId, tenantId.toString());
  if (!lead) throw new Error('Lead not found');

  const alreadyDone = lead.conversionHistory?.some((h) => h.type === 'opportunity');
  if (alreadyDone) throw new Error('Lead has already been converted to an Opportunity');

  const title = `${[lead.firstName, lead.lastName].filter(Boolean).join(' ')} - ${lead.company || 'Opportunity'}`;

  const deal = await Deal.create({
    tenantId,
    title,
    amount:      lead.expectedRevenue,
    stage:       'prospect',
    closeDate:   lead.expectedCloseDate,
    contactName: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    companyName: lead.company,
    notes:       `Created from Lead ${lead.leadId}`,
    leadId:      lead._id.toString(),
    contactId:   lead.contactId ?? '',
    createdBy:   performedBy,
  });

  lead.opportunityId  = deal._id.toString();
  lead.isConverted    = true;
  lead.lastActivityAt = new Date();
  (lead.conversionHistory as any[]).push({ type: 'opportunity', entityId: deal._id.toString(), name: title, createdAt: new Date(), createdBy: performedBy });
  await lead.save();

  logTimeline(tenantId, 'leads', lead._id.toString(), 'status_changed',
    `Converted to Opportunity: ${title}`, performedBy,
    { type: 'opportunity', entityId: deal._id.toString() },
  ).catch(() => {});

  return { lead, deal };
}

export async function convertLeadToCustomer(
  tenantId: mongoose.Types.ObjectId,
  leadId:   string,
  performedBy: string,
) {
  const lead = await getLeadRaw(leadId, tenantId.toString());
  if (!lead) throw new Error('Lead not found');

  const alreadyDone = lead.conversionHistory?.some((h) => h.type === 'customer');
  if (alreadyDone) throw new Error('Lead has already been converted to a Customer');

  const customer = await NativeCustomer.create({
    tenantId,
    name:        [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    company:     lead.company,
    designation: lead.designation,
    email:       lead.email,
    phone:       lead.phone,
    mobile:      lead.mobile,
    website:     lead.website,
    address:     lead.address,
    city:        lead.city,
    state:       lead.state,
    country:     lead.country,
    postcode:    lead.postalCode,
    notes:       `Converted from Lead ${lead.leadId}`,
    tags:        lead.tags ?? [],
    status:      'active',
    leadId:      lead._id.toString(),
    opportunityId: lead.opportunityId ?? '',
    // Auto-carries the Lead's own owner forward so the new Customer starts
    // out correctly scoped for the same Manager/Agent who already had this
    // Lead in their filtered view — not required, a Customer created some
    // other way just has no owner until one is explicitly set.
    assignedStaffId: lead.leadOwnerStaffId,
    createdBy:   performedBy,
  });

  // The single, canonical conversion path — also moves the Lead's own
  // pipeline stage to "won" and fires the exact same side effects (auto-lock
  // if configured, automation rules) the dedicated PATCH .../stage endpoint
  // already produces for a manual drag-to-Won, so a full conversion behaves
  // identically from a side-effects standpoint either way. Previously this
  // was a separate, incomplete implementation (lead.controller.ts's own
  // convertLead()) that set the stage but never these back-references —
  // that duplicate now delegates here instead of re-implementing any of it.
  const wonKey = await getOutcomeStageKey(tenantId.toString(), 'lead', 'won', 'won');
  lead.isConverted         = true;
  lead.convertedCustomerId = customer.customerId;
  lead.convertedAt         = new Date();
  lead.status              = wonKey;
  lead.lastActivityAt      = new Date();
  (lead.conversionHistory as any[]).push({ type: 'customer', entityId: customer._id.toString(), name: customer.name, createdAt: new Date(), createdBy: performedBy });
  await lead.save();

  autoLockIfConfigured(tenantId.toString(), 'leads', lead._id.toString(), wonKey, performedBy).catch(() => {});
  runAutomations(tenantId.toString(), 'lead', lead.toObject(), wonKey).catch(() => {});

  // 'converted' — a distinct action from 'status_changed', so the Lead's own
  // Assignment/Activity History reads as a clear, final "Lead converted ->
  // Customer" step (per the requested AI Widget -> Team -> Staff ->
  // ... -> Converted trail), not lumped in with an ordinary stage move.
  logTimeline(tenantId, 'leads', lead._id.toString(), 'converted',
    `Lead converted → Customer: ${customer.customerId}`, performedBy,
    { type: 'customer', entityId: customer._id.toString(), customerId: customer.customerId },
  ).catch(() => {});

  return { lead, customer };
}
