import { logger } from '../../../utils/logger';
import type { ModuleCap } from './types';
import { NATIVE_CRM_CAPS } from './native-crm';
import { FIELD_SERVICE_CAPS } from './field-service';
import { FS_DOCUMENT_CAPS } from './fs-documents';
import { validateModuleCap } from './validate';

/* The static module registry and its lookups. Who may use which module is
 * decided per request by the gates (capability view), never here. */

export const MODULE_CAPS: readonly ModuleCap[] = [...NATIVE_CRM_CAPS, ...FIELD_SERVICE_CAPS, ...FS_DOCUMENT_CAPS];

let usable: readonly ModuleCap[] | null = null;

/** The modules that passed validation against their Mongoose schema. A module
 * that fails is left out and logged (fail closed); the server keeps running. */
export function usableModuleCaps(): readonly ModuleCap[] {
  if (!usable) {
    usable = MODULE_CAPS.filter((cap) => {
      const problems = validateModuleCap(cap);
      if (problems.length) logger.error('CRM assistant registry: module left out', { module: cap.key, problems: problems.slice(0, 10) });
      return problems.length === 0;
    });
  }
  return usable;
}

export function getModuleCap(key: string): ModuleCap | undefined {
  return usableModuleCaps().find((cap) => cap.key === key);
}

/** Every synonym phrase with its module, longest phrase first, so the grammar
 * matches "work orders" before "orders". */
export function synonymIndex(): ReadonlyArray<{ phrase: string; key: string }> {
  return usableModuleCaps()
    .flatMap((cap) => cap.labels.synonyms.map((phrase) => ({ phrase: phrase.toLowerCase(), key: cap.key })))
    .sort((a, b) => b.phrase.split(' ').length - a.phrase.split(' ').length || b.phrase.length - a.phrase.length);
}

/** For tests: forget the validated set. */
export function resetRegistryCache(): void {
  usable = null;
}
