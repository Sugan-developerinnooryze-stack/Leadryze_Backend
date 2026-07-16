import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { config } from '../../config';
import { Tenant } from '../tenants/tenant.model';

export type AppUserType = 'staff' | 'customer';

export interface AppJwtPayload {
  sub:      string;        // Mongo _id of the staff/customer document
  code:     string;        // human code: BADE2FF4-ST-0001 / BADE2FF4-CUS-0001
  tenantId: string;
  clientId: string;
  type:     AppUserType;
}

export function signAppToken(payload: AppJwtPayload): string {
  return jwt.sign(payload as any, config.jwt.appSecret, {
    expiresIn: config.jwt.appExpiresIn,
  } as jwt.SignOptions);
}

export function verifyAppToken(token: string): AppJwtPayload {
  return jwt.verify(token, config.jwt.appSecret) as AppJwtPayload;
}

export class InvalidCredentialsError extends Error {
  constructor() { super('Invalid credentials'); }
}

/**
 * Shared login: resolve tenant by clientId, find the account by per-tenant
 * username, verify password against the bcrypt hash. All failures throw the
 * same InvalidCredentialsError so responses stay uniform.
 */
export async function loginAppUser(
  model: Model<any>,
  type: AppUserType,
  clientId: string,
  username: string,
  password: string,
  codeField: 'staffId' | 'customerId',
) {
  const tenant = await Tenant.findOne({ clientId: clientId.trim().toUpperCase() })
    .select('_id clientId')
    .lean();
  if (!tenant) throw new InvalidCredentialsError();

  const account = await model.findOne({
    tenantId: tenant._id,
    appUsername: username.trim().toLowerCase(),
  }).select('+appPasswordHash');
  if (!account || !account.appPasswordHash) throw new InvalidCredentialsError();
  if (account.status && account.status !== 'active') throw new InvalidCredentialsError();

  const ok = await bcrypt.compare(password, account.appPasswordHash);
  if (!ok) throw new InvalidCredentialsError();

  model.updateOne({ _id: account._id }, { $set: { appLastLoginAt: new Date() } }).catch(() => {});

  const token = signAppToken({
    sub:      String(account._id),
    code:     account[codeField] ?? '',
    tenantId: String(tenant._id),
    clientId: (tenant as any).clientId ?? '',
    type,
  });

  return { token, account };
}
