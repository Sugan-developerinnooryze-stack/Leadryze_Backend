import type { FieldCap, FieldKind, ModuleCap } from './types';
import type { SchemaPathInfo } from './introspect';
import { fillSchemaInfo, hasUniqueIndexOn, introspectModel, isSchemaVirtual } from './introspect';
import { CRM_WRITE_MODULE_MAP } from '../../internal/crm-write.module-map';
import { isForbiddenReadKey, readFieldKeysFor } from '../../internal/crm-read.service';
import { PII_FIELDS } from '../../../platform/pii/constants';
import { LOOKUP_GATES, RECORD_SOURCES } from '../../daily-events/daily-events.sources';
import { ROUTE_TEMPLATES } from '../contracts/routes';
import { VIEW_CAPS } from '../contracts/views';

/* Checks each hand-written registry entry against the real code it
 * describes (plan 3.5): the Mongoose schema (paths, types, enums, indexes),
 * the module map (gates, status source, read projection), the PII registry,
 * Daily Events' RECORD_SOURCES where they overlap, and the route table.
 * Runs at boot (registry/index.ts leaves a failing module out) and in CI
 * (tests/crm-assist-registry-drift.test.ts). Never throws. */

/** PII modules whose model encrypts those fields at rest (encryptPIIFields
 * in a pre-save hook: lead.model.ts, contact.schema.ts, customer.model.ts,
 * site.model.ts, staff.model.ts). 'users' PII is masked, not encrypted. The
 * drift test checks this list against the models' real save hooks. */
export const ENCRYPTED_PII_MODULES: ReadonlySet<string> = new Set(['leads', 'contacts', 'customers', 'sites', 'staffs']);

/** Schema instances each field kind may sit on. */
const KIND_INSTANCES: Readonly<Record<FieldKind, readonly string[]>> = {
  id: ['String', 'ObjectId'],
  text: ['String'], longtext: ['String'], email: ['String'], phone: ['String'],
  number: ['Number'], money: ['Number'], percent: ['Number'], duration: ['Number'],
  date: ['Date'], datetime: ['Date'],
  boolean: ['Boolean'],
  enum: ['String'], stage: ['String'],
  ref: ['String', 'ObjectId'], ref_many: ['String', 'ObjectId'],
  line_items: ['Array'],
};
/** Kinds whose value may be (text, email, phone) or must be (ref_many,
 * line_items) a list. */
const ARRAY_OK = new Set<FieldKind>(['text', 'email', 'phone', 'ref_many', 'line_items']);
const ARRAY_ONLY = new Set<FieldKind>(['ref_many', 'line_items']);
/** Same shape the plan contract accepts for a field key (contracts/plan.ts). */
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$/;

function kindProblem(field: FieldCap, info: SchemaPathInfo): string | undefined {
  if (info.instance === 'Mixed') return undefined;
  if (!KIND_INSTANCES[field.kind].includes(info.instance)) {
    return `kind '${field.kind}' does not fit schema type ${info.instance}${info.isArray ? '[]' : ''}`;
  }
  if (info.isArray && !ARRAY_OK.has(field.kind)) return `kind '${field.kind}' cannot hold the list stored at this path`;
  if (!info.isArray && ARRAY_ONLY.has(field.kind)) return `kind '${field.kind}' needs a list, but the schema stores one value`;
  return undefined;
}

/** True when `path` or one of its parents is in `keys`. */
function coveredBy(path: string, keys: ReadonlySet<string>): boolean {
  const parts = path.split('.');
  for (let i = parts.length; i > 0; i -= 1) if (keys.has(parts.slice(0, i).join('.'))) return true;
  return false;
}

function piiPathsFor(module: string): readonly string[] {
  const def = PII_FIELDS[module];
  return def ? [...def.level2, ...def.level3] : [];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

function check(cap: ModuleCap): string[] {
  const out: string[] = [];
  const p = (message: string) => out.push(`${cap.key}: ${message}`);

  const def = CRM_WRITE_MODULE_MAP[cap.key];
  if (!def) { p('not a CRM_WRITE_MODULE_MAP key'); return out; }
  const model = cap.model();
  if (!model?.schema) { p('model() did not return a Mongoose model'); return out; }
  fillSchemaInfo(cap);
  const paths = introspectModel(model);
  const modelName = model.modelName;
  const projected = new Set(readFieldKeysFor(cap.key));
  const fields = new Map<string, FieldCap>();

  // Labels.
  if (!cap.labels.singular.trim() || !cap.labels.plural.trim()) p('labels need a singular and a plural');
  if (cap.labels.synonyms.length === 0) p('labels.synonyms is empty');
  for (const s of cap.labels.synonyms) {
    if (!s || s !== s.trim().toLowerCase()) p(`synonym "${s}" must be trimmed and lower-case`);
  }

  // 5. Gate keys: the module map, and Daily Events where it covers the module.
  if (cap.gate.flagKey !== def.flagKey) p(`gate.flagKey "${cap.gate.flagKey}" != module map flagKey "${def.flagKey}"`);
  if (cap.gate.permPrefix !== def.permissionPrefix) p(`gate.permPrefix "${cap.gate.permPrefix}" != module map permissionPrefix "${def.permissionPrefix}"`);
  if (cap.gate.scopeKey !== def.logModule) p(`gate.scopeKey "${cap.gate.scopeKey}" != module map logModule "${def.logModule}"`);
  const des = RECORD_SOURCES.find((s) => s.module === cap.key);
  const lookup = (LOOKUP_GATES as Record<string, { flag: string; permission: string } | undefined>)[cap.key];
  for (const gate of [des, lookup]) {
    if (!gate) continue;
    if (gate.flag !== cap.gate.flagKey) p(`gate.flagKey "${cap.gate.flagKey}" != Daily Events flag "${gate.flag}"`);
    if (gate.permission !== `${cap.gate.permPrefix}.view`) p(`view permission "${cap.gate.permPrefix}.view" != Daily Events permission "${gate.permission}"`);
  }
  if (des && des.scopeKey !== cap.gate.scopeKey) p(`gate.scopeKey "${cap.gate.scopeKey}" != Daily Events scopeKey "${des.scopeKey}"`);

  // Fields: 1 (path and kind), 2 (enums), 4 (tiers, PII).
  const pii = piiPathsFor(cap.gate.scopeKey);
  for (const field of cap.fields) {
    const at = (message: string) => p(`field "${field.key}": ${message}`);
    if (!FIELD_KEY_RE.test(field.key)) at('key is not a valid plan field key');
    if (fields.has(field.key)) at('duplicate key');
    fields.set(field.key, field);
    if (field.priority !== undefined && field.read !== 'list') at('priority is only for list fields');

    if (field.virtual) {
      if (paths.has(field.path)) at('marked virtual but it is a schema path');
      else if (!isSchemaVirtual(model, field.path) && !projected.has(field.path)) {
        at(`virtual, but neither a ${modelName} schema virtual nor a key list() adds (module map read projection)`);
      }
    } else if (!field.schema) {
      at(`path "${field.path}" is not on the ${modelName} schema`);
    } else {
      const problem = kindProblem(field, field.schema);
      if (problem) at(problem);
    }

    const enumValues = field.schema?.enumValues ?? [];
    if (field.kind === 'enum') {
      if (field.enumFrom !== 'schema') at("kind 'enum' takes its values from the schema (enumFrom: 'schema')");
      if (!field.virtual && field.schema && enumValues.length === 0) at("kind 'enum' but the schema path has no enum values");
    } else if (enumValues.length > 0) {
      at(`the schema restricts it to [${enumValues.join(', ')}]: use kind 'enum' with enumFrom 'schema'`);
    }
    if (field.kind === 'stage') {
      const stage = cap.stage && 'pipeline' in cap.stage ? cap.stage : undefined;
      if (!stage || stage.field !== field.path) at("kind 'stage' is only for the module's pipeline stage field");
      if (typeof field.enumFrom !== 'object' || field.enumFrom.pipeline !== stage?.pipeline) at('enumFrom must name the stage pipeline');
    }
    if (field.enumFrom !== undefined && field.kind !== 'enum' && field.kind !== 'stage') at('enumFrom is only for enum and stage fields');

    if (field.kind === 'date' || field.kind === 'datetime') {
      if (!field.dateRule) at('a date field needs a dateRule');
      else if ((field.kind === 'date') !== (field.dateRule === 'date')) at(`kind '${field.kind}' does not match dateRule '${field.dateRule}'`);
    } else if (field.dateRule) at('dateRule is only for date fields');
    if (field.kind === 'money' && !field.money) at('a money field needs money.currency');
    if (field.money && field.kind !== 'money') at('money is only for money fields');
    if (field.money && typeof field.money.currency === 'object' && !paths.has(field.money.currency.field)) {
      at(`currency field "${field.money.currency.field}" is not on the schema`);
    }
    if (field.kind === 'duration' && !field.unit) at('a duration field needs a unit');
    if (field.unit && field.kind !== 'duration') at('unit is only for duration fields');
    if ((field.kind === 'ref' || field.kind === 'ref_many') !== !!field.ref) at('ref is required on, and only on, ref and ref_many fields');

    if (field.read !== 'hidden') {
      const top = field.path.split('.')[0];
      if (isForbiddenReadKey(top) || isForbiddenReadKey(field.key)) at('a READ_FORBIDDEN_KEYS field can only be hidden');
      if (!projected.has(top)) at("the gateway's read projection drops it (module map readFields/schemaFields), so it cannot be list or detail");
    }

    const registeredPii = pii.includes(field.path);
    if (registeredPii && !field.pii) at(`registered PII for '${cap.gate.scopeKey}' (platform/pii/constants.ts): set pii`);
    if (field.pii) {
      if (!registeredPii) at(`pii is set but the path is not registered PII for '${cap.gate.scopeKey}'`);
      if (field.pii.module !== cap.gate.scopeKey) at(`pii.module must be '${cap.gate.scopeKey}'`);
      if (field.pii.encrypted !== ENCRYPTED_PII_MODULES.has(field.pii.module)) {
        at(`pii.encrypted must be ${ENCRYPTED_PII_MODULES.has(field.pii.module)} for '${field.pii.module}'`);
      }
      if (field.pii.blindIndex && !paths.has(field.pii.blindIndex)) at(`blind index "${field.pii.blindIndex}" is not on the schema`);
      if (field.pii.encrypted && cap.sort.listSortable.includes(field.key)) at('encrypted PII is never sortable');
    }
  }

  // 3. Every schema path is classified, once.
  const ignored = Object.keys(cap.ignoredPaths);
  const fieldPaths = cap.fields.filter((fl) => !fl.virtual).map((fl) => fl.path);
  for (const key of ignored) {
    if (!paths.has(key)) p(`ignoredPaths "${key}" is not on the ${modelName} schema (remove it)`);
    if (fieldPaths.some((path) => path === key || path.startsWith(`${key}.`) || key.startsWith(`${path}.`))) {
      p(`"${key}" is both a field and an ignored path`);
    }
  }
  const classified = new Set([...fieldPaths, ...ignored]);
  for (const [path, info] of paths) {
    if (info.instance === 'Nested') continue; // its leaves are checked
    if (!coveredBy(path, classified)) p(`schema path "${path}" is not classified: add it to fields or ignoredPaths`);
  }

  // Ids.
  if (cap.ids.business) {
    const business = fields.get(cap.ids.business);
    if (!business) p(`ids.business "${cap.ids.business}" must be a field`);
    else if (business.kind !== 'id') p(`ids.business "${cap.ids.business}" must be kind 'id'`);
    const unique = hasUniqueIndexOn(model, cap.ids.business);
    if (unique !== cap.ids.businessUnique) p(`ids.businessUnique is ${cap.ids.businessUnique} but the ${modelName} schema ${unique ? 'has' : 'has no'} unique index on ${cap.ids.business}`);
  } else if (cap.ids.businessUnique) p('ids.businessUnique without ids.business');
  // Each title entry is a group of fields joined with spaces ("firstName
  // lastName"); the first non-empty group names the record.
  if (cap.ids.title.length === 0) p('ids.title is empty');
  for (const key of cap.ids.title.flatMap((group) => group.split(/\s+/).filter(Boolean))) {
    if (fields.get(key)?.read !== 'list') p(`ids.title field "${key}" must be a list field`);
  }

  // Stage: the module map's status source, and Daily Events' status spec.
  const sf = def.statusFilter;
  if (sf.kind === 'none') {
    if (cap.stage) p('the module map has no status for this module, so it has no stage');
  } else if (!cap.stage) {
    p(`the module map filters status (${sf.kind}), so stage is required`);
  } else if (sf.kind === 'pipeline') {
    const expected = def.statusField ?? 'status';
    if (!('pipeline' in cap.stage) || cap.stage.pipeline !== sf.pipelineModule) p(`stage must use pipeline '${sf.pipelineModule}' (module map)`);
    if (cap.stage.field !== expected) p(`stage.field "${cap.stage.field}" != module map status field "${expected}"`);
    if (fields.get(cap.stage.field)?.kind !== 'stage') p(`stage field "${cap.stage.field}" must be a kind 'stage' field`);
  } else {
    if (!('enumFrom' in cap.stage)) p("the module map reads status from the schema enum, so stage needs enumFrom 'schema'");
    if (cap.stage.field !== sf.field) p(`stage.field "${cap.stage.field}" != module map status field "${sf.field}"`);
    if (sf.model.modelName !== modelName) p(`module map status model ${sf.model.modelName} != ${modelName}`);
    if (fields.get(cap.stage.field)?.kind !== 'enum') p(`stage field "${cap.stage.field}" must be a kind 'enum' field`);
    if ('terminal' in cap.stage) {
      const values = paths.get(cap.stage.field)?.enumValues ?? [];
      for (const t of cap.stage.terminal) {
        if (!values.includes(t)) p(`terminal "${t}" is not a ${modelName}.${cap.stage.field} enum value [${values.join(', ')}]`);
      }
    }
  }
  if (des && cap.stage) {
    const spec = des.status;
    if (spec.field !== cap.stage.field) p(`stage.field "${cap.stage.field}" != Daily Events status field "${spec.field}"`);
    if ('pipeline' in spec && (!('pipeline' in cap.stage) || cap.stage.pipeline !== spec.pipeline)) p(`stage pipeline != Daily Events pipeline '${spec.pipeline}'`);
    if ('terminal' in spec && (!('terminal' in cap.stage) || !sameSet(cap.stage.terminal, spec.terminal))) {
      p(`stage.terminal != Daily Events terminal [${spec.terminal.join(', ')}]`);
    }
  }

  // Dates, and Daily Events' date field and DateRule where it covers the module.
  for (const [role, path] of Object.entries(cap.dates)) {
    if (!path) continue;
    const kind = fields.get(path)?.kind;
    if (kind !== 'date' && kind !== 'datetime') p(`dates.${role} "${path}" must be a date field`);
  }
  if (des) {
    const field = fields.get(des.dateField);
    if (!field) p(`Daily Events date field "${des.dateField}" must be a field`);
    else if (field.dateRule !== des.dateRule) p(`"${des.dateField}" dateRule '${field.dateRule}' != Daily Events '${des.dateRule}'`);
  }

  // Mine.
  const mine = cap.mine;
  if (mine.kind === 'owner_ids' || mine.kind === 'staff_array') {
    const field = fields.get(mine.field);
    if (!field) p(`mine field "${mine.field}" must be a field`);
    else if (mine.kind === 'staff_array' && !field.schema?.isArray) p(`mine staff_array field "${mine.field}" must be a list`);
    if (mine.kind === 'owner_ids' && mine.match.length === 0) p('mine owner_ids needs at least one match');
  } else if (mine.kind === 'created_by') {
    if (!paths.has('createdBy')) p(`mine created_by but ${modelName} has no createdBy`);
    // "Mine" is createdBy here, so a module that doesn't record it can't use it.
    if (cap.createdByRecorded === false) p('mine created_by but createdByRecorded is false');
  } else if (mine.kind === 'contact_owner') {
    if (!fields.has('contactOwner')) p('mine contact_owner needs a contactOwner field');
  } else if (!mine.reason.trim()) {
    p('mine unsupported needs a reason');
  }

  // Search and sort.
  if (cap.search.delegateToList !== true) p('search.delegateToList must be true (Increment 1)');
  // A field (any tier), so the "sorted by ..." sentence has a label.
  if (!fields.has(cap.sort.default.by) || !paths.has(cap.sort.default.by)) p(`sort.default.by "${cap.sort.default.by}" must be a stored field`);
  for (const key of cap.sort.listSortable) {
    const field = fields.get(key);
    if (!field || field.virtual) p(`listSortable "${key}" must be a stored field`);
  }

  // Table columns.
  const columns = cap.fields.filter((fl) => fl.read === 'list' && fl.priority !== undefined);
  if (!columns.some((fl) => fl.priority === 1)) p('needs at least one priority 1 table column');
  if (columns.length > VIEW_CAPS.columns) p(`${columns.length} table columns; at most ${VIEW_CAPS.columns}`);

  // 9. Routes.
  if (JSON.stringify(cap.routes) !== JSON.stringify(ROUTE_TEMPLATES[cap.key])) p('routes != ROUTE_TEMPLATES entry');

  return out;
}

/** Problems with one module entry against its real schema and the code it
 * mirrors; empty = usable. Also fills each FieldCap.schema (introspect.ts).
 * Never throws: a crash is reported as a problem, so the module is left out. */
export function validateModuleCap(cap: ModuleCap): string[] {
  try {
    return check(cap);
  } catch (err) {
    return [`${cap?.key ?? '?'}: validation failed: ${(err as Error).message}`];
  }
}

/** Cross-module checks: every module-map key has exactly one entry, no
 * synonym maps to two modules, and both ends of every ref field exist with
 * matching id formats (3.5 items 7 and 8). */
export function validateRegistry(caps: readonly ModuleCap[]): string[] {
  const out: string[] = [];
  const byKey = new Map<string, ModuleCap>();
  const count = new Map<string, number>();
  for (const cap of caps) {
    byKey.set(cap.key, cap);
    count.set(cap.key, (count.get(cap.key) ?? 0) + 1);
  }
  for (const key of Object.keys(CRM_WRITE_MODULE_MAP)) {
    const n = count.get(key) ?? 0;
    if (n !== 1) out.push(`${key}: ${n} registry entries; expected exactly 1`);
  }
  for (const key of count.keys()) {
    if (!CRM_WRITE_MODULE_MAP[key]) out.push(`${key}: registry entry for a module the module map doesn't have`);
  }

  const owner = new Map<string, string>();
  for (const cap of caps) {
    for (const raw of cap.labels.synonyms) {
      const phrase = raw.trim().toLowerCase();
      const prev = owner.get(phrase);
      if (prev === cap.key) out.push(`${cap.key}: synonym "${phrase}" is listed twice`);
      else if (prev) out.push(`synonym "${phrase}" maps to both ${prev} and ${cap.key}`);
      else owner.set(phrase, cap.key);
    }
  }

  for (const cap of caps) {
    for (const field of cap.fields) {
      if (!field.ref) continue;
      const at = `${cap.key}: field "${field.key}" refers to ${field.ref.module}.${field.ref.targetField}`;
      const target = byKey.get(field.ref.module);
      if (!target) { out.push(`${at}, but there is no ${field.ref.module} entry`); continue; }
      if (field.ref.idFormat === 'objectId' && field.ref.targetField !== '_id') out.push(`${at}: an objectId reference must target _id`);
      if (field.ref.idFormat === 'business' && field.ref.targetField !== target.ids.business) {
        out.push(`${at}: a business reference must target ${field.ref.module}'s business id (${target.ids.business ?? 'none'})`);
      }
      try {
        if (field.ref.targetField !== '_id' && !introspectModel(target.model()).has(field.ref.targetField)) {
          out.push(`${at}, which is not on the ${target.model().modelName} schema`);
        }
      } catch (err) {
        out.push(`${at}: could not read the target model (${(err as Error).message})`);
      }
    }
  }
  return out;
}
