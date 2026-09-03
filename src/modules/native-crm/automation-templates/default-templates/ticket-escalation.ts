import { IDefaultTemplate } from './types';

/** High-priority Ticket Created -> Notify Manager -> Delay 2 hours -> still
 * unresolved? -> Escalate to Manager -> Create Task. "Assign Support
 * Manager" from the original sketch is adapted to a manager-notification
 * email instead — Ticket has no isAssigneeField in the catalog (confirmed:
 * subject/priority/ticketStatus/description/contactName only), so
 * assign_record has nothing to target here; notifying a manager achieves
 * the same real escalation outcome via an already-supported strategy. */
export const ticketEscalation: IDefaultTemplate = {
  name: 'Ticket Escalation',
  description: 'Notifies a manager the moment a high-priority ticket is created, then escalates further and creates a follow-up task if it is still unresolved after 2 hours.',
  category: 'Ticket',
  triggerModule: 'ticket',
  nodes: [
    { id: 'n1', type: 'trigger', module: 'ticket', triggerType: 'record_created' },
    { id: 'n2', type: 'condition', conditions: [{ field: 'priority', operator: '=', value: 'high' }] },
    { id: 'n3', type: 'action', actionType: 'send_email', recipientStrategy: 'manager' },
    { id: 'n4', type: 'delay', delayMinutes: 120 },
    { id: 'n5', type: 'condition', conditions: [{ field: 'ticketStatus', operator: 'not_in_list', value: 'resolved,closed' }] },
    { id: 'n6', type: 'action', actionType: 'send_email', recipientStrategy: 'manager' },
    {
      id: 'n7', type: 'action', actionType: 'create_linked_record', targetModule: 'task',
      fieldMappings: [{ targetField: 'title', sourceType: 'static', staticValue: 'Ticket escalation follow-up' }],
    },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3', fromPort: 'true' },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5' },
    { from: 'n5', to: 'n6', fromPort: 'true' },
    { from: 'n6', to: 'n7' },
  ],
};
