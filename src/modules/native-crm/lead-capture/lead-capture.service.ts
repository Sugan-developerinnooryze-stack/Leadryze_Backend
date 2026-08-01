import mongoose from 'mongoose';
import { LeadCapture, INormalizedCaptureFields } from './lead-capture.model';
import { CaptureLeadInput, LeadCaptureListOptions } from './lead-capture.types';
import { createLead } from '../leads/lead.service';
import { runAutomationsOnCreate } from '../automation-rules/automation-rule.service';
import { NativeTimeline } from '../timeline/timeline.model';

function firstNonEmpty(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Best-effort mapping of an arbitrary scraped payload onto Lead's one hard
 * requirement (firstName). A small, defensive alias list — real per-site
 * extraction intelligence belongs in the browser extension's own Provider
 * implementations; this is a last-mile safety net, not a scraper. Returns
 * null when no name-shaped field exists at all, since Lead's firstName
 * can't be fabricated. */
export function normalizeCaptureRaw(raw: Record<string, any>): INormalizedCaptureFields | null {
  const email   = firstNonEmpty(raw.email, raw.emailAddress, raw.email_address);
  const phone   = firstNonEmpty(raw.phone, raw.phoneNumber, raw.phone_number, raw.mobile);
  const company = firstNonEmpty(raw.company, raw.companyName, raw.company_name, raw.organization, raw.organization_name);
  const title   = firstNonEmpty(raw.title, raw.jobTitle, raw.job_title, raw.headline, raw.designation);

  let firstName = firstNonEmpty(raw.firstName, raw.first_name, raw.firstname);
  let lastName  = firstNonEmpty(raw.lastName, raw.last_name, raw.lastname);

  if (!firstName) {
    const full = firstNonEmpty(raw.fullName, raw.full_name, raw.name, raw.displayName, raw.display_name);
    if (full) {
      const parts = full.split(/\s+/).filter(Boolean);
      firstName = parts[0];
      if (!lastName && parts.length > 1) lastName = parts.slice(1).join(' ');
    }
  }

  if (!firstName) return null;
  return { firstName, lastName, email, phone, company, title };
}

export async function captureLeadFromExternalSource(
  tenantId: string,
  branchId: string | null | undefined,
  userId: string,
  userEmail: string | undefined,
  input: CaptureLeadInput,
) {
  const tid = new mongoose.Types.ObjectId(tenantId);

  // Write the audit doc FIRST, status:'pending' — a crash mid-flight, or a
  // raw payload with no usable name, still leaves evidence this capture
  // request was received, not silently dropped.
  const capture = await LeadCapture.create({
    tenantId: tid,
    branchId: branchId ? new mongoose.Types.ObjectId(branchId) : null,
    platform: input.platform,
    sourceUrl: input.sourceUrl,
    raw: input.raw,
    status: 'pending',
    capturedByUserId: userId,
    capturedByEmail: userEmail,
    extensionVersion: input.extensionVersion,
  });

  const normalized = normalizeCaptureRaw(input.raw);

  if (!normalized) {
    capture.status = 'failed';
    capture.failureReason = 'No firstName/lastName/fullName-shaped field present in the captured payload';
    await capture.save();
    return { capture, lead: null };
  }
  capture.normalized = normalized;

  // Identical call shape to lead.controller.ts's own create() — same
  // function, same fields, so a captured Lead is indistinguishable in the
  // database from one entered by hand. `source` maps to the platform where
  // Lead.model.ts's own LeadSource union already has a matching value
  // ('chatbot' for the AI widget); every other platform falls back to the
  // generic 'api' value, same as before this mapping existed.
  const lead = await createLead({
    tenantId,
    branchId: branchId ?? null,
    firstName:   normalized.firstName,
    lastName:    normalized.lastName,
    email:       normalized.email,
    phone:       normalized.phone,
    company:     normalized.company,
    designation: normalized.title,
    source:      input.platform === 'chatbot' ? 'chatbot' : 'api',
    createdBy:   userId,
    lastActivityAt: new Date(),
    leadOwnerStaffId: input.assignedStaffId,
    leadOwner:        input.assignedStaffName,
    customFields: {
      _leadCaptureId:   String(capture._id),
      _capturePlatform: input.platform,
    },
  });

  await NativeTimeline.create({
    tenantId:     tid,
    entityModule: 'leads',
    entityId:     lead._id.toString(),
    action:       'created',
    description:  `Lead ${lead.leadId} captured via ${input.platform}`,
    performedBy:  userId,
    metadata:     { leadCaptureId: capture._id, capturePlatform: input.platform },
  });

  runAutomationsOnCreate(tenantId, 'lead', lead.toObject()).catch(() => {});

  capture.status = 'created';
  capture.leadId = lead._id as mongoose.Types.ObjectId;
  await capture.save();

  return { capture, lead };
}

function buildCaptureFilter(tenantId: string, opts: LeadCaptureListOptions): Record<string, any> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, any> = { tenantId: tid };

  if (opts.platform)         filter.platform = opts.platform;
  if (opts.status)           filter.status = opts.status;
  if (opts.capturedByUserId) filter.capturedByUserId = opts.capturedByUserId;
  if (opts.startDate || opts.endDate) {
    filter.createdAt = {};
    if (opts.startDate) filter.createdAt.$gte = new Date(opts.startDate);
    if (opts.endDate)   filter.createdAt.$lte = new Date(opts.endDate);
  }
  return filter;
}

export async function listLeadCaptures(tenantId: string, opts: LeadCaptureListOptions) {
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter = buildCaptureFilter(tenantId, opts);

  const [items, total] = await Promise.all([
    LeadCapture.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    LeadCapture.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}
