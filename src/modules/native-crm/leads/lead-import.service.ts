import mongoose from 'mongoose';
import { Lead } from './lead.model';
import { createLead } from './lead.service';
import { LeadImportTriage } from './lead-import-triage.model';
import { decrypt, isEncrypted } from '../../../utils/crypto';

import { findDuplicateContact } from '../shared/duplicate-check';
import { PHONE_FORMAT_REGEX } from './lead.validation';

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

/** LR-IMP-001: a row skipped as a duplicate, and the lead it matched. */
export interface DuplicateRow {
  row:          number;
  matchedId:    string;
  matchedLabel: string;
}

export interface ImportSummary {
  batchId:    string;
  total:      number;
  created:    number;
  duplicates: number;
  duplicateRows: DuplicateRow[];
  triage:     number;
  rejected:   RejectedRow[];
}

function normalizeEmail(email?: unknown): string {
  return (email != null ? String(email) : '').trim().toLowerCase();
}

function emailDomainOf(email?: unknown): string | null {
  const e = normalizeEmail(email);
  const at = e.indexOf('@');
  return at > 0 ? e.slice(at + 1) : null;
}

// LR-C4-IMP-003: Safely handle numeric phone from CSV/XLSX imports (e.g. 9876543210 as number)
function normalizePhone(phone?: unknown): string {
  return (phone != null ? String(phone) : '').replace(/\D/g, '');
}

/** Mandatory-field validation — a name, contact method, and valid expectedRevenue. */
function validateRow(row: ImportRow): string[] {
  const errors: string[] = [];
  if (!row.firstName || !String(row.firstName).trim()) errors.push('firstName is required');
  const email = normalizeEmail(row.email);
  const phone = normalizePhone(row.phone || row.mobile);
  if (!email && !phone) errors.push('either email or phone is required');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email is not a valid format');
  // LR-C4-IMP-003: the same phone rule as the lead form and Leads > File. A
  // spreadsheet number read as display text ("9.19877E+11") was saved as the
  // lead's phone here.
  for (const field of ['phone', 'mobile'] as const) {
    const value = row[field];
    const text = value != null ? String(value).trim() : '';
    if (text && !PHONE_FORMAT_REGEX.test(text)) errors.push(`${field} is not a valid phone number`);
  }

  // LR-R2-IMP-001: validate expectedRevenue (≥ 0, ≤ 1e12)
  if (row.expectedRevenue !== undefined && row.expectedRevenue !== null && row.expectedRevenue !== '') {
    const rev = Number(row.expectedRevenue);
    if (isNaN(rev)) {
      errors.push('Expected Revenue must be a number');
    } else if (rev < 0) {
      errors.push('Expected Revenue must be ≥ 0');
    } else if (rev > 1_000_000_000_000) {
      errors.push('Expected Revenue cannot exceed 1,000,000,000,000');
    }
  }

  return errors;
}

function toLeadPayload(tenantId: string, row: ImportRow, batchId: string, createdBy?: string) {
  return {
    tenantId,
    firstName:  String(row.firstName ?? '').trim(),
    lastName:   row.lastName != null && String(row.lastName).trim() ? String(row.lastName).trim() : undefined,
    email:      row.email != null && String(row.email).trim() ? String(row.email).trim() : undefined,
    phone:      row.phone != null && String(row.phone).trim() ? String(row.phone).trim() : undefined,
    mobile:     row.mobile != null && String(row.mobile).trim() ? String(row.mobile).trim() : undefined,
    company:    row.company != null && String(row.company).trim() ? String(row.company).trim() : undefined,
    designation: row.designation != null && String(row.designation).trim() ? String(row.designation).trim() : undefined,
    source:     (row.source != null ? String(row.source).trim() : '') || 'csv',
    status:     row.status != null && String(row.status).trim() ? String(row.status).trim() : undefined,
    city:       row.city != null && String(row.city).trim() ? String(row.city).trim() : undefined,
    state:      row.state != null && String(row.state).trim() ? String(row.state).trim() : undefined,
    country:    row.country != null && String(row.country).trim() ? String(row.country).trim() : undefined,
    leadOwner:  row.leadOwner != null && String(row.leadOwner).trim() ? String(row.leadOwner).trim() : undefined,
    expectedRevenue: row.expectedRevenue !== undefined && row.expectedRevenue !== '' && !isNaN(Number(row.expectedRevenue)) ? Number(row.expectedRevenue) : undefined,
    tags:       row.tags ? String(row.tags).split(';').map((t) => t.trim()).filter(Boolean) : [],
    importBatchId: batchId,
    createdBy,
  };
}

/**
 * Bulk-imports Leads with exact duplicate detection (email or phone).
 * Per approved product rule: exact email or exact phone = duplicate (skip);
 * a shared email domain alone is NOT a duplicate and imports normally.
 */
export async function importLeadsCsv(tenantId: string, rows: ImportRow[], createdBy?: string): Promise<ImportSummary> {
  const batchId = new mongoose.Types.ObjectId().toString();
  const summary: ImportSummary = { batchId, total: rows.length, created: 0, duplicates: 0, duplicateRows: [], triage: 0, rejected: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = validateRow(row);
    if (errors.length) {
      summary.rejected.push({ row: i + 2, errors, data: row });
      continue;
    }

    try {
      // Exact email or phone duplicate check
      const duplicate = await findDuplicateContact(Lead, tenantId, {
        email: row.email != null ? String(row.email) : undefined,
        phone: row.phone != null ? String(row.phone) : undefined,
        mobile: row.mobile != null ? String(row.mobile) : undefined,
      });

      if (duplicate) {
        summary.duplicates++;
        // LR-IMP-001: say which row and which lead (only a count before).
        summary.duplicateRows.push({ row: i + 2, matchedId: duplicate.id, matchedLabel: duplicate.label });
        continue;
      }

      await createLead(toLeadPayload(tenantId, row, batchId, createdBy));
      summary.created++;
    } catch (rowErr: any) {
      // LR-C4-IMP-003: Per-row error capture prevents 500 crash half-way after partial commit
      summary.rejected.push({
        row: i + 2,
        errors: [rowErr?.message || 'Failed to import row'],
        data: row,
      });
    }
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
    // LR-IMP-001: the same checks as an imported row. "Create as new lead"
    // created the lead with no field check and no duplicate check.
    const row = item.rawRow as ImportRow;
    const errors = validateRow(row);
    if (errors.length) throw new Error(`This row cannot be created: ${errors.join('; ')}`);
    const duplicate = await findDuplicateContact(Lead, tenantId, {
      email: row.email != null ? String(row.email) : undefined,
      phone: row.phone != null ? String(row.phone) : undefined,
      mobile: row.mobile != null ? String(row.mobile) : undefined,
    });
    if (duplicate) throw new Error(`This row matches the existing lead ${duplicate.label} (${duplicate.id}); skip it instead`);
    await createLead(toLeadPayload(tenantId, row, item.batchId, userId));
    item.status = 'created';
  } else {
    item.status = 'skipped';
  }
  item.resolvedAt = new Date();
  item.resolvedBy = userId;
  await item.save();
  return item;
}
