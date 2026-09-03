import { IDefaultTemplate } from './types';

/** Deal -> Closed Won -> Notify Owner -> Onboarding Task -> Delay 3 days ->
 * Follow-up Task. Adapted from the original "Create Customer" sketch —
 * `customer` is not a valid create_linked_record/trigger module in this
 * engine (confirmed against automation-flow.validation.ts's moduleSchema),
 * so this template stops at Task/Email steps instead. Uses the tenant's
 * default Deal pipeline's own "closed_won" stage key (DEFAULT_STAGES.deal,
 * pipeline-config.service.ts) — a tenant who has renamed their Won stage
 * needs to re-point this trigger after loading, same limitation any
 * hand-built flow referencing a stage key already has.
 *
 * n2 (notify) uses `assigned_user`, not `record_contact`, AND runs BEFORE
 * the create_linked_record step — both corrected during Phase 4 live
 * verification against a real Deal:
 *  - `Deal` (deal.schema.ts) does have a real `contactId` column, but
 *    `createDealSchema`/`updateDealSchema` never expose it, so no HTTP path
 *    can set one directly — it's only ever populated by Lead-to-Deal
 *    conversion (lead-conversion.service.ts copies the lead's own
 *    contactId). `record_contact` would therefore silently skip for any
 *    Deal created directly ("New Deal"), which is the common case this
 *    template targets — `assigned_user` (Deal's real isAssigneeField,
 *    directly settable at creation) resolves reliably regardless of how
 *    the Deal was created.
 *  - Ordering matters independently of which strategy is used:
 *    processOneNode's create_linked_record branch reassigns the flow's own
 *    currentRecord/currentModule to the JUST-CREATED record for every
 *    subsequent node (confirmed directly in automation-flow.service.ts) —
 *    so a recipient-resolving step placed AFTER create_linked_record
 *    resolves against the new Task (which has no assignedStaffId), not the
 *    Deal, and would skip regardless of strategy. Live-tested proof: with
 *    notify placed after the task-creation step, it skipped every time;
 *    moved before it (this file), it resolves the real assigned staffer
 *    every time. */
export const dealWonOnboarding: IDefaultTemplate = {
  name: 'Deal Won → Onboarding Kickoff',
  description: 'Kicks off customer onboarding as soon as a deal is marked Closed Won: notifies the deal owner, creates a kickoff task, and schedules a 3-day follow-up.',
  category: 'Deal',
  triggerModule: 'deal',
  nodes: [
    { id: 'n1', type: 'trigger', module: 'deal', triggerType: 'status_changed', triggerStage: 'closed_won' },
    { id: 'n2', type: 'action', actionType: 'send_email', recipientStrategy: 'assigned_user' },
    {
      id: 'n3', type: 'action', actionType: 'create_linked_record', targetModule: 'task',
      fieldMappings: [{ targetField: 'title', sourceType: 'static', staticValue: 'Onboarding kickoff' }],
    },
    { id: 'n4', type: 'delay', delayMinutes: 4320 },
    {
      id: 'n5', type: 'action', actionType: 'create_linked_record', targetModule: 'task',
      fieldMappings: [{ targetField: 'title', sourceType: 'static', staticValue: 'Onboarding follow-up' }],
    },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5' },
  ],
};
