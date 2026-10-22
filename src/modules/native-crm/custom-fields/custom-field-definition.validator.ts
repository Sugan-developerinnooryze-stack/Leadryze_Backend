import { CustomFieldType } from './custom-field.model';

const FIELD_TYPES = new Set<CustomFieldType>([
  'text', 'textarea', 'number', 'currency', 'checkbox',
  'radio', 'dropdown', 'multi_select', 'date', 'datetime',
  'email', 'phone', 'url', 'rating', 'boolean',
  'image', 'images', 'video', 'videos', 'custom_form',
]);

/** The real built-in modules this can attach to — mirrors
 * CustomFieldsAdminPage.tsx's own NATIVE_CRM_MODULES + FIELD_SERVICE_MODULES
 * exactly (the only existing curation of this list; the backend model
 * itself has no enum). Deliberately EXCLUDES `custom:<slug>` targets —
 * Custom Modules already have their own, separate field-builder
 * (CustomModuleBuilderPage.tsx / assertValidModuleDefinition), so a chat-
 * driven "add a field" request should never be routed through this system
 * for a Custom Module target; that's what crm_propose_custom_module's own
 * field list is for. */
export const VALID_CUSTOM_FIELD_MODULES = new Set([
  'contacts', 'companies', 'tasks', 'tickets', 'calls', 'meetings',
  'leads', 'deals', 'categories', 'services', 'teams', 'staffs',
  'customers', 'sites', 'parts', 'quotations', 'workorders', 'contracts', 'invoices',
  'receipts', 'expenses', 'activities', 'products', 'assets', 'vehicles',
]);

const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface CustomFieldDefinitionInput {
  module?: string;
  fieldKey?: string;
  label?: string;
  fieldType?: string;
  options?: string[];
  formTemplateId?: string;
}

/** Validates a single Custom Field definition (an extra field on an
 * EXISTING built-in module — NOT a Custom Module's own field, a genuinely
 * separate system, see this file's own module-level doc comment and the
 * plan's Area 1 table). Mirrors custom-module-definition.validator.ts's
 * own shape/conventions closely: throws a plain Error listing every
 * problem found, pure function, no DB access — callers supply
 * `existingKeys` (this module+branch's other field keys) themselves. */
export function assertValidCustomFieldDefinition(
  dto: CustomFieldDefinitionInput,
  existingKeys: string[],
): void {
  const problems: string[] = [];

  if (!dto.module || !VALID_CUSTOM_FIELD_MODULES.has(dto.module)) {
    problems.push(`"${dto.module}" is not a recognized built-in module for a custom field — use one of: ${[...VALID_CUSTOM_FIELD_MODULES].join(', ')}`);
  }
  if (!dto.label?.trim()) {
    problems.push('A field label is required');
  }
  if (!dto.fieldKey || !FIELD_KEY_RE.test(dto.fieldKey)) {
    problems.push('Field key is invalid — keys must start with a letter and contain only letters, numbers, and underscores');
  } else if (existingKeys.includes(dto.fieldKey)) {
    problems.push(`A custom field with key "${dto.fieldKey}" already exists on this module`);
  }

  if (!dto.fieldType || !FIELD_TYPES.has(dto.fieldType as CustomFieldType)) {
    problems.push(`"${dto.fieldType}" is not a supported field type`);
  } else {
    switch (dto.fieldType as CustomFieldType) {
      case 'dropdown':
      case 'multi_select':
      case 'radio': {
        const options = dto.options ?? [];
        if (options.length === 0) {
          problems.push(`A "${dto.fieldType}" field needs at least one option`);
        } else if (new Set(options).size !== options.length) {
          problems.push(`"${dto.label}" has duplicate options`);
        }
        break;
      }
      case 'custom_form':
        if (!dto.formTemplateId?.trim()) {
          problems.push('A "custom_form" field needs a formTemplateId');
        }
        break;
      default:
        break;
    }
  }

  if (problems.length) {
    throw new Error(`Invalid custom field definition: ${problems.join('; ')}`);
  }
}
