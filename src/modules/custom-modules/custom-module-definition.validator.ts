import { ICustomModuleField, CustomModuleFieldType } from './custom-module.model';

const FIELD_TYPES = new Set<CustomModuleFieldType>([
  'text', 'email', 'phone', 'number', 'currency',
  'date', 'datetime', 'textarea', 'boolean', 'url', 'rating',
  'select', 'multiselect', 'relationship',
  'image', 'images',
  'categoryselect',
  'table',
]);

const TABLE_COLUMN_TYPES = new Set(['text', 'number', 'dropdown', 'formula']);

/** Reserved slugs a new custom module must never collide with — the real
 * native modules this tenant's own CRM already has, by their own
 * `toSlug()`-equivalent lowercase key. A custom module named "Leads" would
 * otherwise slug to "leads" and collide with the real native Leads module,
 * confirmed as unchecked by createCustomModule's own uniqueness loop (which
 * only compares against this tenant's OTHER custom-module slugs). */
export const RESERVED_NATIVE_SLUGS = new Set([
  'lead', 'leads', 'deal', 'deals', 'company', 'companies',
  'task', 'tasks', 'ticket', 'tickets', 'call', 'calls', 'meeting', 'meetings',
  'workorder', 'workorders', 'work-order', 'work-orders',
  'invoice', 'invoices', 'quotation', 'quotations', 'contract', 'contracts', 'receipt', 'receipts',
  'category', 'categories', 'service', 'services', 'part', 'parts',
  'product', 'products', 'asset', 'assets', 'vehicle', 'vehicles', 'expense', 'expenses',
  'site', 'sites', 'team', 'teams', 'staff', 'staffs', 'customer', 'customers', 'branch', 'branches',
  'contact', 'contacts',
]);

const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface ModuleDefinitionInput {
  name?: string;
  slug?: string;
  fields?: ICustomModuleField[];
}

function collectFieldProblems(fields: ICustomModuleField[], nativeAndCustomSlugs: Set<string>): string[] {
  const problems: string[] = [];
  const seenKeys = new Set<string>();

  for (const field of fields) {
    if (!field.key || !FIELD_KEY_RE.test(field.key)) {
      problems.push(`Field "${field.label || field.key || '?'}" has an invalid key — keys must start with a letter and contain only letters, numbers, and underscores`);
      continue;
    }
    if (seenKeys.has(field.key)) {
      problems.push(`Duplicate field key "${field.key}"`);
      continue;
    }
    seenKeys.add(field.key);

    if (!FIELD_TYPES.has(field.fieldType)) {
      problems.push(`Field "${field.label}" has an unsupported type "${field.fieldType}"`);
      continue;
    }

    switch (field.fieldType) {
      case 'select':
      case 'multiselect':
      case 'categoryselect': {
        const options = field.options ?? [];
        if (options.length === 0) {
          problems.push(`Field "${field.label}" (${field.fieldType}) needs at least one option`);
        } else {
          const dedup = new Set(options);
          if (dedup.size !== options.length) {
            problems.push(`Field "${field.label}" has duplicate options`);
          }
        }
        break;
      }
      case 'relationship': {
        const target = field.meta?.targetModule;
        if (!target) {
          problems.push(`Field "${field.label}" (relationship) needs a target module`);
        } else if (!nativeAndCustomSlugs.has(target)) {
          problems.push(`Field "${field.label}" targets "${target}", which isn't a real native module or an existing custom module`);
        }
        break;
      }
      case 'table': {
        if (field.required) {
          problems.push(`Field "${field.label}" (table) cannot be marked required — "required" has no defined meaning for a table/grid field`);
        }
        const columns = field.meta?.columns ?? [];
        if (columns.length === 0) {
          problems.push(`Field "${field.label}" (table) needs at least one column`);
        } else {
          const colKeys = new Set<string>();
          for (const col of columns) {
            if (colKeys.has(col.key)) {
              problems.push(`Field "${field.label}" has duplicate table column key "${col.key}"`);
            }
            colKeys.add(col.key);
            if (!TABLE_COLUMN_TYPES.has(col.type)) {
              problems.push(`Field "${field.label}" has an invalid table column type "${col.type}" for column "${col.key}"`);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return problems;
}

/** Full check for a new module's own identity (name/slug collisions) plus
 * its field list — used at CREATE time, where a slug is actually being
 * assigned. Throws a plain Error (same convention as
 * assertValidRecordData/assertValidPipelineField in custom-module.service.ts)
 * listing every problem found, not just the first. Pure function: no DB
 * access — callers supply `existingSlugs` (this tenant's other custom-
 * module slugs) and `candidateSlug` (the slug this definition would get)
 * themselves. */
export function assertValidModuleDefinition(
  dto: ModuleDefinitionInput,
  candidateSlug: string,
  existingSlugs: string[],
): void {
  const problems: string[] = [];

  if (!dto.name?.trim()) {
    problems.push('A module name is required');
  }
  if (RESERVED_NATIVE_SLUGS.has(candidateSlug)) {
    problems.push(`"${dto.name}" is too close to an existing native CRM module name — choose a different name`);
  }
  if (existingSlugs.includes(candidateSlug)) {
    problems.push(`A custom module with a matching name/slug ("${candidateSlug}") already exists for this tenant`);
  }

  const nativeAndCustomSlugs = new Set([...RESERVED_NATIVE_SLUGS, ...existingSlugs, candidateSlug]);
  problems.push(...collectFieldProblems(dto.fields ?? [], nativeAndCustomSlugs));

  if (problems.length) {
    throw new Error(`Invalid module definition: ${problems.join('; ')}`);
  }
}

/** Fields-only check for an existing module — used at UPDATE time.
 * `updateCustomModule` never changes a module's slug post-create (confirmed
 * by direct read: it strips `slug` from the dto before persisting), so
 * there is no slug/name collision to re-check on update — only the field
 * list, and only the fields actually being set. Callers are responsible for
 * merging onto the module's existing fields first when the update is
 * partial (e.g. renaming the module without touching fields) — this
 * function validates exactly the field array it's given, nothing more. */
export function assertValidModuleFields(fields: ICustomModuleField[], existingSlugs: string[], ownSlug: string): void {
  const nativeAndCustomSlugs = new Set([...RESERVED_NATIVE_SLUGS, ...existingSlugs, ownSlug]);
  const problems = collectFieldProblems(fields, nativeAndCustomSlugs);
  if (problems.length) {
    throw new Error(`Invalid module definition: ${problems.join('; ')}`);
  }
}
