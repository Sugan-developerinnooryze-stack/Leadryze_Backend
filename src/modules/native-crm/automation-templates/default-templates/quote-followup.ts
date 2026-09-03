import { IDefaultTemplate } from './types';

/** Quotation Created -> Send Quote -> Delay 3 days -> still unresolved? ->
 * Follow-up Email -> Delay 4 days -> still unresolved? -> Create Task.
 * "Unresolved" uses `status not_in_list "approved,rejected"` rather than a
 * literal "pending" stage — DEFAULT_STAGES.quotation has no such key
 * (draft/sent/approved/rejected), and this reads correctly regardless of
 * whether the tenant's own draft/sent labels are renamed. */
export const quoteFollowup: IDefaultTemplate = {
  name: 'Quote Follow-up',
  description: 'Sends the quote, then follows up twice (after 3 and 7 total days) while it remains neither approved nor rejected, finally creating a sales task if it is still unresolved.',
  category: 'Quotation',
  triggerModule: 'quotation',
  nodes: [
    { id: 'n1', type: 'trigger', module: 'quotation', triggerType: 'record_created' },
    { id: 'n2', type: 'action', actionType: 'send_email', recipientStrategy: 'record_contact' },
    { id: 'n3', type: 'delay', delayMinutes: 4320 },
    { id: 'n4', type: 'condition', conditions: [{ field: 'status', operator: 'not_in_list', value: 'approved,rejected' }] },
    { id: 'n5', type: 'action', actionType: 'send_email', recipientStrategy: 'record_contact' },
    { id: 'n6', type: 'delay', delayMinutes: 5760 },
    { id: 'n7', type: 'condition', conditions: [{ field: 'status', operator: 'not_in_list', value: 'approved,rejected' }] },
    {
      id: 'n8', type: 'action', actionType: 'create_linked_record', targetModule: 'task',
      fieldMappings: [{ targetField: 'title', sourceType: 'static', staticValue: 'Follow up on quote' }],
    },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5', fromPort: 'true' },
    { from: 'n5', to: 'n6' },
    { from: 'n6', to: 'n7' },
    { from: 'n7', to: 'n8', fromPort: 'true' },
  ],
};
