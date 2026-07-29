import mongoose from 'mongoose';
import { Lead } from './lead.model';
import { createLead } from './lead.service';
import { LeadImportTriage } from './lead-import-triage.model';
import { decrypt, isEncrypted } from '../../../utils/crypto';

export interface ImportRow {
  firstName?: string;
  lastName?:  string;
  email?:     string;
  phone?:     string;
  mobile?:    string;
  company?:   string;
  designation?: string;
  source?:    string;
  status?:    string;
  city?:      string;
  state?:     string;
  country?:   string;
  leadOwner?: string;
  expectedRevenue?: string | number;
  tags?:      string;
  [key: string]: unknown;
}

export interface RejectedRow {
  row:    number;
  errors: string[];
  data:   ImportRow;
}

export interface ImportSummary {
  batchId:    string;
  total:      number;
  created:    number;
  duplicates: number;
  triage:     number;
  rejected:   RejectedRow[];
}

function normalizeEmail(email?: string): string {
  return (email ?? '').trim().toLowerCase();
}

function emailDomainOf(email?: string): string | null {
  const e = normalizeEmail(email);
  const at = e.indexOf('@');
  return at > 0 ? e.slice(at + 1) : null;
}

function normalizePhone(phone?: string): string {
  return (phone ?? '').replace(/\D/g, '');
}

/** Mandatory-field validation — a name plus at least one way to reach them. */
function validateRow(row: ImportRow): string[] {
  const errors: string[] = [];
  if (!row.firstName || !String(row.firstName).trim()) errors.push('firstName is required');
  const email = normalizeEmail(row.email as string | undefined);
  const phone = normalizePhone(row.phone as string | undefined);
  if (!email && !phone) errors.push('either email or phone is required');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email is not a valid format');
  return errors;
}

function toLeadPayload(tenantId: string, row: ImportRow, batchId: string, createdBy?: string) {
  return {
    tenantId,
    firstName:  String(row.firstName ?? '').trim(),
    lastName:   row.lastName ? String(row.lastName).trim() : undefined,
    email:      row.email ? String(row.email).trim() : undefined,
    phone:      row.phone ? String(row.phone).trim() : undefined,
    mobile:     row.mobile ? String(row.mobile).trim() : undefined,
    company:    row.company ? String(row.company).trim() : undefined,
    designation: row.designation ? String(row.designation).trim() : undefined,
    source:     row.source || 'csv',
    status:     row.status || undefined,
    city:       row.city ? String(row.city).trim() : undefined,
    state:      row.state ? String(row.state).trim() : undefined,
    country:    row.country ? String(row.country).trim() : undefined,
    leadOwner:  row.leadOwner ? String(row.leadOwner).trim() : undefined,
    expectedRevenue: row.expectedRevenue !== undefined && row.expectedRevenue !== '' ? Number(row.expectedRevenue) : undefined,
    tags:       row.tags ? String(row.tags).split(';').map((t) => t.trim()).filter(Boolean) : [],
    importBatchId: batchId,
    createdBy,
  };
}

/**
 * Bulk-imports Leads with real validation and duplicate detection — unlike
 * the generic File-dropdown import elsewhere (one blind POST per row), this:
 *  - rejects rows missing mandatory fields, reporting the exact reason per row
 *  - auto-skips EXACT email/phone duplicates (Lead.email is PII-encrypted at
 *    rest, so exact matching narrows by the unencrypted emailDomain index
 *    first, then decrypts just that small candidate set to compare)
 *  - routes same-domain-but-different-email rows to an Admin Triage queue
 *    instead of guessing whether they're a new contact at a known company
 *  - stamps every created Lead with a batchId for later audit/filtering
 */
export async function importLeadsCsv(tenantId: string, rows: ImportRow[], createdBy?: string): Promise<ImportSummary> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const batchId = new mongoose.Types.ObjectId().toString();
  const summary: ImportSummary = { batchId, total: rows.length, created: 0, duplicates: 0, triage: 0, rejected: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = validateRow(row);
    if (errors.length) {
      summary.rejected.push({ row: i + 1, errors, data: row });
      continue;
    }

    const email = normalizeEmail(row.email as string | undefined);
    const domain = emailDomainOf(row.email as string | undefined);
    const phoneNorm = normalizePhone(row.phone as string | undefined);

    let exactDuplicate = false;
    let domainCandidates: { _id: unknown; email?: string }[] = [];

    if (domain) {
      domainCandidates = await Lead.find({ tenantId: tid, emailDomain: domain }).select('_id email').lean();
      for (const c of domainCandidates) {
        const plain = c.email && isEncrypted(c.email) ? decrypt(c.email) : c.email;
        if (plain && normalizeEmail(plain) === email) { exactDuplicate = true; break; }
      }
    }
    if (!exactDuplicate && phoneNorm) {
      const phoneMatch = await Lead.findOne({ tenantId: tid, phoneSearch: phoneNorm }).select('_id').lean();
      if (phoneMatch) exactDuplicate = true;
    }

    if (exactDuplicate) {
      summary.duplicates++;
      continue;
    }

    if (domain && domainCandidates.length > 0) {
      await LeadImportTriage.create({
        tenantId: tid, batchId, rawRow: row, matchType: 'domain',
        matchedLeadIds: domainCandidates.map((c) => String(c._id)),
        status: 'pending',
      });
      summary.triage++;
      continue;
    }

    await createLead(toLeadPayload(tenantId, row, batchId, createdBy));
    summary.created++;
  }

  return summary;
}

export async function listTriageItems(tenantId: string, batchId?: string) {
  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(tenantId), status: 'pending' };
  if (batchId) filter.batchId = batchId;
  return LeadImportTriage.find(filter).sort({ createdAt: -1 }).lean();
}

export async function resolveTriageItem(
  tenantId: string,
  id: string,
  action: 'create' | 'skip',
  userId?: string,
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const item = await LeadImportTriage.findOne({ _id: id, tenantId: tid });
  if (!item) throw new Error('Triage item not found');
  if (item.status !== 'pending') throw new Error('This item has already been resolved');

  if (action === 'create') {
    await createLead(toLeadPayload(tenantId, item.rawRow as ImportRow, item.batchId, userId));
    item.status = 'created';
  } else {
    item.status = 'skipped';
  }
  item.resolvedAt = new Date();
  item.resolvedBy = userId;
  await item.save();
  return item;
}
