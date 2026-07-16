import mongoose, { Schema, Document } from 'mongoose';

export interface IUserSession extends Document {
  userId:       string;
  tenantId:     string;
  tokenHash:    string;
  ip:           string;
  city?:        string;
  country?:     string;
  browser:      string;
  os:           string;
  expiresAt:    Date;
  createdAt:    Date;
}

const UserSessionSchema = new Schema<IUserSession>(
  {
    userId:    { type: String, required: true, index: true },
    tenantId:  { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    ip:        { type: String, default: 'unknown' },
    city:      { type: String },
    country:   { type: String },
    browser:   { type: String, default: 'Unknown' },
    os:        { type: String, default: 'Unknown' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Auto-delete expired sessions
UserSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
UserSessionSchema.index({ userId: 1, createdAt: -1 });
UserSessionSchema.index({ tenantId: 1 });

export const UserSession = mongoose.model<IUserSession>('UserSession', UserSessionSchema);

export function parseUserAgent(ua: string): { browser: string; os: string } {
  const browser =
    /Edg\//.test(ua)    ? 'Edge'    :
    /Chrome/.test(ua)   ? 'Chrome'  :
    /Firefox/.test(ua)  ? 'Firefox' :
    /Safari/.test(ua)   ? 'Safari'  :
    /MSIE|Trident/.test(ua) ? 'IE'  : 'Other';

  const os =
    /Windows/.test(ua)  ? 'Windows' :
    /Mac OS X/.test(ua) ? 'macOS'   :
    /iPhone/.test(ua)   ? 'iOS'     :
    /Android/.test(ua)  ? 'Android' :
    /Linux/.test(ua)    ? 'Linux'   : 'Other';

  return { browser, os };
}

export async function lookupGeo(ip: string): Promise<{ city: string; country: string }> {
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
    return { city: 'Local', country: 'Local' };
  }
  try {
    const res  = await fetch(`http://ip-api.com/json/${ip}?fields=city,country`);
    const data = await res.json() as { city?: string; country?: string };
    return { city: data.city || 'Unknown', country: data.country || 'Unknown' };
  } catch {
    return { city: 'Unknown', country: 'Unknown' };
  }
}
