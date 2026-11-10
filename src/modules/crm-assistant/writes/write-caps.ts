import type { WriteCap } from '../registry/types';
import type { WorkflowModule } from './workflow-types';
import { WORKORDER_WORKFLOW } from './workorder.workflow';
import { INVOICE_WORKFLOW } from './invoice.workflow';
import { QUOTATION_WORKFLOW } from './quotation.workflow';
import { SIMPLE_WORKFLOWS } from './simple.workflow';
import { REFERENCE_WORKFLOWS } from './fs-reference.workflow';

/* The guided forms' write capabilities, one WorkflowModule per module of the
 * 22 whose chat writes go through a guided form or a refusal notice
 * (workflow-modules.ts): the work order's (workorder.workflow.ts), the
 * invoice's (invoice.workflow.ts), the quotation's (quotation.workflow.ts),
 * the nine simple ones of Increment 6 (simple.workflow.ts) and the ten of
 * Increment 7 (fs-reference.workflow.ts). WriteCaps are kept apart from the
 * registry's ModuleCap on purpose (no registry cycle); this lookup is the only
 * way the lifecycle, the grammar and the planner reach one, and it uses no
 * other source, so a module without an entry here has no guided form. */

/** The module's guided form, or undefined when it has none. */
export function workflowModuleFor(module: string): WorkflowModule | undefined {
  if (module === 'workorder') return WORKORDER_WORKFLOW;
  if (module === 'invoice') return INVOICE_WORKFLOW;
  if (module === 'quotation') return QUOTATION_WORKFLOW;
  if (Object.prototype.hasOwnProperty.call(SIMPLE_WORKFLOWS, module)) {
    return SIMPLE_WORKFLOWS[module as keyof typeof SIMPLE_WORKFLOWS];
  }
  if (Object.prototype.hasOwnProperty.call(REFERENCE_WORKFLOWS, module)) {
    return REFERENCE_WORKFLOWS[module as keyof typeof REFERENCE_WORKFLOWS];
  }
  return undefined;
}

/** The module's WriteCap, or undefined when it has no guided form. */
export function writeCapFor(module: string): WriteCap | undefined {
  return workflowModuleFor(module)?.cap;
}
