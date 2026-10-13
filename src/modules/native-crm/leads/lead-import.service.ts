import mongoose from 'mongoose';
import { Lead } from './lead.model';
import { createLead } from './lead.service';
import { LeadImportTriage } from './lead-import-triage.model';
import { decrypt, isEncrypted } from '../../../utils/crypto';

import { findDuplicateContact } from '../shared/duplicate-check';

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

/** Mandatory-field validation — a name, contact method, and valid expectedRevenue. */
function validateRow(row: ImportRow): string[] {
  const errors: string[] = [];
  if (!row.firstName || !String(row.firstName).trim()) errors.push('firstName is required');
  const email = normalizeEmail(row.email as string | undefined);
  const phone = normalizePhone(row.phone as string | undefined);
  if (!email && !phone) errors.push('either email or phone is required');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email is not a valid format');

  // LR-R2-IMP-001: validate expectedRevenue (≥ 0, ≤ 1e12)
  if (row.expectedRevenue !== undefined && row.expectedRevenue !== null && row.expectedRevenue !== '') {
    const rev = Number(row.expectedRevenue);
    if (isNaN(rev)) {
      errors.push('Expected Revenue must be a number');
    } else if (rev < 0) {
      errors.push('Expected Revenue must be 0 or more');
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
  const summary: ImportSummary = { batchId, total: rows.length, created: 0, duplicates: 0, triage: 0, rejected: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = validateRow(row);
    if (errors.length) {
      summary.rejected.push({ row: i + 1, errors, data: row });
      continue;
    }

    // Exact email or phone duplicate check
    const duplicate = await findDuplicateContact(Lead, tenantId, {
      email: row.email as string | undefined,
      phone: row.phone as string | undefined,
      mobile: row.mobile as string | undefined,
    });

    if (duplicate) {
      summary.duplicates++;
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
