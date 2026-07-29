import mongoose from 'mongoose';
import { Deal } from './deal.model';
import { createDeal } from './deal.service';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';

export interface ImportRow {
  title?:       string;
  amount?:      string | number;
  currency?:    string;
  stage?:       string;
  closeDate?:   string;
  contactName?: string;
  companyName?: string;
  notes?:       string;
  tags?:        string;
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
  rejected:   RejectedRow[];
}

function norm(s?: string): string {
  return (s ?? '').trim().toLowerCase();
}

/** Mandatory-field validation — a title is the only thing Deal.schema itself
 * requires; stage (if supplied) must be valid for this tenant's own
 * configured pipeline, same app-layer check createDeal() applies. */
async function validateRow(tenantId: string, row: ImportRow): Promise<string[]> {
  const errors: string[] = [];
  if (!row.title || !String(row.title).trim()) errors.push('title is required');
  if (row.stage && !(await isValidStageKey(tenantId, 'deal', String(row.stage)))) {
    errors.push(`"${row.stage}" is not a valid stage for this tenant's Deal pipeline`);
  }
  if (row.amount !== undefined && row.amount !== '' && Number.isNaN(Number(row.amount))) {
    errors.push('amount is not a valid number');
  }
  return errors;
}

function toDealPayload(row: ImportRow, batchId: string, createdBy?: string) {
  return {
    title:       String(row.title ?? '').trim(),
    amount:      row.amount !== undefined && row.amount !== '' ? Number(row.amount) : undefined,
    currency:    row.currency ? String(row.currency).trim() : undefined,
    stage:       row.stage ? String(row.stage).trim() : undefined,
    closeDate:   row.closeDate ? String(row.closeDate).trim() : undefined,
    contactName: row.contactName ? String(row.contactName).trim() : undefined,
    companyName: row.companyName ? String(row.companyName).trim() : undefined,
    notes:       row.notes ? String(row.notes).trim() : undefined,
    tags:        row.tags ? String(row.tags).split(';').map((t) => t.trim()).filter(Boolean) : undefined,
    importBatchId: batchId,
    createdBy,
  };
}

/**
 * Bulk-imports Deals with real validation and duplicate detection — same
 * governed shape as importLeadsCsv, but Deal's dedup key is necessarily
 * different: Deal has no email/phone (nothing PII-encrypted to decrypt
 * here), and a company legitimately has many distinct deals, so there's no
 * Lead-style "same domain, different contact" ambiguity worth a triage
 * queue. An exact-duplicate here is the same title + same company already
 * on file for this tenant — anything else is a new Deal.
 */
export async function importDealsCsv(tenantId: string, rows: ImportRow[], createdBy?: string): Promise<ImportSummary> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const batchId = new mongoose.Types.ObjectId().toString();
  const summary: ImportSummary = { batchId, total: rows.length, created: 0, duplicates: 0, rejected: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = await validateRow(tenantId, row);
    if (errors.length) {
      summary.rejected.push({ row: i + 1, errors, data: row });
      continue;
    }

    const title = norm(row.title as string | undefined);
    const company = norm(row.companyName as string | undefined);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const existing = await Deal.findOne({
      tenantId: tid,
      title: new RegExp(`^${esc(title)}$`, 'i'),
      companyName: new RegExp(`^${esc(company)}$`, 'i'),
    }).select('_id').lean();
    if (existing) {
      summary.duplicates++;
      continue;
    }

    await createDeal(tenantId, toDealPayload(row, batchId, createdBy) as any);
    summary.created++;
  }

  return summary;
}
