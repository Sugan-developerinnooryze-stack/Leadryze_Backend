import { IDefaultTemplate } from './types';
import { newLeadFollowup } from './new-lead-followup';
import { hotLeadAlert } from './hot-lead-alert';
import { dealWonOnboarding } from './deal-won-onboarding';
import { quoteFollowup } from './quote-followup';
import { ticketEscalation } from './ticket-escalation';

export const DEFAULT_TEMPLATES: IDefaultTemplate[] = [
  newLeadFollowup,
  hotLeadAlert,
  dealWonOnboarding,
  quoteFollowup,
  ticketEscalation,
];
