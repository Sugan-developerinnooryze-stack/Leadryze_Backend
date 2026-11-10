import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config';
import { CRM_ASSISTANT_AUDIENCE } from '../ai/crm-assistant-token';
import { meetsRoleIdRule } from './gates';

/* Who is asking, for every assistant-engine route. The identity comes only
 * from the internalAuth token the backend minted for the staff member
 * (mintCrmChatInternalAuth, crm-chat.service.ts) and the AI service forwards
 * in the x-internal-auth header: never from the body or the query string,
 * and never from a login token (the audience "crm-assistant" is required). */

export const ASSIST_AUTH_HEADER = 'x-internal-auth';
const HEX_ID = /^[a-f0-9]{24}$/i;

export interface AssistIdentity {
  tenantId: string;
  userId: string;
  role: string;
  /** Absent only for SUPER_ADMIN / TENANT_ADMIN (the roleId rule, gates.ts). */
  roleId?: string;
  /** The caller's selected branch; null = all branches. */
  branchId: string | null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** The verified identity, or null when anything is wrong: no header (a
 * token in the query string or body is ignored), a bad signature, an
 * expired token, a missing or different audience, a token for another
 * tenant than the URL's, no userId or role, a missing roleId for a role
 * that needs one, or a malformed branch id. */
export function verifyAssistIdentity(urlTenantId: string, req: Request): AssistIdentity | null {
  const header = req.headers[ASSIST_AUTH_HEADER];
  if (typeof header !== 'string' || !header) return null;
  if (!HEX_ID.test(urlTenantId)) return null;

  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(header, config.jwt.secret, { audience: CRM_ASSISTANT_AUDIENCE, algorithms: ['HS256'] });
    if (!decoded || typeof decoded !== 'object') return null;
    payload = decoded as jwt.JwtPayload;
  } catch {
    return null;
  }

  if (payload.tenantId !== urlTenantId) return null;
  const userId = nonEmptyString(payload.userId);
  const role = nonEmptyString(payload.role);
  const roleId = nonEmptyString(payload.roleId);
  if (!userId || !role) return null;
  if (!meetsRoleIdRule({ userId, role, roleId })) return null;

  const rawBranch = payload.branchId === '' ? null : payload.branchId;
  if (rawBranch !== undefined && rawBranch !== null && !(typeof rawBranch === 'string' && HEX_ID.test(rawBranch))) {
    return null;
  }
  const branchId = typeof rawBranch === 'string' ? rawBranch : null;

  return { tenantId: urlTenantId, userId, role, ...(roleId ? { roleId } : {}), branchId };
}
