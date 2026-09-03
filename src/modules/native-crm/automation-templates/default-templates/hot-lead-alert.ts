import { IDefaultTemplate } from './types';

/** Lead Created -> Rating = Hot? -> Assign Salesperson -> Email Salesperson
 * -> Create Follow-up Task -> Delay 1 day -> Still not contacted? -> Notify
 * Manager. The "Assign to" staff and the two email bodies are deliberately
 * left unconfigured (see automation-template.service.ts's own note) — a
 * system template can't know a specific tenant's staff/message content. */
export const hotLeadAlert: IDefaultTemplate = {
  name: 'Hot Lead Sales Alert',
  description: 'Assigns a hot lead to a salesperson, alerts them, and escalates to a manager if the lead is still not contacted after a day.',
  category: 'Lead',
  triggerModule: 'lead',
  nodes: [
    { id: 'n1', type: 'trigger', module: 'lead', triggerType: 'record_created' },
    { id: 'n2', type: 'condition', conditions: [{ field: 'rating', operator: '=', value: 'hot' }] },
    {
      id: 'n3', type: 'action', actionType: 'assign_record',
      fieldMappings: [{ targetField: 'leadOwnerStaffId', sourceType: 'static', staticValue: '' }],
    },
    { id: 'n4', type: 'action', actionType: 'send_email', recipientStrategy: 'assigned_user' },
    {
      id: 'n5', type: 'action', actionType: 'create_linked_record', targetModule: 'task',
      fieldMappings: [{ targetField: 'title', sourceType: 'static', staticValue: 'Follow up with hot lead' }],
    },
    { id: 'n6', type: 'delay', delayMinutes: 1440 },
    { id: 'n7', type: 'condition', conditions: [{ field: 'status', operator: '!=', value: 'contacted' }] },
    { id: 'n8', type: 'action', actionType: 'send_email', recipientStrategy: 'manager' },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3', fromPort: 'true' },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5' },
    { from: 'n5', to: 'n6' },
    { from: 'n6', to: 'n7' },
    { from: 'n7', to: 'n8', fromPort: 'true' },
  ],
};
