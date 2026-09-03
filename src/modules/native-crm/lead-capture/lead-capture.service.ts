import mongoose from 'mongoose';
import { LeadCapture, INormalizedCaptureFields } from './lead-capture.model';
import { CaptureLeadInput, LeadCaptureListOptions } from './lead-capture.types';
import { createLead } from '../leads/lead.service';
import { Lead, LeadRating } from '../leads/lead.model';
import { runAutomationsOnCreate } from '../automation-rules/automation-rule.service';
import { NativeTimeline } from '../timeline/timeline.model';
import { resolveTeamFromStaffId } from '../shared/team-resolution';
import { sendChatbotLeadEmails } from './chatbot-lead-email.service';

function firstNonEmpty(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** buyingIntent ('low'|'medium'|'high') -> Lead.rating ('cold'|'warm'|'hot') —
 * the two concepts are the same signal under different names in different
 * parts of the codebase (AI service vs. CRM), so this is a direct 1:1 map,
 * not a lossy simplification. */
const BUYING_INTENT_TO_RATING: Record<'low' | 'medium' | 'high', 'cold' | 'warm' | 'hot'> = {
  low: 'cold', medium: 'warm', high: 'hot',
};

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
  const service = firstNonEmpty(raw.service, raw.interestedService, raw.interested_service, raw.topic);

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
  return { firstName, lastName, email, phone, company, title, service };
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
  const { teamId, teamName } = await resolveTeamFromStaffId(tenantId, input.assignedStaffId);

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
    teamId:    teamId ?? undefined,
    teamName:  teamName ?? undefined,
    interestedServices: normalized.service ? [normalized.service] : undefined,
    // AI-computed conversation signals — only ever present for platform
    // 'chatbot' (see CaptureLeadInput's own doc comment); every other
    // capture path (browser extension) leaves all of these undefined,
    // exactly as before this field set existed.
    score:  input.leadScore,
    rating: input.buyingIntent ? BUYING_INTENT_TO_RATING[input.buyingIntent] : undefined,
    requirement: input.requirement ?? input.conversationSummary,
    conversationSummary: input.conversationSummary,
    interestedItems: input.interestedItems,
    // Flattened alongside interestedItems (not instead of it) so existing
    // UI/exports that already read the plain-string interestedProducts
    // field keep showing something meaningful.
    interestedProducts: input.interestedItems?.map((i) => i.title),
    chatSessionId: input.chatSessionId,
    sourceUrl: input.sourceUrl,
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

  // A real round-robin/team assignment happened (not every capture has
  // one — e.g. a browser-extension capture with no configured team) —
  // record it as its own step in the Lead's own assignment history, giving
  // the exact "AI Widget -> Team -> Staff" trail requested, distinct from
  // the plain "created" entry above.
  if (input.assignedStaffId) {
    await NativeTimeline.create({
      tenantId:     tid,
      entityModule: 'leads',
      entityId:     lead._id.toString(),
      action:       'assigned',
      description:  teamName
        ? `${input.platform === 'chatbot' ? 'AI Widget' : input.platform} → ${teamName} → ${input.assignedStaffName ?? input.assignedStaffId}`
        : `${input.platform === 'chatbot' ? 'AI Widget' : input.platform} → Round Robin → ${input.assignedStaffName ?? input.assignedStaffId}`,
      performedBy:  userId,
      metadata:     { staffId: input.assignedStaffId, staffName: input.assignedStaffName, teamId, teamName },
    });
  }

  runAutomationsOnCreate(tenantId, 'lead', lead.toObject()).catch(() => {});

  // Customer confirmation + salesperson alert — chatbot-specific (the
  // browser extension's own captures never trigger this), fire-and-forget
  // from THIS function's perspective (never awaited/blocking the response),
  // but every send attempt is tracked in EmailLog, not silently lost — see
  // sendChatbotLeadEmails()'s own doc comment.
  if (input.platform === 'chatbot') {
    // Pass the PLAINTEXT email explicitly — `lead` here is the Mongoose
    // document Lead.create() just returned, and Lead's own pre('save') hook
    // (encryptPIIFields) has already mutated this same in-memory instance's
    // `.email` to ciphertext by the time we get here. `normalized.email` is
    // the one plaintext copy still in scope, captured before any encryption
    // ever touched it. Confirmed live: without this, the customer
    // confirmation email was sent to the ciphertext string as the "to"
    // address and Brevo correctly rejected it (400).
    sendChatbotLeadEmails(tenantId, { ...lead.toObject(), email: normalized.email }).catch(() => {});
  }

  capture.status = 'created';
  capture.leadId = lead._id as mongoose.Types.ObjectId;
  await capture.save();

  return { capture, lead };
}

const RATING_RANK: Record<LeadRating, number> = { cold: 0, warm: 1, hot: 2 };

export interface ChatbotLeadEnrichment {
  leadScore?: number;
  buyingIntent?: 'low' | 'medium' | 'high';
  interestedItems?: Array<{ datasetId: string; datasetVersion: number; recordId: string; title: string }>;
  requirement?: string;
  conversationSummary?: string;
}

/** Enriches an ALREADY-CREATED chatbot Lead as buying intent/interest grows
 * later in the same session — the backend counterpart to the AI service's
 * updateLeadFromWidget() call, which previously 404'd (no such endpoint
 * existed). Every numeric/tiered signal only ever moves UP, matching the
 * AI side's own "intent only escalates within a session" comment on that
 * call — a later, weaker signal (e.g. a tangent message that reads as lower
 * intent than the "Request Quote" click that already happened) must never
 * downgrade a Lead a salesperson may already be acting on. */
export async function enrichChatbotLead(
  tenantId: string,
  leadId: string,
  enrichment: ChatbotLeadEnrichment,
): Promise<{ notFound: true } | { notFound: false; lead: any }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const lead = await Lead.findOne({ _id: leadId, tenantId: tid });
  if (!lead) return { notFound: true };

  if (enrichment.leadScore !== undefined) {
    lead.score = Math.max(lead.score ?? 0, enrichment.leadScore);
  }
  if (enrichment.buyingIntent) {
    const incomingRating = BUYING_INTENT_TO_RATING[enrichment.buyingIntent];
    if (RATING_RANK[incomingRating] > RATING_RANK[lead.rating ?? 'cold']) {
      lead.rating = incomingRating;
    }
  }
  if (enrichment.interestedItems?.length) {
    const existing = lead.interestedItems ?? [];
    for (const item of enrichment.interestedItems) {
      if (!existing.some((e) => e.datasetId === item.datasetId && e.recordId === item.recordId)) {
        existing.push(item);
      }
    }
    lead.interestedItems = existing;
    lead.interestedProducts = existing.map((i) => i.title);
  }
  if (enrichment.requirement) lead.requirement = enrichment.requirement;
  if (enrichment.conversationSummary) lead.conversationSummary = enrichment.conversationSummary;
  lead.lastActivityAt = new Date();

  await lead.save();
  return { notFound: false, lead };
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
