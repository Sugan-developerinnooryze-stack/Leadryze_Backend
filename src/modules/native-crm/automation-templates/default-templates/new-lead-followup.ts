import { IDefaultTemplate } from './types';

/** Lead Created -> Is email available? -> [YES: Welcome Email] / [NO: Create
 * "Contact lead manually" task]. */
export const newLeadFollowup: IDefaultTemplate = {
  name: 'New Lead Follow-up',
  description: 'Welcomes a new lead by email, or creates a manual follow-up task when no email address was captured.',
  category: 'Lead',
  triggerModule: 'lead',
  nodes: [
    { id: 'n1', type: 'trigger', module: 'lead', triggerType: 'record_created' },
    { id: 'n2', type: 'condition', conditions: [{ field: 'email', operator: 'is_not_empty' }] },
    { id: 'n3', type: 'action', actionType: 'send_email', recipientStrategy: 'record_contact' },
    {
      id: 'n4', type: 'action', actionType: 'create_linked_record', targetModule: 'task',
      fieldMappings: [{ targetField: 'title', sourceType: 'static', staticValue: 'Contact lead manually' }],
    },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3', fromPort: 'true' },
    { from: 'n2', to: 'n4', fromPort: 'false' },
  ],
};
