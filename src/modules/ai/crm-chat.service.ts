import axios from 'axios';
import jwt from 'jsonwebtoken';
import { config } from '../../config';

const aiHeaders = { 'x-api-key': config.ai.internalApiKey };
const AI_URL = config.app.aiServiceUrl;

export interface CrmChatForwardInput {
  tenantId: string;
  role: string;
  roleId?: string;
  userId: string;
  branchId?: string | null;
  sessionId: string;
  message?: string;
  confirmationAction?: { operationId: string; decision: 'confirm' | 'cancel' };
}

/** Mints the exact same shape of short-lived internalAuth JWT ai.routes.ts's
 * own /chat handler already mints (same secret, same 2-minute expiry, same
 * claim set) — the CRM assistant's identity story is intentionally
 * byte-identical to the existing public-widget-facing proxy's, not a new
 * auth mechanism. */
export function mintCrmChatInternalAuth(input: Pick<CrmChatForwardInput, 'tenantId' | 'role' | 'roleId' | 'userId' | 'branchId'>): string {
  return jwt.sign(
    { tenantId: input.tenantId, role: input.role, roleId: input.roleId, userId: input.userId, branchId: input.branchId ?? null },
    config.jwt.secret, { expiresIn: '2m' },
  );
}

/** Forwards one CRM-assistant turn to the AI microservice's own /api/crm-chat
 * route (ai/src/api/crm-chat.routes.ts) — a route that exists solely for
 * this feature, never the public widget's /api/chat. */
export async function forwardCrmChat(input: CrmChatForwardInput): Promise<any> {
  const internalAuth = mintCrmChatInternalAuth(input);
  const response = await axios.post(
    `${AI_URL}/api/crm-chat`,
    {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      message: input.message,
      confirmationAction: input.confirmationAction,
      internalAuth,
    },
    // Same generous timeout as the public widget's own /chat proxy — real
    // tool-calling (schema lookup, customer search, propose/execute write)
    // can legitimately take several LLM round-trips.
    { headers: aiHeaders, timeout: 100000 },
  );
  return response.data.data;
}
