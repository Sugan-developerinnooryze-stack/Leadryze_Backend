import type { SideEffect } from '../contracts/views';
import type { ModuleCap } from '../registry/types';
import type { WorkflowModule } from '../writes/workflow-types';
import { getModuleCap } from '../registry';
import { getRecordWriteHooks } from '../../native-crm/shared/record-write-hooks';
import { ASSISTANT_STAMPED_MODULES } from '../../internal/crm-gateway.helpers';

/* What else happens when a staged change is applied, in plain words (plan
 * 5.7). A small manifest per module and operation; side effects the
 * assistant never runs are always listed, so the card never implies an
 * email, automation or share that won't happen. Texts only: no values.
 *
 * The existing assistant's proposals (sideEffectsFor, operationWarningsFor)
 * use the manifest below. A guided form (Increment 6) uses its WriteCap's
 * own manifest plus the lines its rules add (workflowSideEffects); the
 * never-run and later lines are the same for both. */

type Op = 'create' | 'update' | 'delete';

interface ModuleManifest {
  /** Extra 'will' lines per operation. */
  will?: Partial<Record<Op, string[]>>;
  /** Extra 'blocked' lines per operation. */
  blocked?: Partial<Record<Op, string[]>>;
}

const MANIFEST: Readonly<Record<string, ModuleManifest>> = {
  workorder: {
    will: { update: ['If auto-lock is set up, a work order moved to its completed stage is locked.'] },
  },
  invoice: {
    will: { update: ['If auto-lock is set up, an invoice moved to its paid stage is locked.'] },
    blocked: { create: ['Line items, totals and payments are set on the invoice page.'], update: ['Line items, totals and payments are changed on the invoice page.'] },
  },
  ticket: { will: { update: ['Changing the priority recalculates the SLA due dates.'] } },
  customer: {
    will: { create: ['App login details are prepared for the new customer. Nothing is sent to them.'] },
    blocked: { delete: ['The delete is refused while work orders, quotations, invoices, receipts or contracts are linked to the customer.'] },
  },
  staff: { will: { create: ['App login details are prepared for the new staff member. Nothing is sent to them.'] } },
  contact: { blocked: { delete: ['The delete is refused while deals or leads are linked to the contact.'] } },
  company: { blocked: { delete: ['The delete is refused while contacts or deals are linked to the company.'] } },
};

const NOT_RUN: readonly string[] = [
  'Automations and workflows are not run for changes made in the assistant.',
  'No email, SMS or WhatsApp message is sent.',
  'No PDF is shared and no customer portal link is created.',
];

const LATER = 'Scheduled automation rules may still act on this record later, like on any other record.';

/** The reminder pause line of a call, task or ticket create or update
 * (ASSISTANT_STAMPED_MODULES): the write pauses its customer reminders. */
function stampedPauseText(singular: string, op: 'create' | 'update'): string {
  return op === 'create'
    ? `Customer reminders and confirmations for this ${singular} are paused until someone changes it on the screen.`
    : `If this changes when or with whom the ${singular} happens, its customer reminders are paused until someone changes it on the screen.`;
}

export function sideEffectsFor(cap: ModuleCap, op: Op): SideEffect[] {
  const out: SideEffect[] = [];
  const singular = cap.labels.singular.toLowerCase();
  const manifest = MANIFEST[cap.key] ?? {};

  if (op === 'create' && cap.ids.business) out.push({ kind: 'will', text: `A ${singular} number is assigned when it is saved.` });
  if (getRecordWriteHooks(cap.key)) {
    out.push({ kind: 'will', text: 'The record timeline and search are updated, as when you save on the screen.' });
  }
  for (const text of manifest.will?.[op] ?? []) out.push({ kind: 'will', text });
  if (op !== 'delete' && ASSISTANT_STAMPED_MODULES.has(cap.key)) {
    out.push({ kind: 'will', text: stampedPauseText(singular, op) });
  }
  for (const text of NOT_RUN) out.push({ kind: 'not_run', text });
  if (op !== 'delete') out.push({ kind: 'later', text: LATER });
  for (const text of manifest.blocked?.[op] ?? []) out.push({ kind: 'blocked', text });
  return out;
}

/** Warnings shown on the card for an operation. */
export function operationWarningsFor(cap: ModuleCap, op: Op): string[] {
  if (cap.key === 'workorder' && op === 'delete') {
    return ['If this work order came from a contract visit, that visit stays scheduled.'];
  }
  return [];
}

/** A guided form's lines (Increment 6, spec B11), in this order: the
 * WriteCap manifest's `will`, the rules' `will`, the reminder pause (call,
 * task, ticket), the rules' `linked`, the never-run lines, the later lines
 * (the scheduled-rules line on a create or update, unless no rule or flow
 * can target the module (`noScheduledRules`, Increment 7); the manifest's;
 * plus any the rules add), then the manifest's and the rules' `blocked`.
 * `extra` is what the module's rules gave for this change. A line given
 * twice is listed once. */
export function workflowSideEffects(wf: WorkflowModule, op: Op, extra: SideEffect[]): SideEffect[] {
  const { manifest } = wf.cap;
  const fromExtra = (kind: SideEffect['kind']) => extra.filter((s) => s.kind === kind).map((s) => s.text);
  const singular = () => (getModuleCap(wf.cap.module)?.labels.singular ?? wf.cap.module).toLowerCase();
  const groups: Array<[SideEffect['kind'], readonly string[]]> = [
    ['will', manifest.will?.[op] ?? []],
    ['will', fromExtra('will')],
    ['will', op !== 'delete' && manifest.stampedPause ? [stampedPauseText(singular(), op)] : []],
    ['linked', fromExtra('linked')],
    ['not_run', NOT_RUN],
    ['not_run', fromExtra('not_run')],
    ['later', op !== 'delete' && !manifest.noScheduledRules ? [LATER, ...(manifest.later?.[op] ?? [])] : (manifest.later?.[op] ?? [])],
    ['later', fromExtra('later')],
    ['blocked', manifest.blocked?.[op] ?? []],
    ['blocked', fromExtra('blocked')],
  ];
  const out: SideEffect[] = [];
  const seen = new Set<string>();
  for (const [kind, texts] of groups) {
    for (const text of texts) {
      if (seen.has(`${kind}:${text}`)) continue;
      seen.add(`${kind}:${text}`);
      out.push({ kind, text });
    }
  }
  return out;
}
