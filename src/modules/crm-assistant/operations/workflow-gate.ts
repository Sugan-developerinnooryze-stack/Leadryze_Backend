import { engineModeFor } from '../../../config';
import { getCrmAssistantConfig } from '../../ai/crm-assistant-settings.service';

/** "Workflows effective" (L7, spec B1): the tenant's Guided forms switch is
 * on, Visual answers is on, and the assistant engine is on for this tenant.
 * The one implementation every write path asks before it starts a form
 * (resolve, execute and the `start` input in assist.internal.routes.ts) and
 * that the legacy /crm-write warning uses (internal.routes.ts).
 *
 * SUPER_ADMIN skips the two settings, as isCrmAssistantFeatureEnabled does;
 * the engine mode still applies. Everyone else costs one settings read,
 * through getCrmAssistantConfig, whose workflowsEffective is this same rule,
 * so the chat panel and the server can never disagree. A failed settings
 * read rejects: every call site fails closed with `.catch(() => false)`. */
export async function isWorkflowsEffective(tenantId: string, role: string | undefined): Promise<boolean> {
  if (engineModeFor(tenantId) !== 'on') return false;
  if (role === 'SUPER_ADMIN') return true;
  return (await getCrmAssistantConfig(tenantId)).workflowsEffective;
}
