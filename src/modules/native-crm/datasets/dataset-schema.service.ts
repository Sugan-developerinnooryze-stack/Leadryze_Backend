import { IDatasetColumn, SemanticRole, DatasetColumnType } from './dataset-version.model';

/** Same snake_case convention as catalog-item.service.ts's normalizeSpecKey
 * — kept as its own copy here (not imported cross-module) since Dataset is
 * deliberately independent of the Product Catalog pipeline. */
function normalizeName(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Curated keyword patterns per role — deterministic, not an LLM call,
 * matching this whole project's "deterministic first" discipline (the same
 * reasoning behind detectHeaderRow.ts's scoring heuristic and
 * catalog-item.service.ts's title-alias fallback). Ordered by specificity:
 * checked in this order, first match wins, so e.g. "Product Name" matches
 * `name` before any looser pattern could claim it. */
// Real, confirmed false-positive bugs this closes — both found live against
// real datasets, not hypothetical:
//  - "Capacity"/"Size / Capacity" (normalized "capacity"/"size_capacity")
//    matched `location`'s bare `/city/` alternative, since "capacity"
//    literally contains the substring "city" — a real value like "3-21
//    inch" then got tagged as a location. Fixed by token-bounding "city" to
//    only match as a standalone underscore-separated segment
//    ((?:^|_)city(?:_|$)) — "capacity"/"size_capacity" never have "city" as
//    a distinct token, so this stops matching them, while a real header
//    like "branch_city" still correctly matches.
//  - "Flow Rate" (normalized "flow_rate") matched `price`'s bare `/rate/`
//    alternative — but here "rate" genuinely IS a separate token ("flow",
//    "rate"), not a substring-within-a-word like the city/capacity case, so
//    token-bounding wouldn't help; "rate" alone is just too ambiguous a
//    keyword (flow rate, success rate, exchange rate, growth rate all use
//    it) to keep in a PRICE-specific pattern. Dropped entirely —
//    price|cost|fee|amount|charge already cover real-world price-column
//    naming without it.
const ROLE_PATTERNS: Array<{ role: SemanticRole; pattern: RegExp }> = [
  { role: 'identifier', pattern: /^(id|code|sku|serial|reference|ref|no|number|model)$|_(id|code|model)$|^(item|product|record)_?(id|code|no)$/ },
  { role: 'price', pattern: /price|cost|fee|amount|charge/ },
  { role: 'date', pattern: /date|created|updated|expiry|expiration|deadline/ },
  { role: 'location', pattern: /(?:^|_)city(?:_|$)|location|branch|address|site|region|area|zone/ },
  { role: 'category', pattern: /category|type|kind|class|form|group/ },
  { role: 'image', pattern: /image|photo|picture|thumbnail|img_url|img$/ },
  { role: 'name', pattern: /name|title|item|product|service|machine/ },
  { role: 'description', pattern: /description|details|overview|about|purpose|benefit|use|note|summary/ },
];

function scoreRole(normalizedKey: string): { role?: SemanticRole; confidence: number } {
  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(normalizedKey)) {
      // Exact single-word match (e.g. "price" itself) scores higher than a
      // substring match inside a longer compound header (e.g.
      // "estimated_price_amount_inr" still matches "price" but is less
      // unambiguous than a header that IS just "Price").
      const exact = ROLE_PATTERNS.some((p) => p.role === role && normalizedKey === role);
      return { role, confidence: exact ? 0.95 : 0.75 };
    }
  }
  return { confidence: 0.2 };
}

const CURRENCY_PATTERN = /^[₹$€£]|[₹$€£]\s*[\d,]+|\d[\d,.]*\s*(inr|usd|eur|gbp)$/i;
const DATE_PATTERN = /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/;
const BOOLEAN_VALUES = new Set(['yes', 'no', 'true', 'false', 'y', 'n', 'available', 'unavailable']);

/** Infers a column's data type from a small sample of its real values —
 * deterministic pattern matching, not an LLM call. Falls back to 'string'
 * for anything ambiguous (safe default: a string column is always
 * filterable/searchable, just without numeric/date comparison operators).
 *
 * The plain-number check runs BEFORE the loose `Date.parse()` fallback —
 * a real, confirmed bug this fixes: `Date.parse("100")` is NOT NaN (V8
 * happily parses a short numeric string as a legacy/liberal date), so a
 * column of small integer values (e.g. a price of 100) was being
 * misclassified as 'date' purely because of that fallback's over-eager
 * matching. Downstream, normalizeValue() then stored an ISO date STRING
 * into `normalized.price` (a schema `Number` field), which Mongoose's own
 * bulkWrite cast-validates and rejects — silently, since bulkWrite does
 * not throw on a per-document validation error, it just excludes that
 * document from the write (see ingestMongoRecords()'s own result-checking
 * fix for why this is no longer silent either). A value must look like an
 * actual date (real separators, or fail the plain-number test) before the
 * lenient Date.parse() fallback is even consulted. */
// A second, real, confirmed instance of the SAME Date.parse() leniency
// class the comment above already fixed once (for plain numbers) — this
// time for alphanumeric codes: `Date.parse("FF-001")` is ALSO not NaN
// (confirmed live: resolves to a real, nonsensical timestamp,
// 2000-12-31T18:30:00.000Z), so a Model/SKU column ("FF-001".."FF-050")
// got silently misclassified as 'date', corrupting normalized.identifier
// into garbage dates instead of the real model codes. `isPlainNumber`
// already guards the pure-digit case; this guards the letters-plus-digits
// case the same way — only trust the lenient Date.parse() fallback when
// the string is ALREADY plausibly date-shaped (digits + date-typical
// punctuation only, or contains a recognized month name), never for an
// arbitrary alphanumeric code.
const MONTH_NAME_PATTERN = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const PLAUSIBLE_DATE_SHAPE = /^[\d\s,.\-/]+$/;

function inferDataType(sampleValues: string[]): DatasetColumnType {
  const nonEmpty = sampleValues.map((v) => String(v ?? '').trim()).filter((v) => v !== '');
  if (nonEmpty.length === 0) return 'string';
  if (nonEmpty.every((v) => CURRENCY_PATTERN.test(v))) return 'currency';
  const isPlainNumber = (v: string) => !Number.isNaN(Number(v.replace(/,/g, '')));
  const looksDateShaped = (v: string) => PLAUSIBLE_DATE_SHAPE.test(v) || MONTH_NAME_PATTERN.test(v);
  if (nonEmpty.every((v) => !isPlainNumber(v) && (DATE_PATTERN.test(v) || (looksDateShaped(v) && !Number.isNaN(Date.parse(v)))))) return 'date';
  if (nonEmpty.every((v) => BOOLEAN_VALUES.has(v.toLowerCase()))) return 'boolean';
  if (nonEmpty.every(isPlainNumber)) return 'number';
  return 'string';
}

const CONFIDENCE_THRESHOLD = 0.6;

/** Analyzes a set of headers + a sample of real rows and produces a
 * confidence-scored semantic-role + data-type mapping per column — the
 * schema-detection step shown in the import preview for confirmation
 * before anything is stored. Never blocks/excludes a column for having low
 * confidence; the caller decides whether to promote a role into
 * DatasetRecord.normalized.<role> (see dataset.service.ts — only the
 * highest-confidence column per role gets promoted; every column, mapped
 * or not, is always kept in `data`). */
export function analyzeColumns(headers: string[], sampleRows: Record<string, unknown>[]): IDatasetColumn[] {
  const claimedRoles = new Set<SemanticRole>();
  // normalizedName is the actual Mongo storage/query key for this column
  // (hardening Gap 5) — it must be unique per dataset, since two raw
  // headers can normalize to the same string (e.g. "Price ($)" and
  // "Price (%)" both -> "price"). Deterministic suffixing, not a random
  // one, so the same file re-analyzed twice always produces the same keys.
  const usedNames = new Set<string>();
  const dedupe = (base: string): string => {
    const safeBase = base || 'column';
    if (!usedNames.has(safeBase)) { usedNames.add(safeBase); return safeBase; }
    let i = 2;
    while (usedNames.has(`${safeBase}_${i}`)) i++;
    const unique = `${safeBase}_${i}`;
    usedNames.add(unique);
    return unique;
  };
  const scored = headers.map((h) => {
    // Role scoring runs on the semantic name BEFORE collision suffixing —
    // two headers colliding into "price"/"price_2" should score identically
    // on role-matching; only the actual storage key needs to be unique.
    const baseName = normalizeName(h);
    const { role, confidence } = scoreRole(baseName);
    const normalizedName = dedupe(baseName);
    const sampleValues = sampleRows.map((r) => r[h]).filter((v) => v !== undefined && v !== null && v !== '') as string[];
    return {
      originalName: h,
      normalizedName,
      role,
      confidence,
      dataType: inferDataType(sampleValues.map(String)),
    };
  });

  // Only the highest-confidence column per role gets promoted to a
  // first-class role (see dataset-record.model.ts's own comment on why —
  // a second "Discounted Price" column stays a plain field, never lost,
  // just not separately role-indexed).
  const columns: IDatasetColumn[] = scored
    .sort((a, b) => b.confidence - a.confidence)
    .map((c) => {
      let semanticRole: SemanticRole | undefined;
      if (c.role && c.confidence >= CONFIDENCE_THRESHOLD && !claimedRoles.has(c.role)) {
        semanticRole = c.role;
        claimedRoles.add(c.role);
      }
      return {
        originalName: c.originalName,
        normalizedName: c.normalizedName,
        semanticRole,
        confidence: semanticRole ? c.confidence : (c.role ? c.confidence : 0),
        source: 'heuristic' as const,
        dataType: c.dataType,
      };
    });

  // Restore original header order for display (the sort above was only for
  // role-claiming priority).
  const order = new Map(headers.map((h, i) => [h, i]));
  columns.sort((a, b) => (order.get(a.originalName) ?? 0) - (order.get(b.originalName) ?? 0));
  return columns;
}
