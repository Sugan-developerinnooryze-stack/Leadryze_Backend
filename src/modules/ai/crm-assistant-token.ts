import type { JwtPayload } from 'jsonwebtoken';

/** `aud` of the CRM assistant's internalAuth token (minted by
 * mintCrmChatInternalAuth in crm-chat.service.ts). It is signed with the
 * login secret but is meant only for the internal CRM gateway, so
 * authenticate() refuses it: an assistant token can never act as a login
 * session on /api/v1. Login tokens carry no audience.
 *
 * Lives here, in a file with no runtime imports, so the minting side and
 * every checking side share one value, and a test that jest.mocks one of
 * them (say auth.middleware) can't leave the other with an undefined
 * audience, which jwt.sign rejects. */
export const CRM_ASSISTANT_AUDIENCE = 'crm-assistant';

/** True for a verified payload minted for the CRM assistant: its `aud` is
 * "crm-assistant", or a list that includes it. */
export function isCrmAssistantToken(payload: JwtPayload): boolean {
  const { aud } = payload;
  return aud === CRM_ASSISTANT_AUDIENCE || (Array.isArray(aud) && aud.includes(CRM_ASSISTANT_AUDIENCE));
}
