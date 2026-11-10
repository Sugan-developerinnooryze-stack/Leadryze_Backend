/** Generic, backend-driven "any field, any condition" filter engine — one
 * place to turn a client-sent list of {field, operator, value} conditions
 * into a Mongo filter, validated against an explicit per-module field
 * catalog (see workorders/workorder.filter-catalog.ts for the first
 * caller). Never trusts a client-sent field name or operator directly into
 * a query: unknown fields/operators/malformed input are silently dropped,
 * same "degrade to no filter" posture as date-range.ts's own resolveDateRange.
 * Built module-agnostic on purpose so the other document modules (Quotations,
 * Contracts, Invoices) can reuse it the same way once Work Orders proves it out. */

import { escapeRegex } from '../../../utils/escape-regex';

export type FilterFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean' | 'multi';

export interface FilterFieldDef {
  /** Public identifier the frontend sends back — 'priority' for a fixed
   * field, 'cf:<fieldKey>' for a tenant custom field (namespaced so a
   * custom field can never collide with / spoof a fixed field's key). */
  key:        string;
  label:      string;
  type:       FilterFieldType;
  /** Real Mongo field path — usually equal to `key` for fixed fields,
   * always `customFields.<fieldKey>` for custom ones. */
  path:       string;
  /** A second path also checked via $or — for fields that may live as a
   * single value OR inside an array (e.g. Work Orders' staffId/staffIds). */
  arrayPath?: string;
  /** value = what's actually stored/matched (a Team's own teamId, a plain
   * enum like 'high', a custom field's raw option string); label = what the
   * picker shows the user. Kept as pairs (not bare strings) so lookup-backed
   * fields like Team/Site/Staff can show real names while still filtering
   * on the record's real stored id. */
  options?:   { value: string; label: string }[];
  source:     'fixed' | 'custom';
}

export interface FilterCondition {
  field:    string;
  operator: string;
  value?:   unknown;
  value2?:  unknown; // 'between' operators only
}

const OPERATORS_BY_TYPE: Record<FilterFieldType, string[]> = {
  text:    ['contains', 'equals', 'is_empty', 'is_not_empty'],
  number:  ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date:    ['before', 'after', 'between'],
  select:  ['eq', 'in'],
  boolean: ['eq'],
  multi:   ['contains_any'],
};

function buildLeaf(type: FilterFieldType, path: string, operator: string, value: unknown, value2: unknown): Record<string, unknown> | null {
  switch (type) {
    case 'text': {
      if (operator === 'is_empty')     return { [path]: { $in: [null, ''] } };
      if (operator === 'is_not_empty') return { [path]: { $nin: [null, ''] } };
      if (typeof value !== 'string' || !value.trim()) return null;
      const v = value.trim();
      return operator === 'equals'
        ? { [path]: new RegExp(`^${escapeRegex(v)}$`, 'i') }
        : { [path]: new RegExp(escapeRegex(v), 'i') };
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (operator === 'eq')  return { [path]: n };
      if (operator === 'gt')  return { [path]: { $gt:  n } };
      if (operator === 'gte') return { [path]: { $gte: n } };
      if (operator === 'lt')  return { [path]: { $lt:  n } };
      if (operator === 'lte') return { [path]: { $lte: n } };
      if (operator === 'between') {
        const n2 = Number(value2);
        if (!Number.isFinite(n2)) return null;
        return { [path]: { $gte: Math.min(n, n2), $lte: Math.max(n, n2) } };
      }
      return null;
    }
    case 'date': {
      if (typeof value !== 'string') return null;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      if (operator === 'before') { const end = new Date(d); end.setHours(0, 0, 0, 0); return { [path]: { $lt: end } }; }
      if (operator === 'after')  { const start = new Date(d); start.setHours(23, 59, 59, 999); return { [path]: { $gt: start } }; }
      if (operator === 'between') {
        if (typeof value2 !== 'string') return null;
        const d2 = new Date(value2);
        if (Number.isNaN(d2.getTime())) return null;
        const start = new Date(Math.min(d.getTime(), d2.getTime())); start.setHours(0, 0, 0, 0);
        const end   = new Date(Math.max(d.getTime(), d2.getTime())); end.setHours(23, 59, 59, 999);
        return { [path]: { $gte: start, $lte: end } };
      }
      return null;
    }
    case 'select': {
      if (operator === 'eq') {
        if (typeof value !== 'string' || !value) return null;
        return { [path]: value };
      }
      if (operator === 'in') {
        if (!Array.isArray(value) || !value.length) return null;
        return { [path]: { $in: value } };
      }
      return null;
    }
    case 'boolean':
      return { [path]: value === true || value === 'true' };
    case 'multi': {
      if (!Array.isArray(value) || !value.length) return null;
      return { [path]: { $in: value } };
    }
    default:
      return null;
  }
}

function buildCondition(def: FilterFieldDef, cond: FilterCondition): Record<string, unknown> | null {
  if (!OPERATORS_BY_TYPE[def.type].includes(cond.operator)) return null;
  const leaf = buildLeaf(def.type, def.path, cond.operator, cond.value, cond.value2);
  if (!leaf) return null;
  if (def.arrayPath) {
    const leaf2 = buildLeaf(def.type, def.arrayPath, cond.operator, cond.value, cond.value2);
    return leaf2 ? { $or: [leaf, leaf2] } : leaf;
  }
  return leaf;
}

/** Parses the raw `filters` query param (JSON-encoded FilterCondition[]),
 * validates each condition against `catalog`, and ANDs the surviving
 * conditions into `mongoFilter`. A no-op when `rawFilters` is absent or
 * fails to parse — same as every other filter helper here, malformed input
 * degrades to "no filter" rather than a 500. */
export function applyDynamicFilters(
  mongoFilter: Record<string, unknown>,
  rawFilters: string | undefined,
  catalog: FilterFieldDef[],
): void {
  if (!rawFilters) return;
  let conditions: unknown;
  try {
    conditions = JSON.parse(rawFilters);
  } catch {
    return;
  }
  if (!Array.isArray(conditions)) return;

  const byKey = new Map(catalog.map((d) => [d.key, d]));
  const fragments: Record<string, unknown>[] = [];
  for (const raw of conditions.slice(0, 20)) {
    const cond = raw as FilterCondition;
    if (!cond || typeof cond.field !== 'string' || typeof cond.operator !== 'string') continue;
    const def = byKey.get(cond.field);
    if (!def) continue;
    const fragment = buildCondition(def, cond);
    if (fragment) fragments.push(fragment);
  }
  if (fragments.length) {
    mongoFilter.$and = [...((mongoFilter.$and as unknown[]) ?? []), ...fragments];
  }
}

/** Maps a tenant custom field's own type (custom-field.model.ts) onto this
 * engine's filter type — file/media/form types return null (excluded from
 * the catalog, no sensible filter condition exists for them). */
export function customFieldFilterType(fieldType: string): FilterFieldType | null {
  switch (fieldType) {
    case 'text': case 'textarea': case 'email': case 'phone': case 'url':
      return 'text';
    case 'number': case 'currency': case 'rating':
      return 'number';
    case 'date': case 'datetime':
      return 'date';
    case 'checkbox': case 'boolean':
      return 'boolean';
    case 'radio': case 'dropdown':
      return 'select';
    case 'multi_select':
      return 'multi';
    default:
      return null; // image/images/video/videos/custom_form
  }
}

/** Why compileConditionsStrict refused one condition. */
export type StrictConditionReason =
  | 'not_a_list'           // the conditions are not an array
  | 'too_many'             // beyond the first MAX_STRICT_CONDITIONS
  | 'malformed'            // not an object, or field / operator not a string
  | 'unknown_field'        // no catalog entry with that key
  | 'unsupported_operator' // the field type doesn't take that operator
  | 'invalid_value';       // the value doesn't fit the field (or the builder refused it)

export interface StrictConditionRejection {
  /** Position in the given list (-1 when the list itself was refused). */
  index: number;
  field?: string;
  operator?: string;
  reason: StrictConditionReason;
}

/** The same cap applyDynamicFilters applies (it silently keeps the first 20). */
const MAX_STRICT_CONDITIONS = 20;

const isNumberLike = (v: unknown) =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v));

/** Values the shared builder would silently coerce (Number('') is 0, any
 * non-true value is false) or never checks (select values against the
 * catalog's options): refused here instead. */
function strictValueOk(def: FilterFieldDef, cond: FilterCondition): boolean {
  const options = def.options?.map((o) => o.value);
  const inOptions = (v: unknown) => typeof v === 'string' && (!options || options.includes(v));
  switch (def.type) {
    case 'number':
      return isNumberLike(cond.value) && (cond.operator !== 'between' || isNumberLike(cond.value2));
    case 'boolean':
      return cond.value === true || cond.value === false || cond.value === 'true' || cond.value === 'false';
    case 'select':
      return cond.operator === 'in'
        ? Array.isArray(cond.value) && cond.value.length > 0 && cond.value.every(inOptions)
        : inOptions(cond.value);
    case 'multi':
      return Array.isArray(cond.value) && cond.value.length > 0 && cond.value.every((v) => typeof v === 'string' && v.length > 0);
    default:
      return true;
  }
}

/** The strict twin of applyDynamicFilters (which stays unchanged for the
 * screens): compiles client- or planner-sent conditions against `catalog`
 * with the same private builder, and reports every condition it refuses with
 * the reason, instead of dropping it silently. Never writes into a filter:
 * the caller places each fragment (an $and member) itself. */
export function compileConditionsStrict(
  conditions: unknown,
  catalog: FilterFieldDef[],
): { fragments: Record<string, unknown>[]; rejected: StrictConditionRejection[] } {
  const fragments: Record<string, unknown>[] = [];
  const rejected: StrictConditionRejection[] = [];
  if (!Array.isArray(conditions)) return { fragments, rejected: [{ index: -1, reason: 'not_a_list' }] };

  const byKey = new Map(catalog.map((d) => [d.key, d]));
  conditions.forEach((raw, index) => {
    const cond = raw as FilterCondition;
    const named = cond && typeof cond === 'object' && typeof cond.field === 'string' && typeof cond.operator === 'string';
    const where = named ? { field: cond.field, operator: cond.operator } : {};
    if (index >= MAX_STRICT_CONDITIONS) { rejected.push({ index, ...where, reason: 'too_many' }); return; }
    if (!named) { rejected.push({ index, reason: 'malformed' }); return; }
    const def = byKey.get(cond.field);
    if (!def) { rejected.push({ index, ...where, reason: 'unknown_field' }); return; }
    if (!OPERATORS_BY_TYPE[def.type].includes(cond.operator)) { rejected.push({ index, ...where, reason: 'unsupported_operator' }); return; }
    const fragment = strictValueOk(def, cond) ? buildCondition(def, cond) : null;
    if (!fragment) { rejected.push({ index, ...where, reason: 'invalid_value' }); return; }
    fragments.push(fragment);
  });
  return { fragments, rejected };
}
