import type { SourceKey } from '../contracts/plan';

/** The one source-label map for the assistant's badges and sections, matching
 * the sidebar groups. Numbers from different sources are never added. */
export const SOURCE_LABELS: Readonly<Record<SourceKey, string>> = {
  native_crm: 'Native CRM',
  field_service: 'Field Service',
  custom_module: 'Custom Modules',
  'connector:zoho': 'Zoho CRM',
  'connector:salesforce': 'Salesforce',
  'connector:hubspot': 'HubSpot',
};
