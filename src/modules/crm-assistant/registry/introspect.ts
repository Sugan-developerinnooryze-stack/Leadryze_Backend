import type { Model, Schema } from 'mongoose';
import type { FieldCap, ModuleCap } from './types';

/* Reads a module's real Mongoose schema, so the hand-written registry entries
 * (native-crm.ts, field-service.ts) can be checked against it (validate.ts)
 * and every FieldCap carries the schema facts the engine needs: the stored
 * type, the schema's own enum values and whether the value is an array.
 * No database access: Model.schema is built when the model file is loaded. */

export type SchemaPathInfo = Readonly<{ instance: string; enumValues?: string[]; isArray: boolean }>;

const cache = new WeakMap<Model<any>, ReadonlyMap<string, SchemaPathInfo>>();

function enumOf(type: any): string[] | undefined {
  const values = type?.enumValues;
  return Array.isArray(values) && values.length > 0 ? [...values] : undefined;
}

function info(instance: string, isArray: boolean, enumValues?: string[]): SchemaPathInfo {
  return Object.freeze(enumValues ? { instance, enumValues: Object.freeze(enumValues) as string[], isArray } : { instance, isArray });
}

/** Walks one schema level. Paths come out dotted ("location.lat",
 * "services.amount"). A primitive array ("tags") is reported with its
 * element type and isArray true; a document array ("services") as instance
 * "Array" with isArray true, followed by its sub-paths (each isArray true,
 * since every record holds a list of them); a nested plain object
 * ("location") as instance "Nested" next to its leaves. */
function walk(schema: Schema, prefix: string, inArray: boolean, out: Map<string, SchemaPathInfo>): void {
  for (const nested of Object.keys((schema as any).nested ?? {})) {
    out.set(prefix + nested, info('Nested', inArray));
  }
  schema.eachPath((path: string, type: any) => {
    const full = prefix + path;
    const isDocArray = type.instance === 'Array' && !!type.schema;
    const isSubdoc = !!type.schema && type.instance !== 'Array';
    if (type.instance === 'Array' && !isDocArray) {
      const element = type.caster ?? type.$embeddedSchemaType;
      out.set(full, info(element?.instance ?? 'Mixed', true, enumOf(element)));
    } else {
      out.set(full, info(type.instance, inArray || isDocArray, enumOf(type)));
    }
    if (isDocArray || isSubdoc) walk(type.schema, `${full}.`, inArray || isDocArray, out);
  });
}

/** Every path of the model's schema (nested and array sub-paths included),
 * with its instance, enum values and array flag. Cached per model. */
export function introspectModel(model: Model<any>): ReadonlyMap<string, SchemaPathInfo> {
  let paths = cache.get(model);
  if (!paths) {
    const out = new Map<string, SchemaPathInfo>();
    walk(model.schema, '', false, out);
    paths = out;
    cache.set(model, paths);
  }
  return paths;
}

/** The schema facts for one path: the path itself, or anything stored under
 * a Mixed path ("customFields.region" -> Mixed). Undefined when the schema
 * has no such path. */
export function schemaPathInfo(model: Model<any>, path: string): SchemaPathInfo | undefined {
  const paths = introspectModel(model);
  const exact = paths.get(path);
  if (exact) return exact;
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const parent = paths.get(parts.slice(0, i).join('.'));
    if (parent) return parent.instance === 'Mixed' ? info('Mixed', parent.isArray) : undefined;
  }
  return undefined;
}

/** True when the schema declares a Mongoose virtual with this name (e.g.
 * the invoice's balanceDue). */
export function isSchemaVirtual(model: Model<any>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(model.schema.virtuals ?? {}, path);
}

/** True when the model has a unique index on `path`, alone or next to
 * tenantId (the per-tenant business-number pattern). */
export function hasUniqueIndexOn(model: Model<any>, path: string): boolean {
  return model.schema.indexes().some(([keys, options]) => {
    if (!(options as { unique?: boolean } | undefined)?.unique) return false;
    const names = Object.keys(keys);
    return names.includes(path) && names.every((name) => name === path || name === 'tenantId');
  });
}

/** Whether one of the model's pre-save hooks runs encryptPIIFields (its PII
 * is stored encrypted), read from the registered hooks. Undefined when the
 * hooks can't be read. Used by the drift test to keep validate.ts's
 * ENCRYPTED_PII_MODULES honest; never at boot, since it reads hook source. */
export function modelEncryptsPII(model: Model<any>): boolean | undefined {
  const pres = (model.schema as any)?.s?.hooks?._pres;
  if (!(pres instanceof Map)) return undefined;
  const save: unknown = pres.get('save') ?? [];
  if (!Array.isArray(save)) return undefined;
  return save.some((hook: any) => /\bencryptPIIFields\b/.test(String(hook?.fn)));
}

/** Fills FieldCap.schema from the model for every non-virtual field of the
 * module (idempotent). Fields whose path the schema lacks are left without
 * it; validate.ts reports them. */
export function fillSchemaInfo(cap: ModuleCap): void {
  const model = cap.model();
  for (const field of cap.fields as FieldCap[]) {
    if (field.virtual) continue;
    const found = schemaPathInfo(model, field.path);
    if (found) field.schema = found;
  }
}
