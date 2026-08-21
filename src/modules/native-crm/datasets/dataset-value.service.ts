import { IDatasetColumn } from './dataset-version.model';

/** Parses a raw cell value into a typed, normalized value per the column's
 * inferred dataType (dataset-schema.service.ts) — the RAW string always
 * stays intact in DatasetRecord.data regardless; this only affects what
 * (if anything) gets promoted into the role-keyed `normalized` bag the
 * query executor's structured filters actually run against. */
export function normalizeValue(raw: unknown, dataType: IDatasetColumn['dataType']): unknown {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;

  if (dataType === 'currency' || dataType === 'number') {
    const cleaned = s.replace(/[₹$€£,]/g, '').replace(/\s*(inr|usd|eur|gbp)\s*/i, '').trim();
    const n = parseFloat(cleaned);
    return Number.isNaN(n) ? undefined : n;
  }
  if (dataType === 'date') {
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  if (dataType === 'boolean') {
    return ['yes', 'true', 'y', 'available'].includes(s.toLowerCase());
  }
  return s;
}

// Hardening Gap 5 — raw Excel/CSV/JSON headers are attacker/tenant
// controlled and arbitrary (can contain dots, `$`, anything). A literal
// dot in a stored `data` key is fine for storage (the whole `data` object
// is always $set atomically, never as a dotted update path — see
// ingestMongoRecords()), but dataset-query.service.ts's structured filters
// address fields as `data.<key>`, and Mongo's QUERY-side dot semantics
// always mean nested-path traversal regardless of storage shape — so a raw
// header like "Product.Name" would silently query the wrong (nonexistent)
// path. Storing under the pre-sanitized, collision-safe `normalizedName`
// instead eliminates this at the root. `originalName` is never lost — it's
// preserved on DatasetVersion.columns for display/citation.
const MAX_CELL_LENGTH = 10_000;

/** Builds the {data, normalized} pair for one raw row given the confirmed
 * column schema — data keeps every column's value under its sanitized
 * `normalizedName` (nothing destroyed, just safely keyed); normalized only
 * gets the small, fixed, role-keyed set of fields the schema actually
 * promoted (see dataset-schema.service.ts's analyzeColumns() for how at
 * most one column per role gets promoted). Returns `cellsTruncated` so the
 * caller can surface a real warning rather than silently shrinking data. */
/** Cross-version row identity for diff reporting (Part B) — (a) the
 * identifier-role column's value if mapped and non-empty, (b) a normalized
 * name+category composite if both are mapped, (c) null when neither is
 * available. Prefixed by kind ('id:'/'nc:') so an identifier value that
 * happens to collide textually with a name+category composite from a
 * *different* dataset shape never cross-matches. Never null-coalesced to
 * an empty string — an ambiguous row is always treated as new (added),
 * never silently matched to an unrelated row. */
function computeIdentityKey(row: Record<string, unknown>, columns: IDatasetColumn[]): string | null {
  const identifierCol = columns.find((c) => c.semanticRole === 'identifier');
  if (identifierCol) {
    const v = String(row[identifierCol.originalName] ?? '').trim();
    if (v) return `id:${v.toLowerCase()}`;
  }
  const nameCol = columns.find((c) => c.semanticRole === 'name');
  const categoryCol = columns.find((c) => c.semanticRole === 'category');
  if (nameCol && categoryCol) {
    const nv = String(row[nameCol.originalName] ?? '').trim();
    const cv = String(row[categoryCol.originalName] ?? '').trim();
    if (nv && cv) return `nc:${nv.toLowerCase()}|${cv.toLowerCase()}`;
  }
  return null;
}

export function buildRecordFields(row: Record<string, unknown>, columns: IDatasetColumn[]): {
  data: Record<string, unknown>;
  normalized: Record<string, unknown>;
  cellsTruncated: number;
  identityKey: string | null;
} {
  const data: Record<string, unknown> = {};
  const normalized: Record<string, unknown> = {};
  let cellsTruncated = 0;
  for (const col of columns) {
    const raw = row[col.originalName];
    if (raw === undefined || raw === null || raw === '') continue;
    let value: unknown = raw;
    if (typeof value === 'string' && value.length > MAX_CELL_LENGTH) {
      value = value.slice(0, MAX_CELL_LENGTH);
      cellsTruncated += 1;
    }
    data[col.normalizedName] = value;
    if (col.semanticRole) {
      const normalizedValue = normalizeValue(raw, col.dataType);
      // Real, confirmed bug this closes: normalizeValue()'s return type is
      // driven by the column's own inferred dataType (dataset-schema.
      // service.ts's inferDataType()), which can diverge from what the
      // TARGET role's normalized field actually expects. inferDataType()
      // uses an all-or-nothing .every() check — a single non-numeric
      // outlier value anywhere in a price column (e.g. one "On Request"
      // cell, confirmed live against a real 50-product industrial
      // dataset) demotes the WHOLE column's dataType to 'string' for
      // every row, not just the outlier. normalizeValue() then falls
      // through to its raw-string passthrough for every row, including
      // genuinely numeric ones — and that raw string was being blindly
      // assigned into the Number-typed normalized.price field, failing
      // Mongoose's schema cast for the whole document and silently
      // dropping the row from the bulk write. Guard by the role's real
      // expected type at the point of assignment — never trust
      // normalizeValue()'s output type blindly. The raw display value
      // always still lands in `data` above regardless of this guard.
      const expectsNumber = col.semanticRole === 'price';
      const typeMatches = expectsNumber ? typeof normalizedValue === 'number' : typeof normalizedValue === 'string';
      if (normalizedValue !== undefined && typeMatches) normalized[col.semanticRole] = normalizedValue;
    }
  }
  return { data, normalized, cellsTruncated, identityKey: computeIdentityKey(row, columns) };
}

const FIELD_TEXT_CAP = 200;
const RECORD_TEXT_CAP = 2000;
const MAX_UNMAPPED_FIELDS_IN_TEXT = 5;

/** Field-aware, length-bounded semantic text for embedding — includes
 * every mapped semantic-role field PLUS a bounded selection of the
 * highest-signal unmapped fields (longest values first, as a simple proxy
 * for "most informative"), each truncated, the whole text capped overall.
 * Deliberately NOT a fixed "name: X, description: Y" template — a
 * dataset's most meaningful fields vary entirely by business type (a
 * machine's power/location/maintenance vs. a medicine's dosage/benefits),
 * so this adapts to whatever the schema actually mapped instead of
 * assuming a fixed product-shaped set of fields exists. */
export function buildSemanticText(row: Record<string, unknown>, columns: IDatasetColumn[]): string {
  const mapped = columns.filter((c) => c.semanticRole);
  const unmapped = columns.filter((c) => !c.semanticRole);

  const mappedParts = mapped
    .map((c) => ({ label: c.originalName, value: String(row[c.originalName] ?? '').trim() }))
    .filter((p) => p.value !== '');

  const unmappedParts = unmapped
    .map((c) => ({ label: c.originalName, value: String(row[c.originalName] ?? '').trim() }))
    .filter((p) => p.value !== '')
    .sort((a, b) => b.value.length - a.value.length)
    .slice(0, MAX_UNMAPPED_FIELDS_IN_TEXT);

  const allParts = [...mappedParts, ...unmappedParts];
  const sentence = allParts
    .map((p) => `${p.label}: ${p.value.length > FIELD_TEXT_CAP ? p.value.slice(0, FIELD_TEXT_CAP) + '…' : p.value}`)
    .join('. ');

  return sentence.length > RECORD_TEXT_CAP ? sentence.slice(0, RECORD_TEXT_CAP) + '…' : sentence;
}
