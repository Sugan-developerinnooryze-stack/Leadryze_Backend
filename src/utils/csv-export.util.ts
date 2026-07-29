import { Response } from 'express';

export interface CsvColumn {
  key:   string;   // dot-path into each row, e.g. 'customFields.warranty_months'
  label: string;
}

function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function csvCell(value: any): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (Array.isArray(value)) s = value.map((v) => (v == null ? '' : String(v))).join('; ');
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Renders rows into RFC-4180-ish CSV text using the given column list —
 * the one shared piece of logic every module's export route reuses, so
 * adding export to a new module is just a column list + a filtered fetch. */
export function rowsToCsv(rows: Record<string, any>[], columns: CsvColumn[]): string {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvCell(getByPath(row, c.key))).join(','));
  return [header, ...lines].join('\r\n');
}

/** Sends a CSV string as a downloadable file. Prefixes a UTF-8 BOM so Excel
 * (which otherwise guesses the wrong codepage) renders non-ASCII correctly. */
export function sendCsvResponse(res: Response, filename: string, csv: string): void {
  const safeName = filename.replace(/[^\w.\-]/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  const BOM = String.fromCharCode(0xFEFF);
  res.send(BOM + csv);
}
