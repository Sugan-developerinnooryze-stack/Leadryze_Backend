import { normalizeSnapshotValue } from '../../internal/crm-gateway.helpers';

/* What an update would really change: each proposed value compared with the
 * record as it is now (decrypted for the comparison only, never shown), with
 * the same normalisation the gateway's stale check uses (dates as instants,
 * ObjectIds as hex, numbers and numeric text alike, null / missing / '' all
 * "empty"). Only changed keys are written. */

export interface FieldChange {
  /** "priority", or "customFields.region" for a custom field. */
  key: string;
  before: unknown;
  after: unknown;
}

const CUSTOM_PREFIX = 'customFields.';

function toPlain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const maybe = value as { toObject?: () => Record<string, unknown> };
  return typeof maybe.toObject === 'function' ? maybe.toObject() : value as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    && !(value as { _bsontype?: unknown })._bsontype;
}

function sameValue(a: unknown, b: unknown): boolean {
  return normalizeSnapshotValue(a) === normalizeSnapshotValue(b);
}

function customValue(record: Record<string, unknown>, sub: string): unknown {
  const custom = record.customFields;
  if (custom instanceof Map) return custom.get(sub);
  return isPlainObject(custom) ? custom[sub] : undefined;
}

/** The field keys a set of values touches: top-level keys, and a nested
 * customFields object as "customFields.<key>" per key. */
export function fieldKeysOf(values: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (key === 'customFields' && isPlainObject(value)) {
      for (const sub of Object.keys(value)) keys.push(`${CUSTOM_PREFIX}${sub}`);
    } else keys.push(key);
  }
  return keys;
}

/** The values of an update reduced to what differs from `record`, and one
 * change per field. A nested customFields object is kept whole when any of
 * its keys changes (the services write it as sent, exactly as /crm-write
 * passes it today). */
export function reduceToChanges(
  values: Record<string, unknown>, recordInput: unknown,
): { values: Record<string, unknown>; changes: FieldChange[] } {
  const record = toPlain(recordInput);
  const out: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  for (const [key, after] of Object.entries(values)) {
    if (key === 'customFields' && isPlainObject(after)) {
      const changed = Object.entries(after).filter(([sub, v]) => !sameValue(v, customValue(record, sub)));
      if (changed.length) {
        out[key] = after;
        for (const [sub, v] of changed) changes.push({ key: `${CUSTOM_PREFIX}${sub}`, before: customValue(record, sub), after: v });
      }
      continue;
    }
    const before = key.startsWith(CUSTOM_PREFIX) ? customValue(record, key.slice(CUSTOM_PREFIX.length)) : record[key];
    if (!sameValue(after, before)) {
      out[key] = after;
      changes.push({ key, before, after });
    }
  }
  return { values: out, changes };
}

/** Every value of a create, as changes from nothing. */
export function createChanges(values: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [key, after] of Object.entries(values)) {
    if (key === 'customFields' && isPlainObject(after)) {
      for (const [sub, v] of Object.entries(after)) changes.push({ key: `${CUSTOM_PREFIX}${sub}`, before: undefined, after: v });
    } else changes.push({ key, before: undefined, after });
  }
  return changes;
}
