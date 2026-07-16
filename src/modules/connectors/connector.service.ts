import mongoose from 'mongoose';
import axios from 'axios';
import { Connector, IConnector } from './connector.model';
import { Customer } from '../customers/customer.model';
import { logger } from '../../utils/logger';
import { upsertCRMRecords, deleteMissingCRMRecords, renameCRMModule, purgeChannelRecords } from '../crm/crm-record.service';
import { writeLog } from '../logs/log.service';
import { encrypt, decrypt, isEncrypted } from '../../utils/crypto';
import { Permission, PermissionScope } from '../rbac/permission.model';
import { CRMRecord } from '../crm/crm-record.model';
import { invalidateRoleCache } from '../rbac/permission.service';

const SENSITIVE_FIELDS = ['password', 'uri', 'apiKey', 'accessToken', 'refreshToken', 'webhookSecret'] as const;

function encryptConnectorConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  for (const field of SENSITIVE_FIELDS) {
    const val = out[field];
    if (val && typeof val === 'string' && !isEncrypted(val)) {
      out[field] = encrypt(val);
    }
  }
  return out;
}

function decryptConnectorConfig(connector: IConnector): IConnector {
  const cfg = { ...(connector.config as Record<string, unknown>) };
  for (const field of SENSITIVE_FIELDS) {
    const val = cfg[field];
    if (val && typeof val === 'string' && isEncrypted(val)) {
      try { cfg[field] = decrypt(val); } catch { /* leave encrypted if key mismatch */ }
    }
  }
  connector.config = cfg as IConnector['config'];
  return connector;
}

export async function createConnector(
  tenantId: string,
  data: Partial<IConnector>
): Promise<IConnector> {
  // NOTE: old connector deactivation happens AFTER OAuth succeeds (see below).
  // Deactivating first caused a race condition where auth failures left the
  // tenant with zero active connectors of that type.

  // Zoho: if authCode provided, exchange it for access + refresh tokens automatically
  if (data.type === 'zoho' && (data.config as Record<string, string>)?.authCode) {
    const cfg = data.config as Record<string, string>;
    const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: {
        code:          cfg.authCode,
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri:  'https://www.zoho.com',
        grant_type:    'authorization_code',
      },
    });
    if (!tokenRes.data.access_token) {
      throw new Error(tokenRes.data.error || 'Zoho code exchange failed — code may have expired. Generate a new code.');
    }
    // Store clientId + clientSecret for future auto-refresh; remove one-time authCode
    data.config = {
      ...cfg,
      accessToken:  tokenRes.data.access_token,
      refreshToken: tokenRes.data.refresh_token,
      // reuse existing fields: username = clientId, apiKey = clientSecret
      username:     cfg.clientId,
      apiKey:       cfg.clientSecret,
      authCode:     undefined,
    } as IConnector['config'];
  }

  // HubSpot: fetch portalId (Hub ID) for webhook routing + generate a per-connector webhook secret
  if (data.type === 'hubspot') {
    const cfg = data.config as Record<string, string>;
    // Accept token stored as either 'accessToken' or 'apiKey' (old UI used apiKey)
    if (cfg.apiKey && !cfg.accessToken) cfg.accessToken = cfg.apiKey;
    try {
      const infoRes = await axios.get('https://api.hubapi.com/account-info/v3/details', {
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        timeout: 5000,
      });
      cfg.hubId = String(infoRes.data.portalId || '');
    } catch { /* non-blocking — webhook routing still falls back to tenantId */ }
    // Generate a random webhook secret the user puts in HubSpot app settings
    if (!cfg.webhookSecret) {
      cfg.webhookSecret = require('crypto').randomBytes(24).toString('hex');
    }
    data.config = cfg as IConnector['config'];
  }

  // Salesforce: Client Credentials flow — Consumer Key + Secret only, no username/password needed
  if (data.type === 'salesforce') {
    const cfg = data.config as Record<string, string>;
    const instanceUrl = (cfg.loginUrl || '').trim().replace(/\/$/, '');
    if (!instanceUrl) throw new Error('Salesforce Instance URL is required.');
    if (!instanceUrl.startsWith('http')) throw new Error(`Salesforce Instance URL is invalid: "${instanceUrl}" — must start with https://`);

    let tokenRes: import('axios').AxiosResponse;
    try {
      tokenRes = await axios.post(
        `${instanceUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     cfg.clientId,
          client_secret: cfg.clientSecret,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch (sfErr: unknown) {
      const ae = sfErr as import('axios').AxiosError<{ error?: string; error_description?: string }>;
      const sfError = ae.response?.data?.error_description || ae.response?.data?.error || ae.message || 'Unknown Salesforce error';
      const status  = ae.response?.status ?? '?';
      throw new Error(`Salesforce OAuth failed (${status}): ${sfError}`);
    }
    if (!tokenRes.data.access_token) {
      const errMsg = (tokenRes.data as Record<string, string>).error_description
        || (tokenRes.data as Record<string, string>).error
        || 'Salesforce auth failed — ensure "Enable Client Credentials Flow" is ON and a Run As user is set.';
      throw new Error(errMsg);
    }
    // apiKey = Consumer Key, refreshToken = Consumer Secret, host = instanceUrl for re-auth
    data.config = {
      apiKey:       cfg.clientId,
      refreshToken: cfg.clientSecret,
      host:         instanceUrl,
      accessToken:  tokenRes.data.access_token as string,
      baseUrl:      (tokenRes.data.instance_url as string) || instanceUrl,
    } as IConnector['config'];
  }

  // Deactivate any existing active connectors of the same type — only after auth
  // is confirmed working so we never orphan the tenant without a valid connector.
  if (data.type) {
    await Connector.updateMany(
      { tenantId: new mongoose.Types.ObjectId(tenantId), type: data.type, isActive: true },
      { $set: { isActive: false, syncStatus: 'idle' } }
    );
  }

  // Encrypt sensitive credential fields before persisting
  if (data.config) {
    data.config = encryptConnectorConfig(data.config as Record<string, unknown>) as IConnector['config'];
  }

  const saved = await Connector.create({ ...data, tenantId: new mongoose.Types.ObjectId(tenantId) });

  // For HubSpot: fetch back with webhookSecret so the caller can display it once
  if (data.type === 'hubspot') {
    const withSecret = await Connector.findById(saved._id).select('+config.webhookSecret');
    const webhookUrl = `${process.env.BACKEND_PUBLIC_URL || 'http://localhost:5000'}/api/v1/webhooks/hubspot`;
    if (withSecret) {
      decryptConnectorConfig(withSecret);
      const result = withSecret as unknown as Record<string, unknown>;
      result['webhookInfo'] = {
        url:    webhookUrl,
        secret: (withSecret.config as Record<string, unknown>)?.webhookSecret || '',
        note:   'Register this URL in your HubSpot Private App → Webhooks. Paste the secret into the "Signing secret" field.',
      };
      return result as unknown as IConnector;
    }
  }

  return saved;
}

export async function getConnectors(tenantId: string): Promise<IConnector[]> {
  return Connector.find({ tenantId, isActive: true }).select(
    '-config.password -config.apiKey -config.accessToken -config.uri -config.refreshToken'
  );
}

export async function getConnectorById(
  tenantId: string,
  id: string
): Promise<IConnector | null> {
  return Connector.findOne({ _id: id, tenantId });
}

export async function updateConnector(
  tenantId: string,
  id: string,
  data: Partial<IConnector>
): Promise<IConnector | null> {
  if (data.config) {
    data.config = encryptConnectorConfig(data.config as Record<string, unknown>) as IConnector['config'];
  }
  return Connector.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true });
}

export async function deleteConnector(tenantId: string, id: string): Promise<void> {
  // Deactivate and capture the connector type before it's gone
  const connector = await Connector.findOneAndUpdate(
    { _id: id, tenantId },
    { isActive: false },
    { new: false } // returns the doc BEFORE the update
  );
  if (!connector) return;

  const channel = connector.type as string;

  // If another active connector of the same type still exists, don't purge —
  // the data is still valid for that sibling connector.
  const siblingActive = await Connector.exists({ tenantId, type: channel, isActive: true });
  if (siblingActive) return;

  // Purge CRMRecord data (MongoDB + Meilisearch) for this channel
  await purgeChannelRecords(tenantId, channel);

  // Also purge Customer model records synced from this connector
  await Customer.deleteMany({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    channel,
  });
}

export async function testConnector(
  tenantId: string,
  id: string
): Promise<{ success: boolean; message: string }> {
  const connector = await Connector.findOne({ _id: id, tenantId }).select(
    '+config.password +config.apiKey +config.accessToken +config.uri +config.baseUrl'
  );
  if (!connector) throw new Error('Connector not found');
  decryptConnectorConfig(connector);
  if (connector.type === 'hubspot' && !connector.config.accessToken && connector.config.apiKey) {
    connector.config.accessToken = connector.config.apiKey;
  }

  try {
    if (connector.type === 'rest') {
      await axios.get(connector.config.baseUrl!, {
        headers: {
          Authorization: `Bearer ${connector.config.apiKey}`,
          ...connector.config.headers,
        },
        timeout: 5000,
      });
    } else if (connector.type === 'hubspot') {
      await axios.get('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
        headers: { Authorization: `Bearer ${connector.config.accessToken}` },
        timeout: 5000,
      });
    } else if (connector.type === 'zoho') {
      const zohoBase = connector.config.baseUrl || 'https://www.zohoapis.com/crm/v3';
      await axios.get(`${zohoBase}/Leads?per_page=1`, {
        headers: { Authorization: `Zoho-oauthtoken ${connector.config.accessToken}` },
        timeout: 5000,
      });
    } else if (connector.type === 'mysql') {
      // Wiring for MySQL test
      const mysql = require('mysql2/promise');
      const connection = await mysql.createConnection(connector.config.uri || {
        host: connector.config.host,
        user: connector.config.username,
        password: connector.config.password,
        database: connector.config.database,
        port: connector.config.port
      });
      await connection.ping();
      await connection.end();
    } else if (connector.type === 'postgresql') {
      // Wiring for PostgreSQL test
      const { Client } = require('pg');
      const client = new Client(connector.config.uri ? { connectionString: connector.config.uri } : {
        host: connector.config.host,
        user: connector.config.username,
        password: connector.config.password,
        database: connector.config.database,
        port: connector.config.port
      });
      await client.connect();
      await client.end();
    }

    await Connector.findByIdAndUpdate(id, { syncStatus: 'success', lastSyncAt: new Date() });
    return { success: true, message: 'Connection successful' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Connection failed';
    await Connector.findByIdAndUpdate(id, { syncStatus: 'failed', syncError: msg });
    logger.error('Connector test failed', { id, error: msg });
    return { success: false, message: msg };
  }
}

/* ── Known schema fields — anything else auto-goes to customFields ── */
const ZOHO_KNOWN: Record<string, string> = {
  First_Name: 'firstName', Last_Name: 'lastName', Email: 'email',
  Phone: 'phone', Mobile: 'phone', Company: 'company', Account_Name: 'company',
  Lead_Source: 'leadSource', Lead_Status: 'status',
};
const ZOHO_STATUS_MAP: Record<string, string> = {
  'Attempted to Contact': 'contacted', 'Contact in Future': 'contacted',
  Contacted: 'contacted', 'Junk Lead': 'lost', 'Lost Lead': 'lost',
  'Not Contacted': 'new', 'Pre-Qualified': 'qualified', Qualified: 'qualified',
};
const HUBSPOT_KNOWN: Record<string, string> = {
  firstname: 'firstName', lastname: 'lastName', email: 'email',
  phone: 'phone', mobilephone: 'phone', company: 'company',
  hs_lead_status: 'status', lead_source: 'leadSource', source: 'leadSource',
};

/* Safely extract string from any Zoho field (lookup fields return {name,id} objects) */
const zStr = (v: unknown): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'name' in (v as object)) return (v as { name: string }).name;
  return String(v);
};

/* Apply tenant's field mapping (for custom DB/REST connectors) */
function applyMapping(
  raw: Record<string, unknown>,
  mapping: Record<string, string>
): { known: Record<string, string>; extra: Record<string, unknown> } {
  const known: Record<string, string> = {};
  const extra: Record<string, unknown> = {};
  for (const [srcField, rawVal] of Object.entries(raw)) {
    const schemaField = mapping[srcField];
    if (schemaField) known[schemaField] = String(rawVal ?? '');
    else extra[srcField] = rawVal;
  }
  return { known, extra };
}

/* Paginate through ALL pages of a Zoho module */
async function refreshZohoToken(connector: IConnector): Promise<string> {
  const refreshToken = connector.config.refreshToken;
  if (!refreshToken) throw new Error('No Zoho refresh token stored');

  // Use clientId/clientSecret stored in connector (username/apiKey fields) — fallback to env
  const clientId     = connector.config.username     || process.env.ZOHO_CLIENT_ID;
  const clientSecret = connector.config.apiKey       || process.env.ZOHO_CLIENT_SECRET;

  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'refresh_token',
    },
  });

  const newToken = res.data.access_token as string;
  if (!newToken) {
    // Common cause: user removed LeadRyze from Zoho OAuth apps — refresh token revoked
    const errCode = res.data.error as string;
    const msg = errCode === 'invalid_code' || errCode === 'invalid_grant'
      ? 'Zoho refresh token revoked — go to Connectors and reconnect Zoho with a new JSON.'
      : 'Zoho token refresh returned no access_token';
    throw new Error(msg);
  }

  // Persist new token
  await Connector.findByIdAndUpdate(connector._id, { 'config.accessToken': newToken });
  return newToken;
}

// ── Salesforce: re-auth using Client Credentials flow (no user login needed) ──
async function refreshSalesforceToken(
  connector: IConnector
): Promise<{ accessToken: string; instanceUrl: string }> {
  const instanceUrl = connector.config.host || connector.config.baseUrl || '';
  if (!instanceUrl) throw new Error('Salesforce Instance URL missing — reconnect the connector.');

  let res: import('axios').AxiosResponse;
  try {
    res = await axios.post(
      `${instanceUrl}/services/oauth2/token`,
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     connector.config.apiKey       || '',
        client_secret: connector.config.refreshToken || '',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (sfErr: unknown) {
    const ae = sfErr as import('axios').AxiosError<{ error?: string; error_description?: string }>;
    const msg = ae.response?.data?.error_description || ae.response?.data?.error || ae.message || 'Salesforce re-auth failed';
    throw new Error(`Salesforce token refresh failed: ${msg}`);
  }

  if (!res.data.access_token) {
    const msg = (res.data as Record<string, string>).error_description || (res.data as Record<string, string>).error || 'Salesforce re-auth failed';
    throw new Error(msg);
  }

  const accessToken = res.data.access_token as string;
  const newInstanceUrl = (res.data.instance_url as string) || instanceUrl;
  await Connector.findByIdAndUpdate(connector._id, {
    'config.accessToken': accessToken,
    'config.baseUrl':     newInstanceUrl,
  });
  return { accessToken, instanceUrl: newInstanceUrl };
}

// ── Salesforce: paginate through all SOQL results ─────────────────────────────
async function sfFetchAll(
  instanceUrl: string,
  soql: string,
  headers: Record<string, string>,
  apiBase: string,
): Promise<Record<string, unknown>[]> {
  type SFPage = { records: Record<string, unknown>[]; nextRecordsUrl: string | null };
  const fallback: { data: SFPage } = { data: { records: [], nextRecordsUrl: null } };
  const records: Record<string, unknown>[] = [];
  let nextUrl: string | undefined = `${apiBase}/query?q=${encodeURIComponent(soql)}`;
  while (nextUrl) {
    const res: { data: SFPage } = await axios.get<SFPage>(nextUrl, { headers }).catch((err: import('axios').AxiosError) => {
      logger.warn('Salesforce SOQL failed', {
        soql: soql.slice(0, 120),
        status: err.response?.status,
        error: JSON.stringify(err.response?.data ?? err.message),
      });
      return fallback;
    });
    records.push(...(res.data.records || []));
    nextUrl = res.data.nextRecordsUrl ? `${instanceUrl}${res.data.nextRecordsUrl}` : undefined;
    if (records.length >= 10000) break;
  }
  return records;
}

async function zohoFetchAll(
  base: string,
  module: string,
  fields: string | undefined,
  headers: Record<string, string>
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    const params: Record<string, unknown> = { per_page: 200, page };
    if (fields) params.fields = fields;
    const res = await axios.get(`${base}/${module}`, {
      headers, params,
    }).catch(() => ({ data: { data: [], info: { more_records: false } } }));
    const records: Record<string, unknown>[] = res.data.data || [];
    results.push(...records);
    if (!res.data.info?.more_records || records.length === 0) break;
    page++;
  }
  return results;
}

export async function fetchCRMCustomers(
  tenantId: string,
  connectorId: string,
  limit = 5000
): Promise<unknown[]> {
  const connector = await Connector.findOne({ _id: connectorId, tenantId }).select(
    '+config.apiKey +config.accessToken +config.baseUrl +config.refreshToken +config.password +config.uri'
  );
  if (!connector) throw new Error('Connector not found');
  decryptConnectorConfig(connector);
  // Normalize: old HubSpot connectors stored the token in apiKey instead of accessToken
  if (connector.type === 'hubspot' && !connector.config.accessToken && connector.config.apiKey) {
    connector.config.accessToken = connector.config.apiKey;
  }

  try {
    /* ── ZOHO ──────────────────────────────────────────────────────── */
    if (connector.type === 'zoho') {
      const zohoBase = connector.config.baseUrl || 'https://www.zohoapis.in/crm/v3';

      // Auto-refresh: always refresh token before sync (expires every 1 hour)
      let accessToken = connector.config.accessToken!;
      try {
        accessToken = await refreshZohoToken(connector);
        logger.info('Zoho token refreshed successfully');
      } catch (refreshErr) {
        logger.warn('Zoho token refresh failed, using cached token', { error: (refreshErr as Error).message });
      }

      const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };

      // Step 1: fetch field metadata so we capture every column including custom ones
      const [leadFieldsRes, contactFieldsRes] = await Promise.all([
        axios.get(`${zohoBase}/settings/fields?module=Leads`, { headers })
          .catch(() => ({ data: { fields: [] } })),
        axios.get(`${zohoBase}/settings/fields?module=Contacts`, { headers })
          .catch(() => ({ data: { fields: [] } })),
      ]);
      // Zoho allows max 50 fields per request
      const leadFields    = (leadFieldsRes.data.fields    as Array<{ api_name: string }>).slice(0, 50).map((f) => f.api_name).join(',')
                            || 'First_Name,Last_Name,Email,Phone,Company,Lead_Source';
      const contactFields = (contactFieldsRes.data.fields as Array<{ api_name: string }>).slice(0, 50).map((f) => f.api_name).join(',')
                            || 'First_Name,Last_Name,Email,Phone,Account_Name,Lead_Source';

      // Step 2: paginate through ALL records (not just first page)
      const [allLeads, allContacts] = await Promise.all([
        zohoFetchAll(zohoBase, 'Leads',    leadFields,    headers),
        zohoFetchAll(zohoBase, 'Contacts', contactFields, headers),
      ]);

      const mapZohoRecord = (r: Record<string, unknown>, type: 'lead' | 'contact') => {
        const known: Record<string, unknown> = {};
        const extra: Record<string, unknown> = {};

        for (const [key, val] of Object.entries(r)) {
          if (key === 'id' || key.startsWith('$')) continue;
          const schemaKey = ZOHO_KNOWN[key];
          const strVal = zStr(val);
          if (schemaKey) {
            if (schemaKey === 'phone' && known.phone) continue; // Mobile wins over Phone if already set
            known[schemaKey] = strVal;
          } else if (strVal) {
            extra[key] = strVal;
          }
        }

        return {
          externalId: String(r.id), source: 'zoho', recordType: type,
          firstName: known.firstName || '', lastName:   known.lastName  || '',
          email:     known.email     || '', phone:      known.phone     || '',
          company:   known.company   || '', leadSource: known.leadSource|| '',
          status:    ZOHO_STATUS_MAP[known.status as string] || 'new',
          customFields: extra,
        };
      };

      logger.info('Zoho fetch complete', { leads: allLeads.length, contacts: allContacts.length });
      return [
        ...allLeads.map((r) => mapZohoRecord(r, 'lead')),
        ...allContacts.map((r) => mapZohoRecord(r, 'contact')),
      ];
    }

    /* ── HUBSPOT ───────────────────────────────────────────────────── */
    if (connector.type === 'hubspot') {
      const hsHeaders = { Authorization: `Bearer ${connector.config.accessToken}` };

      // Fetch contact property names — always put core identity fields first so they're never cut off
      const propsRes = await axios.get('https://api.hubapi.com/crm/v3/properties/contacts', {
        headers: hsHeaders,
      }).catch(() => ({ data: { results: [] } }));

      const contactEssentials = ['firstname', 'lastname', 'email', 'phone', 'company', 'hs_lead_status', 'lead_source'];
      const otherContactProps = (propsRes.data.results as Array<{ name: string }>)
        .map((p) => p.name)
        .filter((p) => !contactEssentials.includes(p));
      const properties = [...contactEssentials, ...otherContactProps].slice(0, 100).join(',')
        || 'firstname,lastname,email,phone,company';

      // Paginate through all contacts — HubSpot max 100 per page
      const allContacts: Record<string, unknown>[] = [];
      let after: string | undefined;
      do {
        const page = await axios.get('https://api.hubapi.com/crm/v3/objects/contacts', {
          headers: hsHeaders,
          params: { limit: 100, properties, ...(after ? { after } : {}) },
        });
        const results: Record<string, unknown>[] = page.data.results || [];
        allContacts.push(...results);
        // HubSpot pagination: paging.next.after is the cursor string for the next page
        const paging = page.data.paging as { next?: { after?: string } } | undefined;
        after = paging?.next?.after;
      } while (after && allContacts.length < limit);

      return allContacts.map((r: Record<string, unknown>) => {
        const props = (r.properties as Record<string, string>) || {};
        const extra: Record<string, unknown> = {};
        const known: Record<string, string> = {};

        for (const [key, val] of Object.entries(props)) {
          if (!val) continue;
          const schemaKey = HUBSPOT_KNOWN[key];
          if (schemaKey) { known[schemaKey] = val; }
          else            { extra[key] = val; }
        }
        return {
          externalId: String(r.id), source: 'hubspot', recordType: 'contact',
          firstName: known.firstName || '', lastName: known.lastName || '',
          email: known.email || '', phone: known.phone || '',
          company: known.company || '', leadSource: known.leadSource || '',
          status: 'new', customFields: extra,
        };
      });
    }

    /* ── REST API (client's own endpoint) ──────────────────────────── */
    if (connector.type === 'rest') {
      const mapping = (connector.mapping?.customerFields || {}) as Record<string, string>;
      const response = await axios.get(`${connector.config.baseUrl}/customers`, {
        headers: { Authorization: `Bearer ${connector.config.apiKey}`, ...connector.config.headers },
        params: { limit },
      });
      const rows: Record<string, unknown>[] = response.data?.data || response.data || [];
      return rows.map((r) => {
        const { known, extra } = applyMapping(r, mapping);
        return {
          externalId: String(r.id || r._id || ''), source: 'rest', recordType: 'customer',
          firstName: known.firstName || '', lastName: known.lastName || '',
          email: known.email || '', phone: known.phone || '',
          company: known.company || '', leadSource: known.leadSource || '',
          status: 'new', customFields: extra,
        };
      });
    }

    /* ── MySQL (client's own DB table) ─────────────────────────────── */
    if (connector.type === 'mysql') {
      const mysql = require('mysql2/promise');
      const mapping = (connector.mapping?.customerFields || {}) as Record<string, string>;
      const table   = (mapping['__table'] || 'customers') as string;
      const conn    = await mysql.createConnection(connector.config.uri || {
        host: connector.config.host, user: connector.config.username,
        password: connector.config.password, database: connector.config.database,
        port: connector.config.port,
      });
      const [rows] = await conn.query(`SELECT * FROM \`${table}\` LIMIT ?`, [limit]);
      await conn.end();
      return (rows as Record<string, unknown>[]).map((r) => {
        const { known, extra } = applyMapping(r, mapping);
        return {
          externalId: String(r.id || r._id || ''), source: 'mysql', recordType: 'customer',
          firstName: known.firstName || '', lastName: known.lastName || '',
          email: known.email || '', phone: known.phone || '',
          company: known.company || '', leadSource: known.leadSource || '',
          status: 'new', customFields: extra,
        };
      });
    }

    /* ── PostgreSQL (client's own DB table) ─────────────────────────── */
    if (connector.type === 'postgresql') {
      const { Client } = require('pg');
      const mapping = (connector.mapping?.customerFields || {}) as Record<string, string>;
      const table   = (mapping['__table'] || 'customers') as string;
      const client  = new Client(connector.config.uri
        ? { connectionString: connector.config.uri }
        : { host: connector.config.host, user: connector.config.username,
            password: connector.config.password, database: connector.config.database,
            port: connector.config.port });
      await client.connect();
      const res = await client.query(`SELECT * FROM "${table}" LIMIT $1`, [limit]);
      await client.end();
      return res.rows.map((r: Record<string, unknown>) => {
        const { known, extra } = applyMapping(r, mapping);
        return {
          externalId: String(r.id || r._id || ''), source: 'postgresql', recordType: 'customer',
          firstName: known.firstName || '', lastName: known.lastName || '',
          email: known.email || '', phone: known.phone || '',
          company: known.company || '', leadSource: known.leadSource || '',
          status: 'new', customFields: extra,
        };
      });
    }

    /* ── MongoDB (client's own DB collection) ──────────────────────── */
    if (connector.type === 'mongodb') {
      const { MongoClient } = require('mongodb');
      const mapping    = (connector.mapping?.customerFields || {}) as Record<string, string>;
      const collection = (mapping['__collection'] || 'customers') as string;
      const uri        = connector.config.uri!;
      const client     = new MongoClient(uri);
      await client.connect();
      // Extract database name from URI path (e.g. .../mydbname?...) — fall back to config.database
      const dbNameFromUri = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace(/^\//, '').split('?')[0];
      const dbName        = dbNameFromUri || connector.config.database || undefined;
      const rows = await client.db(dbName).collection(collection).find({}).limit(limit).toArray();
      await client.close();
      return rows.map((r: Record<string, unknown>) => {
        const { known, extra } = applyMapping(r, mapping);
        return {
          externalId: String(r._id || r.id || ''), source: 'mongodb', recordType: 'customer',
          firstName: known.firstName || '', lastName: known.lastName || '',
          email: known.email || '', phone: known.phone || '',
          company: known.company || '', leadSource: known.leadSource || '',
          status: 'new', customFields: extra,
        };
      });
    }

    /* ── Salesforce (Connected App — password grant) ───────────────── */
    if (connector.type === 'salesforce') {
      // Re-authenticate before sync (no refresh token in password grant flow)
      let sfToken = connector.config.accessToken || '';
      let sfBase  = connector.config.baseUrl || '';
      try {
        const refreshed = await refreshSalesforceToken(connector);
        sfToken = refreshed.accessToken;
        sfBase  = refreshed.instanceUrl;
        logger.info('Salesforce token refreshed successfully');
      } catch (err) {
        logger.warn('Salesforce token refresh failed, using cached', { error: (err as Error).message });
      }

      const SF_API = `${sfBase}/services/data/v59.0`;
      const sfHeaders = { Authorization: `Bearer ${sfToken}` };

      // Get all queryable fields for Leads and Contacts
      const [leadDesc, contactDesc] = await Promise.all([
        axios.get(`${SF_API}/sobjects/Lead/describe/`, { headers: sfHeaders })
          .catch(() => ({ data: { fields: [] } })),
        axios.get(`${SF_API}/sobjects/Contact/describe/`, { headers: sfHeaders })
          .catch(() => ({ data: { fields: [] } })),
      ]);

      const pickFields = (desc: { data: { fields: Array<{ name: string; type: string }> } }) =>
        desc.data.fields
          .filter((f) => !['address', 'location', 'textarea', 'base64'].includes(f.type))
          .slice(0, 50).map((f) => f.name).join(', ');

      const leadFields    = pickFields(leadDesc)    || 'Id, FirstName, LastName, Email, Phone, Company';
      const contactFields = pickFields(contactDesc) || 'Id, FirstName, LastName, Email, Phone';

      const [leads, contacts] = await Promise.all([
        sfFetchAll(sfBase, `SELECT ${leadFields} FROM Lead`,    sfHeaders, SF_API),
        sfFetchAll(sfBase, `SELECT ${contactFields} FROM Contact`, sfHeaders, SF_API),
      ]);

      const mapSF = (r: Record<string, unknown>, type: 'lead' | 'contact') => {
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (k !== 'attributes' && v !== null) extra[k] = v;
        }
        const acct = r.Account as Record<string, unknown> | null;
        return {
          externalId: String(r.Id),
          source: 'salesforce', recordType: type,
          firstName: String(r.FirstName || ''),
          lastName:  String(r.LastName  || ''),
          email:     String(r.Email     || ''),
          phone:     String(r.Phone || r.MobilePhone || ''),
          company:   String(r.Company   || acct?.Name || ''),
          leadSource:String(r.LeadSource || ''),
          status:    'new',
          customFields: extra,
        };
      };

      logger.info('Salesforce fetch complete', { leads: leads.length, contacts: contacts.length });
      return [
        ...leads.map((r) => mapSF(r, 'lead')),
        ...contacts.map((r) => mapSF(r, 'contact')),
      ];
    }

    return [];
  } catch (error) {
    logger.error('CRM fetch failed', { connectorId, error: (error as Error).message });
    throw error;
  }
}

type CustomerRecord = {
  externalId?: string;
  firstName?: string; lastName?: string; email?: string; phone?: string;
  company?: string; leadSource?: string; recordType?: string;
  status?: string; source?: string; customFields?: Record<string, unknown>;
};

/* Modules to skip — only truly system/config modules with no user data.
   Leads + Contacts go into Customer model instead.
   Everything else (Tasks, Events, Calls, Campaigns, Accounts, Deals, etc.)
   syncs automatically into CRMRecord — no code change needed for new modules. */
const ZOHO_MODULE_EXCLUDE = new Set([
  'Leads', 'Contacts',          // → Customer model
  'Feeds', 'SalesInbox',        // Zoho internal activity streams
  'Reports', 'Dashboards',      // config objects, not data rows
  'Webforms', 'Macros',         // automation/form configs
  'Integrations', 'Users', 'Roles', 'Territories', // admin / system
  'Actions_Performed_While_Visiting_A_Site', 'Links', // analytics / nav
]);

/* Try these fields (in order) to find a human-readable display name for any Zoho module.
   Covers CRM modules, activity modules (Tasks/Events/Calls), and any future modules. */
const ZOHO_DISPLAY_FIELDS = [
  // CRM modules
  'Account_Name', 'Deal_Name', 'Potential_Name', 'Product_Name',
  'Contact_Name', 'Campaign_Name', 'Vendor_Name',
  'Quote_Subject', 'Invoice_Subject', 'Sales_Order_Subject',
  'Purchase_Order_Subject', 'Case_Subject', 'Solution_Title',
  // Activity modules: Tasks, Events (Meetings), Calls, Notes
  'Subject', 'Event_Title', 'Call_Purpose', 'Note_Title',
  // Generic fallbacks
  'Name', 'Full_Name', 'Title', 'Description',
];

/* Zoho API name → human-friendly module name (matches Zoho's own UI labels) */
const ZOHO_MODULE_LABELS: Record<string, string> = {
  Events:     'Meetings',      // Zoho calls the API module "Events" but shows it as "Meetings"
  Potentials: 'Deals',         // Some Zoho orgs use "Potentials" instead of "Deals"
};

/* Convert a Zoho field_label to a safe storage key: "Contact Name" → "Contact_Name" */
function labelToKey(label: string): string {
  return label.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

/* Sync ALL Zoho modules (except Leads/Contacts) into the generic CRMRecord collection.
   Uses Zoho field metadata labels as storage keys so columns match Zoho's own UI exactly.
   Fully dynamic — discovers new modules automatically with no code change. */
async function syncZohoCRMModules(
  connector: IConnector,
  tenantId: string,
  accessToken: string
): Promise<void> {
  const zohoBase = connector.config.baseUrl || 'https://www.zohoapis.in/crm/v3';
  const headers  = { Authorization: `Zoho-oauthtoken ${accessToken}` };

  // Get all modules from Zoho — auto-discovers new modules with no code change
  const modulesRes = await axios.get(`${zohoBase}/settings/modules`, { headers })
    .catch(() => ({ data: { modules: [] } }));

  const allModules = (
    modulesRes.data.modules as Array<{
      api_name: string;
      module_name: string;
      api_supported: boolean;
    }> || []
  ).filter((m) => m.api_supported && !ZOHO_MODULE_EXCLUDE.has(m.api_name));

  for (const mod of allModules) {
    // Use friendly name (e.g. "Meetings" instead of "Events") as the stored module key
    const moduleName = ZOHO_MODULE_LABELS[mod.api_name] || mod.module_name || mod.api_name;

    try {
      // Fetch field metadata: gives us api_name + field_label for every field
      const fieldsRes = await axios.get(`${zohoBase}/settings/fields?module=${mod.api_name}`, { headers })
        .catch(() => ({ data: { fields: [] } }));

      // Build labelMap: api_name → storage key (uses Zoho's field_label, spaces→underscores)
      const allFieldDefs = (
        fieldsRes.data.fields as Array<{ api_name: string; field_label: string }> || []
      );
      const labelMap: Record<string, string> = {};
      const usedKeys = new Set<string>();
      for (const f of allFieldDefs) {
        if (!f.api_name || !f.field_label) continue;
        let key = labelToKey(f.field_label);
        if (usedKeys.has(key)) key = f.api_name;
        usedKeys.add(key);
        labelMap[f.api_name] = key;
      }
      const allApiNames = allFieldDefs.map((f) => f.api_name).filter(Boolean);

      // Zoho enforces a hard limit of 50 fields per API request.
      // Strategy: fetch the first batch with full pagination (gets all record IDs),
      // then supplement remaining field batches using Zoho's ?ids=... lookup.
      const FIELD_BATCH = 50;
      const fieldBatches: string[] = [];
      for (let i = 0; i < allApiNames.length; i += FIELD_BATCH) {
        fieldBatches.push(allApiNames.slice(i, i + FIELD_BATCH).join(','));
      }

      // Pass 1: paginate ALL records with first field batch
      const records = await zohoFetchAll(zohoBase, mod.api_name, fieldBatches[0], headers);
      if (records.length === 0) continue;

      // Build lookup map so we can merge subsequent batches by record ID
      const recordById = new Map(records.map((r) => [String(r.id), r]));

      // Pass 2+: re-paginate all records with each remaining field batch, merge by ID.
      // We re-fetch all pages (not by ids=) because Zoho does not support ids filter
      // on the standard module endpoint — using it returns an empty response silently.
      for (let bi = 1; bi < fieldBatches.length; bi++) {
        const extraRecords = await zohoFetchAll(zohoBase, mod.api_name, fieldBatches[bi], headers);
        for (const extra of extraRecords) {
          const existing = recordById.get(String(extra.id));
          if (existing) {
            for (const [k, v] of Object.entries(extra)) {
              if (v !== null && v !== undefined) existing[k] = v;
            }
          }
        }
      }

      const toUpsert = records.map((r) => {
        // Pick display name from original record (uses Zoho api_names as-is)
        const displayName = ZOHO_DISPLAY_FIELDS
          .map((f) => zStr(r[f]))
          .find((v) => v) || String(r.id || '');

        // Build data dict using Zoho UI labels as keys
        // e.g. Who_Id → "Contact_Name", What_Id → "Related_To"
        const data: Record<string, unknown> = {};
        for (const [apiKey, val] of Object.entries(r)) {
          if (apiKey.startsWith('$') || apiKey === 'id') continue;
          const storageKey = labelMap[apiKey] || apiKey;
          data[storageKey] = flattenValue(val);
        }

        return { externalId: String(r.id), displayName, data };
      });

      // Migrate any records stored under the old API name (e.g. "Events" → "Meetings")
      if (mod.api_name !== moduleName) {
        await renameCRMModule(tenantId, 'zoho', mod.api_name, moduleName);
      }

      // Store under the friendly module name ("Meetings" not "Events")
      await upsertCRMRecords(tenantId, 'zoho', moduleName, toUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
      await deleteMissingCRMRecords(tenantId, 'zoho', moduleName, toUpsert.map((r) => r.externalId));

      logger.info(`Zoho module synced: ${mod.api_name} → ${moduleName}`, { count: toUpsert.length });
    } catch (err) {
      // One module failing must not stop the rest
      logger.warn(`Zoho module sync skipped: ${mod.api_name}`, { error: (err as Error).message });
    }
  }
}

// ── Generic value flattener: converts any nested object/array to a readable string ──
// Applied to ALL connector sync paths so nested CRM fields never show [object Object].
function flattenValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    const parts = (val as unknown[]).map((item) => {
      if (item === null || item === undefined) return '';
      if (typeof item !== 'object') return String(item);
      const o = item as Record<string, unknown>;
      const str =
        String(o.name ?? o.display_name ?? o.title ?? o.label ?? o.email ?? o.value ?? '');
      if (str) return str;
      // Fall back to first non-object primitive value in the item
      const first = Object.values(o).find((v) => v !== null && typeof v !== 'object');
      return first !== undefined ? String(first) : JSON.stringify(o).slice(0, 80);
    }).filter(Boolean);
    return parts.join(', ') || null;
  }
  const o = val as Record<string, unknown>;
  if ('name' in o && o.name !== null && o.name !== undefined) return o.name;
  if ('display_name' in o) return o.display_name;
  if ('title' in o) return o.title;
  if ('label' in o) return o.label;
  if ('value' in o) return o.value;
  // Compact: join up to 3 primitive key=value pairs
  const parts = Object.entries(o)
    .filter(([, v]) => v !== null && typeof v !== 'object' && String(v).trim())
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return parts.length ? parts.join(', ') : JSON.stringify(o).slice(0, 100);
}

function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = flattenValue(v);
  }
  return out;
}

// ── Generic display-name picker for raw DB / API rows ────────────────────────
const DB_NAME_KEYS = [
  'name', 'full_name', 'title', 'first_name', 'label',
  'display_name', 'username', 'email', 'subject',
];
function pickDisplayNameFromRow(row: Record<string, unknown>): string {
  for (const key of DB_NAME_KEYS) {
    const val = row[key] ?? row[key.toUpperCase()];
    if (val && typeof val === 'string' && val.trim()) return val.trim();
  }
  const fn = String(row.first_name || row.FIRST_NAME || row.firstName || '');
  const ln = String(row.last_name  || row.LAST_NAME  || row.lastName  || '');
  if (fn || ln) return `${fn} ${ln}`.trim();
  for (const [k, v] of Object.entries(row)) {
    if (!/^(_id|id)$/i.test(k) && typeof v === 'string' && v.trim()) return v.trim();
  }
  return String(row._id ?? row.id ?? 'Unknown');
}

// ── Salesforce: dynamic object discovery (mirrors Zoho's module approach) ─────
const SF_EXCLUDE = new Set([
  'Lead', 'Contact',                          // → Customer model already
  'User', 'Group', 'Organization', 'Profile',
  'PermissionSet', 'ObjectPermissions', 'FieldPermissions',
  'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent',
  'AggregateResult', 'EntityParticle', 'FieldDefinition',
  'CustomTab', 'FlowDefinition', 'SetupAuditTrail', 'LoginHistory',
  'AsyncApexJob', 'CronTrigger', 'ProcessInstance',
  'FeedItem', 'FeedComment', 'FeedLike', 'FeedPollChoice', 'FeedPollVote',
  'FeedRevision', 'FeedSignal', 'FeedTrackedChange',
  'NetworkActivityAudit', 'NetworkUserHistoryRecent',
  'ContentDocumentLink', 'ContentVersion', 'ContentWorkspace',
  'EmailMessage', 'EmailMessageRelation',
  'UserRecordAccess', 'UserAppInfo', 'UserAppMenuCustomization',
  'ListEmail', 'ListEmailIndividualRecipient',
  'ApexTestResult', 'ApexTestRunResult', 'ApexLog',
  'AuthSession', 'AuthProvider', 'OauthToken',
]);

// Pattern-based exclusions: system/internal Salesforce objects with no user CRM value
function sfShouldExclude(name: string): boolean {
  if (SF_EXCLUDE.has(name)) return true;

  // ── Suffix patterns ────────────────────────────────────────────────────────
  if (name.endsWith('Feed'))           return true; // Chatter feeds
  if (name.endsWith('FeedElement'))    return true;
  if (name.endsWith('Share'))          return true; // Sharing rules
  if (name.endsWith('Access'))         return true; // UserRecordAccess etc.
  if (name.endsWith('History'))        return true; // CaseHistory, OpportunityHistory etc.
  if (name.endsWith('ChangeEvent'))    return true; // CDC streaming events
  if (name.endsWith('Tag'))            return true; // UserTag, AccountTag etc.
  if (name.endsWith('Metric'))         return true; // License metrics
  if (name.endsWith('Metrics'))        return true;
  if (name.endsWith('License'))        return true;
  if (name.endsWith('LicenseMetric'))  return true;
  if (name.endsWith('Member'))         return true; // AppTabMember, ContentWorkspaceMember etc.
  if (name.endsWith('StatusValue'))    return true; // CaseStatusValue, LeadStatusValue — lookup tables
  if (name.endsWith('Definition'))     return true; // ColorDefinition, DataType, FieldDefinition etc. — require mandatory filters
  if (name.endsWith('Localization'))   return true; // Translation/locale metadata

  // ── Prefix patterns ────────────────────────────────────────────────────────
  if (name.startsWith('__'))            return true; // Internal double-underscore objects
  if (name.startsWith('Apex'))          return true; // ApexClass, ApexTrigger, ApexLog etc.
  if (name.startsWith('Auth'))          return true; // AuthSession, AuthProvider
  if (name.startsWith('OAuth'))         return true;
  if (name.startsWith('Entity'))        return true; // EntityParticle, EntityDefinition
  if (name.startsWith('Field'))         return true; // FieldDefinition, FieldPermissions
  if (name.startsWith('Custom'))        return true; // CustomBrand, CustomTab, CustomNotificationType
  if (name.startsWith('Network'))       return true; // NetworkActivity, NetworkUser etc.
  if (name.startsWith('UserApp'))       return true; // UserAppInfo, UserAppMenuCustomization
  if (name.startsWith('LoginGeo'))      return true; // LoginGeoData
  if (name.startsWith('TodayGoal'))     return true;
  if (name.startsWith('ActivePerm'))    return true; // ActivePermSetLicense etc.
  if (name.startsWith('ActiveFeature')) return true;
  if (name.startsWith('PermissionSet')) return true; // PermissionSetAssignment, PermissionSetGroup
  if (name.startsWith('AppMenu'))       return true; // AppMenuItem, AppMenuType — UI config
  if (name.startsWith('AppTab'))        return true; // AppTabMember — requires mandatory filter
  if (name.startsWith('AppDef'))        return true; // AppDefinition metadata
  if (name.startsWith('Color'))         return true; // ColorDefinition — requires mandatory filter
  if (name.startsWith('ContentFolder')) return true; // ContentFolderItem/Member — require Id filter
  if (name.startsWith('DataLake'))      return true; // DataLakeObject — metadata
  if (name.startsWith('DataSpace'))     return true; // DataSpaces — metadata
  if (name.startsWith('DataStat'))      return true; // DataStatistics — requires StatType filter
  if (name.startsWith('DataType'))      return true; // DataType — doesn't support queryMore
  if (name.startsWith('Calculated'))    return true; // CalculatedInsightRangeBounds — analytics metadata
  if (name.startsWith('Library'))       return true; // LibraryPermission — content library config
  if (name.startsWith('ClientBrowser')) return true; // Client browser audit data
  if (name.startsWith('Outgoing'))      return true; // OutgoingEmail/OutgoingEmailRelation — unsupported query
  if (name.startsWith('FlowTest'))      return true; // FlowTestView — reified column (FlowDefinitionViewId) required
  if (name.startsWith('FlowVariable'))  return true; // FlowVariableView — reified column required
  if (name.startsWith('FlowVersion'))   return true; // FlowVersionView — reified column required
  if (name.startsWith('OwnerChange'))   return true; // OwnerChangeOptionInfo — reified column required
  if (name.startsWith('PicklistValue')) return true; // PicklistValueInfo — reified column (EntityParticleId) required
  if (name.startsWith('Formula'))       return true; // FormulaFunction, FormulaContextFunction — metadata
  if (name.startsWith('GoalAssignment')) return true; // system coaching records, not user CRM data

  // ── Specific objects/tables that are createable in some orgs but not user CRM data ──
  const SF_SYSTEM_DATA = new Set([
    'Folder',             // email/report/dashboard folder records — not CRM data
    'Period',             // fiscal period config
    'RecycleBin',         // deleted record tombstones
    'ProcessNode',        // workflow/process builder config
    'LoginIp',            // login security audit records
    'UserPreference',     // user UI preference settings — not CRM data
    'Vote',               // Chatter votes — requires mandatory ParentId filter (SOQL restriction)
    'UserEmailCalendarSync', // external object exception — unsupported SOQL query
  ]);
  if (SF_SYSTEM_DATA.has(name)) return true;

  // ── Specific objects with mandatory/restricted query requirements ──────────
  // These are "queryable=true" in describe but require special WHERE clauses.
  // Caught by SOQL error at runtime, but excluding them up-front avoids the API call.
  const SF_RESTRICTED_QUERY = new Set([
    'BusinessHours', 'ConnectedApplication', 'Calendar',
    'Dashboard', 'DashboardComponent', 'DashboardFeed',
    'DataStatistics', 'DataType',
    'Report', 'ReportFeed',
    'StreamingChannel',
    'ListViewChartInstance',  // "Getting all ListViewChartInstances is unsupported"
    'PlatformAction',         // "Getting all PlatformAction entities is unsupported"
  ]);
  if (SF_RESTRICTED_QUERY.has(name)) return true;

  return false;
}

async function syncSalesforceCRMModules(
  connector: IConnector,
  tenantId: string,
  accessToken: string,
  instanceUrl: string,
): Promise<void> {
  const SF_API    = `${instanceUrl}/services/data/v59.0`;
  const sfHeaders = { Authorization: `Bearer ${accessToken}` };

  // Auto-discover all queryable objects
  const sobjectsRes = await axios.get<{
    sobjects: Array<{
      name: string; label: string; labelPlural: string;
      queryable: boolean; createable: boolean; updateable: boolean;
    }>;
  }>(`${SF_API}/sobjects/`, { headers: sfHeaders })
    .catch(() => ({ data: { sobjects: [] } }));

  // Dynamic filter using Salesforce's own flags:
  //   queryable  — object can be read via SOQL
  //   createable — users can create records → signals real CRM/business data
  //                (config/metadata objects like Flows, Folders, LoginIp, CustomButtons
  //                 are queryable but NOT createable — Salesforce's own distinction)
  // sfShouldExclude catches remaining edge-cases (audit tables, streaming, etc.)
  const objects = sobjectsRes.data.sobjects.filter(
    (o) => o.queryable && o.createable && !sfShouldExclude(o.name)
  );

  const syncedModules = new Set<string>();

  for (const obj of objects) { // process ALL user-relevant queryable objects
    try {
      const descRes = await axios.get<{ fields: Array<{ name: string; type: string }> }>(
        `${SF_API}/sobjects/${obj.name}/describe/`, { headers: sfHeaders }
      ).catch(() => ({ data: { fields: [] } }));

      const fieldList = descRes.data.fields
        .filter((f) => !['address', 'location', 'base64', 'encryptedstring', 'textarea', 'anyType'].includes(f.type))
        .slice(0, 40).map((f) => f.name);

      if (!fieldList.length) continue;
      if (!fieldList.includes('Id')) fieldList.unshift('Id');

      const rows = await sfFetchAll(
        instanceUrl,
        `SELECT ${fieldList.join(', ')} FROM ${obj.name} LIMIT 5000`,
        sfHeaders,
        SF_API,
      );
      if (!rows.length) continue;

      const NAME_FIELDS = ['Name', 'Subject', 'Title', 'ProductName', 'CaseNumber', 'Description'];
      const nameField = NAME_FIELDS.find((f) => rows[0]?.[f] !== undefined && rows[0]?.[f] !== null);

      const toUpsert = rows.map((r) => ({
        externalId:  String(r.Id || ''),
        displayName: String((nameField && r[nameField]) || r.Id || ''),
        data:        flattenRow(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'attributes'))),
      }));

      const friendlyName = obj.labelPlural || obj.label || obj.name;
      syncedModules.add(friendlyName);
      await upsertCRMRecords(tenantId, 'salesforce', friendlyName, toUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
      await deleteMissingCRMRecords(tenantId, 'salesforce', friendlyName, toUpsert.map((r) => r.externalId));
      logger.info(`Salesforce object synced: ${friendlyName}`, { count: toUpsert.length });
    } catch (err) {
      logger.warn(`Salesforce object sync skipped: ${obj.name}`, { error: (err as Error).message });
    }
  }

  // Remove stale modules from previous syncs that are now excluded
  const { CRMRecord } = await import('../crm/crm-record.model');
  const storedModules = await CRMRecord.distinct('module', {
    tenantId: new mongoose.Types.ObjectId(tenantId),
    channel: 'salesforce',
  }) as string[];

  const staleModules = storedModules.filter((m) => !syncedModules.has(m));
  for (const stale of staleModules) {
    await CRMRecord.deleteMany({ tenantId: new mongoose.Types.ObjectId(tenantId), channel: 'salesforce', module: stale });
    logger.info(`Salesforce stale module removed: ${stale}`);
  }
}

// ── HubSpot: fully dynamic schema discovery ───────────────────────────────────
// Object types handled by the Customer model — never synced as CRM modules
const HS_CUSTOMER_OBJECTS = new Set(['contacts', 'contact']);

// All known HubSpot standard object API names (probed at sync time).
// 404 / 403 responses are silently skipped — no code change when a portal doesn't
// have a particular object enabled.
// Custom objects the user creates in HubSpot are auto-discovered via /crm/v3/schemas
// and never need to appear here.
const HS_PROBE_STANDARD_OBJECTS = [
  // Core CRM
  'companies', 'deals', 'tickets', 'products', 'line_items',
  'quotes', 'orders', 'invoices', 'subscriptions', 'goals',
  // Engagements
  'calls', 'emails', 'meetings', 'notes', 'tasks', 'postal_mail', 'communications',
  // Sales & Service Hub
  'projects', 'playbooks',
  // Marketing
  'feedback_submissions', 'marketing_events',
];

// ── HubSpot non-CRM feature APIs ──────────────────────────────────────────────
// HubSpot splits non-CRM features (Snippets, Templates, etc.) into separate API
// namespaces outside of /crm/v3/objects. Each entry here is synced automatically
// at every sync — new records appear in CRM DATA with no code change.
// Shape: { moduleName, url, resultsKey, idKey, nameKey, paginationType }
//   paginationType: 'offset' (legacy ?count=&offset=) | 'cursor' (paging.next.after)
interface HSExtraAPI {
  moduleName: string;
  url:            string;
  resultsKey:     string;
  idKey:          string;
  nameKey:        string;
  paginationType: 'offset' | 'cursor';
  pageParam:      string;   // query param name for page size
  offsetParam?:   string;   // query param name for offset (offset mode)
  afterParam?:    string;   // query param name for cursor (cursor mode)
  hasMoreKey?:    string;   // response key for "has more" (offset mode)
  extraParams?:   Record<string, string>;
}

// Populated when HubSpot exposes a non-CRM feature area via their Private App API.
// Snippets and Templates are intentionally excluded — HubSpot does not provide
// API access to those resources for Private Apps (no scope exists for them).
const HS_EXTRA_APIS: HSExtraAPI[] = [];

// Priority order for auto-detecting a human-readable display field from a property list
const HS_DISPLAY_CANDIDATES = ['name', 'dealname', 'subject', 'title', 'label', 'hs_title', 'firstname', 'email', 'domain'];

function hsModuleName(apiName: string): string {
  return apiName.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function hsPickDisplayField(propNames: string[]): string {
  for (const c of HS_DISPLAY_CANDIDATES) {
    if (propNames.includes(c)) return c;
  }
  return propNames.find((p) => p.toLowerCase().includes('name')) || propNames[0] || 'id';
}

async function syncHubSpotCRMModules(connector: IConnector, tenantId: string): Promise<void> {
  const headers = { Authorization: `Bearer ${connector.config.accessToken}` };

  // Auto-repair: populate hubId if missing
  if (!connector.config.hubId) {
    try {
      const infoRes = await axios.get('https://api.hubapi.com/account-info/v3/details', { headers, timeout: 5000 });
      const hubId = String(infoRes.data.portalId || '');
      if (hubId) {
        await Connector.findByIdAndUpdate(connector._id, { 'config.hubId': hubId });
        logger.info('HubSpot: auto-populated hubId', { hubId });
      }
    } catch { /* non-blocking */ }
  }

  // ── Step 1: Discover all objects to sync ─────────────────────────────────
  // Map<apiName, { moduleName, customDisplayField? }>
  const objectsToSync = new Map<string, { moduleName: string; customDisplayField?: string }>();

  // 1a. Probe standard objects in parallel — any that 404 / 403 are silently skipped
  await Promise.all(
    HS_PROBE_STANDARD_OBJECTS.map(async (apiName) => {
      try {
        await axios.get(`https://api.hubapi.com/crm/v3/properties/${apiName}`, { headers, timeout: 8000 });
        objectsToSync.set(apiName, { moduleName: hsModuleName(apiName) });
      } catch { /* not available for this portal — skip */ }
    })
  );

  // 1b. Auto-discover ALL schemas via /crm/v3/schemas.
  //     This returns custom objects AND some standard objects (like Projects 0-970)
  //     that HubSpot doesn't include in the simple probe list.
  //     For each schema we register BOTH the api name AND the numeric objectTypeId
  //     so objects only accessible by ID (e.g. 0-970) are still synced.
  try {
    const schemasRes = await axios.get('https://api.hubapi.com/crm/v3/schemas', { headers, timeout: 10000 });
    for (const s of schemasRes.data.results as Array<{
      name: string;
      objectTypeId?: string;
      labels?: { plural?: string };
      primaryDisplayProperty?: string;
    }>) {
      if (HS_CUSTOMER_OBJECTS.has(s.name)) continue;
      const moduleName = s.labels?.plural || hsModuleName(s.name);
      const entry = { moduleName, customDisplayField: s.primaryDisplayProperty };
      // Register by api name (e.g. "projects")
      objectsToSync.set(s.name, entry);
      // Also register by numeric type ID (e.g. "0-970") in case the name probe
      // failed but the ID works — Map deduplicates so no double-sync
      if (s.objectTypeId && s.objectTypeId !== s.name && !objectsToSync.has(s.objectTypeId)) {
        objectsToSync.set(s.objectTypeId, entry);
      }
    }
    logger.info('HubSpot: objects discovered', { probed: HS_PROBE_STANDARD_OBJECTS.length, total: objectsToSync.size });
  } catch { /* schemas optional — probe list still runs */ }

  // ── Step 2: Sync each discovered object ──────────────────────────────────
  const syncedModules = new Set<string>();

  for (const [apiName, { moduleName, customDisplayField }] of objectsToSync) {
    try {
      // Fetch all properties for this object, then auto-detect the best display field
      const propsRes = await axios.get(`https://api.hubapi.com/crm/v3/properties/${apiName}`, { headers })
        .catch(() => ({ data: { results: [] } }));
      const propNames = (propsRes.data.results as Array<{ name: string }>).map((p) => p.name);

      const displayField = (customDisplayField && propNames.includes(customDisplayField))
        ? customDisplayField
        : hsPickDisplayField(propNames);

      // Always put display field first so it's never cut off by the 100-prop slice
      const alwaysFirst = Array.from(new Set([displayField, 'name'].filter((f) => propNames.includes(f))));
      const others      = propNames.filter((p) => !alwaysFirst.includes(p));
      const properties  = [...alwaysFirst, ...others].slice(0, 100).join(',') || displayField;

      // Paginate through all records (HubSpot max 100 per page)
      const records: Record<string, unknown>[] = [];
      let after: string | undefined;
      for (;;) {
        const params: Record<string, string> = { limit: '100', properties };
        if (after) params.after = after;
        const res = await axios.get(`https://api.hubapi.com/crm/v3/objects/${apiName}`, {
          headers, params,
        }).catch(() => ({ data: { results: [], paging: null } }));
        records.push(...(res.data.results || []));
        const paging = res.data.paging as { next?: { after?: string } } | undefined;
        after = paging?.next?.after;
        if (!after || records.length >= 10000) break;
      }

      // Map to CRMRecord format
      const toUpsert = records.map((r) => {
        const props = (r.properties as Record<string, string>) || {};
        const displayName = props[displayField] || props['name'] || String(r.id || '');
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (v !== null && v !== undefined && v !== '') data[k] = v;
        }
        return { externalId: String(r.id), displayName, data };
      });

      syncedModules.add(moduleName);
      if (toUpsert.length > 0) {
        await upsertCRMRecords(tenantId, 'hubspot', moduleName, toUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
        await deleteMissingCRMRecords(tenantId, 'hubspot', moduleName, toUpsert.map((r) => r.externalId));
      }
      logger.info(`HubSpot module synced: ${moduleName}`, { count: toUpsert.length, apiName });
    } catch (err) {
      logger.warn(`HubSpot module sync skipped: ${moduleName}`, { error: (err as Error).message });
    }
  }

  // ── Step 3: Sync non-CRM HubSpot feature APIs (Snippets, Templates, …) ──────
  // Driven entirely by HS_EXTRA_APIS — add a new entry there to support a new
  // HubSpot feature area; zero code changes needed here.
  for (const api of HS_EXTRA_APIS) {
    try {
      const records: Record<string, unknown>[] = [];

      if (api.paginationType === 'cursor') {
        let after: string | undefined;
        for (;;) {
          const params: Record<string, string> = { [api.pageParam]: '100', ...(api.extraParams || {}) };
          if (after && api.afterParam) params[api.afterParam] = after;
          const res = await axios.get(api.url, { headers, params, timeout: 15000 })
            .catch(() => ({ data: { [api.resultsKey]: [], paging: null } }));
          const batch = (res.data[api.resultsKey] || []) as Array<Record<string, unknown>>;
          records.push(...batch);
          const paging = res.data.paging as { next?: { after?: string } } | undefined;
          after = paging?.next?.after;
          if (!after || records.length >= 10000) break;
        }
      } else {
        let offset = 0;
        let hasMore = true;
        while (hasMore && records.length < 10000) {
          const params: Record<string, string> = { [api.pageParam]: '100', ...(api.extraParams || {}) };
          if (api.offsetParam) params[api.offsetParam] = String(offset);
          const res = await axios.get(api.url, { headers, params, timeout: 15000 })
            .catch(() => ({ data: { [api.resultsKey]: [], [api.hasMoreKey || 'hasMore']: false } }));
          const batch = (res.data[api.resultsKey] || []) as Array<Record<string, unknown>>;
          records.push(...batch);
          hasMore = Boolean(res.data[api.hasMoreKey || 'hasMore']);
          offset += batch.length;
          if (!hasMore || batch.length === 0) break;
        }
      }

      const toUpsert = records.map((r) => {
        const id = String(r[api.idKey] ?? '');
        const displayName = String(r[api.nameKey] || id);
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (v !== null && v !== undefined && v !== '') data[k] = flattenValue(v);
        }
        return { externalId: id, displayName, data };
      });

      syncedModules.add(api.moduleName);
      if (toUpsert.length > 0) {
        await upsertCRMRecords(tenantId, 'hubspot', api.moduleName, toUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
        await deleteMissingCRMRecords(tenantId, 'hubspot', api.moduleName, toUpsert.map((r) => r.externalId));
      }
      logger.info(`HubSpot extra API synced: ${api.moduleName}`, { count: toUpsert.length });
    } catch (err) {
      logger.warn(`HubSpot extra API skipped: ${api.moduleName}`, { error: (err as Error).message });
    }
  }

  // ── Step 5: Sync Segments (Lists) ────────────────────────────────────────────
  // Tries the v3 API first (/crm/v3/lists); falls back to the legacy v1 API
  // (/contacts/v1/lists) which works with all Private App token scopes.
  try {
    const allSegments: Record<string, unknown>[] = [];

    // Attempt 1 — v3 API (requires crm.lists.read scope)
    let v3Failed = false;
    try {
      let segOffset = 0;
      let hasMore = true;
      while (hasMore && allSegments.length < 10000) {
        const res = await axios.get('https://api.hubapi.com/crm/v3/lists', {
          headers,
          params: { count: 100, offset: segOffset, includeFilters: false },
          timeout: 15000,
        });
        const lists = (res.data.lists || []) as Array<Record<string, unknown>>;
        allSegments.push(...lists);
        hasMore = Boolean(res.data.hasMore);
        segOffset = Number(res.data.offset || 0) + lists.length;
        if (!hasMore || lists.length === 0) break;
      }
    } catch {
      v3Failed = true;
    }

    // Attempt 2 — legacy v1 API (works with all scopes, stable endpoint)
    if (v3Failed || allSegments.length === 0) {
      allSegments.length = 0;
      let segOffset = 0;
      let hasMore = true;
      while (hasMore && allSegments.length < 10000) {
        const res = await axios.get('https://api.hubapi.com/contacts/v1/lists', {
          headers,
          params: { count: 100, offset: segOffset },
          timeout: 15000,
        }).catch(() => ({ data: { lists: [], 'has-more': false, offset: 0 } }));
        const lists = (res.data.lists || []) as Array<Record<string, unknown>>;
        allSegments.push(...lists);
        hasMore = Boolean(res.data['has-more']);
        segOffset = Number(res.data.offset || 0) + lists.length;
        if (!hasMore || lists.length === 0) break;
      }
    }

    const segmentsToUpsert = allSegments.map((seg) => {
      const id = String(seg.listId ?? seg.id ?? '');
      return {
        externalId: id,
        displayName: String(seg.name || id),
        data: {
          name:            seg.name,
          listType:        seg.listType || (seg.dynamic ? 'DYNAMIC' : 'STATIC'),
          membershipCount: seg.membershipCount ?? (seg.metaData as Record<string, unknown> | undefined)?.['size'],
          objectTypeId:    seg.objectTypeId,
          createdAt:       seg.createdAt,
          updatedAt:       seg.updatedAt,
        } as Record<string, unknown>,
      };
    });

    syncedModules.add('Segments');
    if (segmentsToUpsert.length > 0) {
      await upsertCRMRecords(tenantId, 'hubspot', 'Segments', segmentsToUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
      await deleteMissingCRMRecords(tenantId, 'hubspot', 'Segments', segmentsToUpsert.map((r) => r.externalId));
    }
    logger.info('HubSpot segments synced', { count: segmentsToUpsert.length });
  } catch (err) {
    logger.warn('HubSpot segments sync skipped', { error: (err as Error).message });
  }

  // ── Step 6: Remove stale modules that no longer exist in HubSpot ─────────
  const { CRMRecord } = await import('../crm/crm-record.model');
  const storedModules = await CRMRecord.distinct('module', {
    tenantId: new mongoose.Types.ObjectId(tenantId), channel: 'hubspot',
  }) as string[];
  for (const stale of storedModules.filter((m) => !syncedModules.has(m))) {
    await CRMRecord.deleteMany({ tenantId: new mongoose.Types.ObjectId(tenantId), channel: 'hubspot', module: stale });
    logger.info(`HubSpot stale module removed: ${stale}`);
  }
}

// ── MySQL: every table except the mapped customer table ───────────────────────
async function syncMySQLModules(
  connector: IConnector, tenantId: string, skipTable: string,
): Promise<void> {
  const mysql = require('mysql2/promise');
  const conn  = await mysql.createConnection(connector.config.uri || {
    host: connector.config.host, user: connector.config.username,
    password: connector.config.password, database: connector.config.database,
    port: connector.config.port,
  });
  try {
    const [tableRows] = await conn.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
    );
    for (const tr of tableRows as Array<{ TABLE_NAME: string }>) {
      const tbl = tr.TABLE_NAME;
      if (tbl === skipTable) continue;
      try {
        const [rows] = await conn.query(`SELECT * FROM \`${tbl}\` LIMIT 10000`);
        const data = rows as Record<string, unknown>[];
        if (!data.length) continue;
        const toUpsert = data.map((r) => ({
          externalId: String(r.id ?? r._id ?? Object.values(r)[0] ?? ''),
          displayName: pickDisplayNameFromRow(r),
          data: flattenRow(r),
        }));
        await upsertCRMRecords(tenantId, 'mysql', tbl, toUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
        await deleteMissingCRMRecords(tenantId, 'mysql', tbl, toUpsert.map((r) => r.externalId));
        logger.info(`MySQL table synced: ${tbl}`, { count: toUpsert.length });
      } catch (err) {
        logger.warn(`MySQL table sync skipped: ${tbl}`, { error: (err as Error).message });
      }
    }
  } finally {
    await conn.end();
  }
}

// ── PostgreSQL: every public table except the mapped customer table ───────────
async function syncPostgreSQLModules(
  connector: IConnector, tenantId: string, skipTable: string,
): Promise<void> {
  const { Client } = require('pg');
  const client = new Client(connector.config.uri
    ? { connectionString: connector.config.uri }
    : { host: connector.config.host, user: connector.config.username,
        password: connector.config.password, database: connector.config.database,
        port: connector.config.port });
  await client.connect();
  try {
    const tablesRes = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    for (const tr of tablesRes.rows as Array<{ tablename: string }>) {
      const tbl = tr.tablename;
      if (tbl === skipTable) continue;
      try {
        const res = await client.query(`SELECT * FROM "${tbl}" LIMIT 10000`);
        if (!res.rows.length) continue;
        const toUpsert = (res.rows as Record<string, unknown>[]).map((r) => ({
          externalId: String(r.id ?? r._id ?? ''),
          displayName: pickDisplayNameFromRow(r),
          data: flattenRow(r),
        }));
        await upsertCRMRecords(tenantId, 'postgresql', tbl, toUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
        await deleteMissingCRMRecords(tenantId, 'postgresql', tbl, toUpsert.map((r) => r.externalId));
        logger.info(`PostgreSQL table synced: ${tbl}`, { count: toUpsert.length });
      } catch (err) {
        logger.warn(`PostgreSQL table sync skipped: ${tbl}`, { error: (err as Error).message });
      }
    }
  } finally {
    await client.end();
  }
}

// ── MongoDB: every collection except the mapped customer collection ────────────
async function syncMongoDBModules(
  connector: IConnector, tenantId: string, skipCollection: string,
): Promise<void> {
  const { MongoClient } = require('mongodb');
  const uri    = connector.config.uri!;
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const dbNameFromUri = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace(/^\//, '').split('?')[0];
    const dbName        = dbNameFromUri || connector.config.database || undefined;
    const db = client.db(dbName);
    const cols = (await db.listCollections().toArray()) as Array<{ name: string }>;
    for (const col of cols) {
      const colName = col.name;
      if (colName === skipCollection) continue;
      try {
        const rows = (await db.collection(colName).find({}).limit(10000).toArray()) as Record<string, unknown>[];
        if (!rows.length) continue;
        const toUpsert = rows.map((r) => ({
          externalId: String(r._id ?? r.id ?? ''),
          displayName: pickDisplayNameFromRow(r),
          data: flattenRow({ ...r, _id: String(r._id) }),
        }));
        await upsertCRMRecords(tenantId, 'mongodb', colName, toUpsert, { connectorName: connector.name, triggeredBy: 'sync' });
        await deleteMissingCRMRecords(tenantId, 'mongodb', colName, toUpsert.map((r) => r.externalId));
        logger.info(`MongoDB collection synced: ${colName}`, { count: toUpsert.length });
      } catch (err) {
        logger.warn(`MongoDB collection sync skipped: ${colName}`, { error: (err as Error).message });
      }
    }
  } finally {
    await client.close();
  }
}

export async function syncCRMToLocal(
  tenantId: string,
  connectorId: string
): Promise<{ created: number; updated: number; deleted: number; total: number }> {
  const connector = await Connector.findById(connectorId);
  if (!connector) throw new Error('Connector not found');

  const crmRecords = await fetchCRMCustomers(tenantId, connectorId) as CustomerRecord[];
  const tid    = new mongoose.Types.ObjectId(tenantId);
  const source = connector.type;
  let created = 0, updated = 0;

  // Track all externalIds returned by this connector in this sync (for mirror delete)
  const syncedExternalIds = new Set<string>();

  for (const record of crmRecords) {
    const name = [record.firstName, record.lastName].filter(Boolean).join(' ') || 'Unknown';
    if (record.externalId) syncedExternalIds.add(record.externalId);

    // ── Channel-scoped dedup ──
    // Each connector owns its own isolated records — no cross-connector merging.
    // Zoho + MySQL both having "John Doe" → 2 separate rows, each filterable by channel.
    const filter = record.externalId
      ? { tenantId: tid, channel: source, externalId: record.externalId }
      : record.email
        ? { tenantId: tid, channel: source, email: record.email }
        : { tenantId: tid, channel: source, name };

    const updateData = {
      name,
      firstName:    record.firstName,
      lastName:     record.lastName,
      email:        record.email,
      phone:        record.phone,
      company:      record.company,
      leadSource:   record.leadSource,
      channel:      source,
      sources:      [source],
      recordType:   record.recordType || 'customer',
      status:       record.status || 'new',
      externalId:   record.externalId,
      customFields: record.customFields || {},
      tags:         [source, record.recordType || 'customer'],
      isActive:     true,
    };

    const existing = await Customer.findOne(filter);
    if (existing) {
      // Detect what changed before writing
      const changedFields: Array<{ field: string; from: unknown; to: unknown }> = [];
      if (existing.name  !== name)          changedFields.push({ field: 'Name',  from: existing.name,  to: name });
      if (existing.email !== record.email)  changedFields.push({ field: 'Email', from: existing.email, to: record.email });
      if (existing.phone !== record.phone)  changedFields.push({ field: 'Phone', from: existing.phone, to: record.phone });

      await Customer.findByIdAndUpdate(existing._id, { $set: updateData });
      updated++;

      if (changedFields.length > 0) {
        writeLog({
          tenantId,
          service:  'backend',
          level:    'info',
          event:    'customer.synced_update',
          message:  `Customer "${name}" updated via ${source} sync (${connector.name})`,
          metadata: {
            customerId:    String(existing._id),
            connectorName: connector.name,
            connectorType: source,
            triggeredBy:   'sync',
            changedFields,
          },
        });
      }
    } else {
      await Customer.create({ tenantId: tid, ...updateData });
      created++;
      writeLog({
        tenantId,
        service:  'backend',
        level:    'info',
        event:    'customer.synced_create',
        message:  `New customer "${name}" imported via ${source} sync (${connector.name})`,
        metadata: {
          name,
          email:         record.email,
          phone:         record.phone,
          connectorName: connector.name,
          connectorType: source,
          triggeredBy:   'sync',
        },
      });
    }
  }

  // ── Mirror delete: remove records from THIS connector that no longer exist in CRM ──
  // Guard: if sync returned 0 records (likely expired token / auth failure), skip delete
  // to avoid wiping all local data on a bad sync.
  let deleted = 0;
  if (syncedExternalIds.size > 0) {
    const deleteResult = await Customer.deleteMany({
      tenantId: tid,
      channel: source,
      externalId: { $exists: true, $ne: '', $nin: Array.from(syncedExternalIds) },
    });
    deleted = deleteResult.deletedCount ?? 0;
  }

  // ── Sync ALL CRM modules into CRMRecord for every connector type ──────────
  // Zoho: dynamic auto-discover via /settings/modules
  // HubSpot: Companies, Deals, Tickets, Products
  // MySQL/PostgreSQL/MongoDB: every table/collection except the mapped customer one
  // REST API: no additional modules (single-endpoint by design)
  {
    const fresh = await Connector.findById(connectorId).select(
      '+config.accessToken +config.refreshToken +config.username +config.apiKey +config.baseUrl +config.password +config.uri'
    );
    if (fresh) {
      decryptConnectorConfig(fresh);
      if (fresh.type === 'hubspot' && !fresh.config.accessToken && fresh.config.apiKey) {
        fresh.config.accessToken = fresh.config.apiKey;
      }
      const m = (fresh.mapping?.customerFields || {}) as Record<string, string>;
      try {
        if (connector.type === 'zoho') {
          if (fresh.config.accessToken) await syncZohoCRMModules(fresh, tenantId, fresh.config.accessToken);
        } else if (connector.type === 'salesforce') {
          if (fresh.config.accessToken && fresh.config.baseUrl)
            await syncSalesforceCRMModules(fresh, tenantId, fresh.config.accessToken, fresh.config.baseUrl);
        } else if (connector.type === 'hubspot') {
          await syncHubSpotCRMModules(fresh, tenantId);
        } else if (connector.type === 'mysql') {
          await syncMySQLModules(fresh, tenantId, m['__table'] || 'customers');
        } else if (connector.type === 'postgresql') {
          await syncPostgreSQLModules(fresh, tenantId, m['__table'] || 'customers');
        } else if (connector.type === 'mongodb') {
          await syncMongoDBModules(fresh, tenantId, m['__collection'] || 'customers');
        }
      } catch (err) {
        logger.warn('CRM module sync failed (non-fatal)', { type: connector.type, error: (err as Error).message });
      }
    }
  }
  
  // Auto-generate dynamic permissions for discovered CRM modules (fire-and-forget)
  _generateDynamicPermissions(tenantId, connector).catch(() => {});

  await Connector.findByIdAndUpdate(connectorId, { lastSyncAt: new Date(), syncStatus: 'success' });
  logger.info('CRM sync complete', { tenantId, connectorId, source, created, updated, deleted });
  return { created, updated, deleted, total: crmRecords.length };
}

// ── Dynamic RBAC permissions from connector module discovery ──────────────────
async function _generateDynamicPermissions(tenantId: string, connector: IConnector): Promise<void> {
  try {
    const tid        = new mongoose.Types.ObjectId(tenantId);
    const connType   = connector.type;
    const connId     = connector._id as mongoose.Types.ObjectId;

    const modules = await CRMRecord.distinct('module', { tenantId: tid, channel: connType });
    if (!modules.length) return;

    const actions = ['view', 'create', 'edit', 'delete', 'export'];
    const ops = modules.flatMap((mod: string) =>
      actions.map((action) => {
        const key = `connector.${connType}.${mod.toLowerCase()}.${action}`;
        return {
          updateOne: {
            filter: { tenantId: null, key },
            update: {
              $setOnInsert: {
                tenantId:    null,
                key,
                module:      'connector',
                resource:    `${connType}.${mod.toLowerCase()}`,
                action,
                label:       `${connType} ${mod} — ${action}`,
                isSystem:    false,
                scope:       'dynamic' as PermissionScope,
                connectorId: connId,
              },
            },
            upsert: true,
          },
        };
      })
    );

    if (ops.length) {
      await Permission.bulkWrite(ops, { ordered: false });

      // Auto-grant new dynamic permissions to the tenant's Admin system role
      // (Admin was seeded with `*` which only expanded to system perms at seed time)
      const { Role }           = await import('../rbac/role.model');
      const { RolePermission } = await import('../rbac/role-permission.model');
      const adminRole = await Role.findOne({
        tenantId: tid, name: 'Admin', isSystem: true,
      }, '_id').lean();

      if (adminRole) {
        const newPermDocs = await Permission.find(
          { tenantId: null, key: { $in: modules.flatMap((mod: string) =>
            ['view','create','edit','delete','export'].map(a => `connector.${connType}.${mod.toLowerCase()}.${a}`)
          )}},
          '_id'
        ).lean();

        const grantOps = newPermDocs.map((p) => ({
          updateOne: {
            filter: { roleId: adminRole._id, permissionId: p._id },
            update: {
              $setOnInsert: {
                roleId:       adminRole._id,
                permissionId: p._id,
                tenantId:     tid,
                grantedBy:    adminRole._id,
                grantedAt:    new Date(),
              },
            },
            upsert: true,
          },
        }));
        if (grantOps.length) await RolePermission.bulkWrite(grantOps, { ordered: false });
      }

      await invalidateRoleCache(tenantId);
      logger.info('Dynamic permissions generated', { tenantId, connType, modules: modules.length });
    }
  } catch (err) {
    logger.warn('Dynamic permission generation failed', { error: (err as Error).message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── TWO-WAY WRITE-BACK: LeadRyze → source CRM ─────────────────────────────────
// Triggered ONLY from user-initiated API calls (update/delete).
// Never called from sync functions → no infinite loop possible.
// All failures are logged and swallowed — never block the API response.
// ═══════════════════════════════════════════════════════════════════════════════

type WBPayload = {
  externalId?: string;
  channel?: string;
  recordType?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  leadSource?: string;
};

const WB_CHANNELS = new Set(['zoho', 'salesforce', 'hubspot', 'mysql', 'postgresql', 'mongodb']);

async function wbGetConnector(tenantId: string, channel: string): Promise<IConnector | null> {
  const conn = await Connector.findOne(
    { tenantId: new mongoose.Types.ObjectId(tenantId), type: channel, isActive: true },
  ).select(
    '+config.accessToken +config.refreshToken +config.apiKey +config.baseUrl ' +
    '+config.password +config.uri +config.host +config.username +config.database +config.port'
  );
  if (conn) {
    decryptConnectorConfig(conn);
    if (conn.type === 'hubspot' && !conn.config.accessToken && conn.config.apiKey) {
      conn.config.accessToken = conn.config.apiKey;
    }
  }
  return conn;
}

async function wbZoho(connector: IConnector, c: WBPayload): Promise<void> {
  const token = await refreshZohoToken(connector);
  const base  = (connector.config.baseUrl || 'https://www.zohoapis.in/crm/v3').replace(/\/$/, '');
  const mod   = c.recordType === 'contact' ? 'Contacts' : 'Leads';
  const body: Record<string, string> = {};
  if (c.firstName) body.First_Name = c.firstName;
  if (c.lastName)  body.Last_Name  = c.lastName;
  if (c.email)     body.Email      = c.email;
  if (c.phone)     body.Phone      = c.phone;
  if (c.company && mod === 'Leads') body.Company = c.company;
  if (!Object.keys(body).length) return;
  await axios.put(`${base}/${mod}/${c.externalId}`,
    { data: [body] },
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
}

async function wbSalesforce(connector: IConnector, c: WBPayload): Promise<void> {
  const { accessToken, instanceUrl } = await refreshSalesforceToken(connector);
  const obj  = c.recordType === 'contact' ? 'Contact' : 'Lead';
  const body: Record<string, string> = {};
  if (c.firstName) body.FirstName = c.firstName;
  if (c.lastName)  body.LastName  = c.lastName;
  if (c.email)     body.Email     = c.email;
  if (c.phone)     body.Phone     = c.phone;
  if (c.company && obj === 'Lead') body.Company = c.company;
  if (!Object.keys(body).length) return;
  await axios.patch(
    `${instanceUrl}/services/data/v59.0/sobjects/${obj}/${c.externalId}`,
    body,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
}

async function wbHubSpot(connector: IConnector, c: WBPayload): Promise<void> {
  const props: Record<string, string> = {};
  if (c.firstName) props.firstname = c.firstName;
  if (c.lastName)  props.lastname  = c.lastName;
  if (c.email)     props.email     = c.email;
  if (c.phone)     props.phone     = c.phone;
  if (c.company)   props.company   = c.company;
  if (!Object.keys(props).length) return;
  await axios.patch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${c.externalId}`,
    { properties: props },
    { headers: { Authorization: `Bearer ${connector.config.accessToken}`, 'Content-Type': 'application/json' } }
  );
}

async function wbMySQL(connector: IConnector, c: WBPayload): Promise<void> {
  const { createConnection } = await import('mysql2/promise');
  const db = await createConnection({
    host: connector.config.host, port: Number(connector.config.port) || 3306,
    database: connector.config.database, user: connector.config.username, password: connector.config.password,
  });
  try {
    const mapping = (connector.mapping?.customerFields || {}) as Record<string, string>;
    const table   = mapping['__table'] || 'customers';
    const rev: Record<string, string> = {};
    for (const [lf, cf] of Object.entries(mapping)) { if (lf !== '__table') rev[lf] = cf; }
    const sets: string[] = []; const vals: string[] = [];
    for (const [lf, cf] of Object.entries(rev)) {
      const v = (c as Record<string, unknown>)[lf];
      if (v !== undefined && v !== null && String(v) !== '') { sets.push(`\`${cf}\` = ?`); vals.push(String(v)); }
    }
    if (!sets.length) return;
    vals.push(c.externalId!);
    await db.execute(`UPDATE \`${table}\` SET ${sets.join(', ')} WHERE id = ?`, vals);
  } finally { await db.end(); }
}

async function wbPostgreSQL(connector: IConnector, c: WBPayload): Promise<void> {
  const { Client } = await import('pg');
  const db = new Client({
    host: connector.config.host, port: Number(connector.config.port) || 5432,
    database: connector.config.database, user: connector.config.username, password: connector.config.password,
  });
  await db.connect();
  try {
    const mapping = (connector.mapping?.customerFields || {}) as Record<string, string>;
    const table   = mapping['__table'] || 'customers';
    const rev: Record<string, string> = {};
    for (const [lf, cf] of Object.entries(mapping)) { if (lf !== '__table') rev[lf] = cf; }
    const sets: string[] = []; const vals: unknown[] = []; let i = 1;
    for (const [lf, cf] of Object.entries(rev)) {
      const v = (c as Record<string, unknown>)[lf];
      if (v !== undefined && v !== null && String(v) !== '') { sets.push(`"${cf}" = $${i++}`); vals.push(v); }
    }
    if (!sets.length) return;
    vals.push(c.externalId);
    await db.query(`UPDATE "${table}" SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  } finally { await db.end(); }
}

async function wbMongoDB(connector: IConnector, c: WBPayload): Promise<void> {
  const { MongoClient, ObjectId } = await import('mongodb');
  const client = new MongoClient(connector.config.uri!);
  await client.connect();
  try {
    const mapping    = (connector.mapping?.customerFields || {}) as Record<string, string>;
    const collection = mapping['__collection'] || 'customers';
    const rev: Record<string, string> = {};
    for (const [lf, cf] of Object.entries(mapping)) { if (lf !== '__collection') rev[lf] = cf; }
    const upd: Record<string, unknown> = {};
    for (const [lf, cf] of Object.entries(rev)) {
      const v = (c as Record<string, unknown>)[lf];
      if (v !== undefined && v !== null && String(v) !== '') upd[cf] = v;
    }
    if (!Object.keys(upd).length) return;
    let id: import('mongodb').ObjectId | string = c.externalId ?? '';
    try { id = new ObjectId(c.externalId!); } catch { /* keep string id */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.db().collection(collection).updateOne({ _id: id as any }, { $set: upd });
  } finally { await client.close(); }
}

export async function pushCustomerUpdate(tenantId: string, customer: WBPayload): Promise<void> {
  if (!customer.externalId || !customer.channel || !WB_CHANNELS.has(customer.channel)) return;
  const connector = await wbGetConnector(tenantId, customer.channel);
  if (!connector) return;
  try {
    switch (connector.type) {
      case 'zoho':       await wbZoho(connector, customer);       break;
      case 'salesforce': await wbSalesforce(connector, customer); break;
      case 'hubspot':    await wbHubSpot(connector, customer);    break;
      case 'mysql':      await wbMySQL(connector, customer);      break;
      case 'postgresql': await wbPostgreSQL(connector, customer); break;
      case 'mongodb':    await wbMongoDB(connector, customer);    break;
    }
    writeLog({
      tenantId, service: 'backend', level: 'info', event: 'connector.writeback',
      message: `"${customer.name || customer.externalId}" synced back to ${connector.name} (${connector.type})`,
      metadata: { connectorId: String(connector._id), connectorType: connector.type, externalId: customer.externalId },
    });
  } catch (err) {
    writeLog({
      tenantId, service: 'backend', level: 'warn', event: 'connector.writeback_failed',
      message: `Write-back to ${connector.name} (${connector.type}) failed: ${(err as Error).message}`,
      metadata: { connectorId: String(connector._id), externalId: customer.externalId },
    });
  }
}

/* ─────────────────── CRM RECORD WRITE-BACK ─────────────────────────────── */

type CRMWBRecord = {
  externalId:  string;
  channel:     string;
  module:      string;
  displayName?: string;
  changedData: Record<string, unknown>;
};

const SF_READONLY = new Set([
  'Id', 'CreatedDate', 'LastModifiedDate', 'SystemModstamp', 'IsDeleted',
  'LastActivityDate', 'LastViewedDate', 'LastReferencedDate',
  'CreatedById', 'LastModifiedById', 'PhotoUrl', 'attributes',
]);

function hsObjectType(module: string): string {
  const m = module.toLowerCase();
  if (m.includes('contact'))            return 'contacts';
  if (m.includes('deal'))               return 'deals';
  if (m.includes('compan'))             return 'companies';
  if (m.includes('ticket'))             return 'tickets';
  if (m.includes('product'))            return 'products';
  if (m.includes('line') && m.includes('item')) return 'line_items';
  return 'contacts';
}

function cleanZoho(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith('$') && k !== 'id') out[k] = v;
  }
  return out;
}

function cleanSF(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!SF_READONLY.has(k) && !k.endsWith('__r') && typeof v !== 'object') out[k] = v;
  }
  return out;
}

export async function pushCRMRecordUpdate(tenantId: string, rec: CRMWBRecord): Promise<void> {
  if (!rec.externalId || !rec.channel || !WB_CHANNELS.has(rec.channel) || !Object.keys(rec.changedData).length) return;
  const connector = await wbGetConnector(tenantId, rec.channel);
  if (!connector) return;
  try {
    if (connector.type === 'zoho') {
      const token = await refreshZohoToken(connector);
      const base  = (connector.config.baseUrl || 'https://www.zohoapis.in/crm/v3').replace(/\/$/, '');
      const body  = { id: rec.externalId, ...cleanZoho(rec.changedData) };
      await axios.put(`${base}/${rec.module}`, { data: [body] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } });

    } else if (connector.type === 'salesforce') {
      const { accessToken, instanceUrl } = await refreshSalesforceToken(connector);
      const body = cleanSF(rec.changedData);
      if (Object.keys(body).length) {
        await axios.patch(
          `${instanceUrl}/services/data/v59.0/sobjects/${rec.module}/${rec.externalId}`,
          body,
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
        );
      }
    } else if (connector.type === 'hubspot') {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/${hsObjectType(rec.module)}/${rec.externalId}`,
        { properties: rec.changedData },
        { headers: { Authorization: `Bearer ${connector.config.accessToken}`, 'Content-Type': 'application/json' } },
      );
    } else if (connector.type === 'mysql') {
      const { createConnection } = await import('mysql2/promise');
      const db   = await createConnection({ host: connector.config.host, port: Number(connector.config.port) || 3306, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      const sets: string[] = []; const vals: (string | number | boolean | null)[] = [];
      for (const [k, v] of Object.entries(rec.changedData)) { sets.push(`\`${k}\` = ?`); vals.push(v as string | number | boolean | null); }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { if (sets.length) { vals.push(rec.externalId as any); await db.execute(`UPDATE \`${rec.module}\` SET ${sets.join(', ')} WHERE id = ?`, vals); } }
      finally { await db.end(); }
    } else if (connector.type === 'postgresql') {
      const { Client } = await import('pg');
      const db = new Client({ host: connector.config.host, port: Number(connector.config.port) || 5432, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      await db.connect();
      const sets: string[] = []; const vals: unknown[] = [];
      for (const [k, v] of Object.entries(rec.changedData)) { sets.push(`"${k}" = $${sets.length + 1}`); vals.push(v); }
      try { if (sets.length) { vals.push(rec.externalId); await db.query(`UPDATE "${rec.module}" SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); } }
      finally { await db.end(); }
    } else if (connector.type === 'mongodb') {
      const { MongoClient, ObjectId } = await import('mongodb');
      const client = new MongoClient(connector.config.uri!);
      await client.connect();
      let id: import('mongodb').ObjectId | string = rec.externalId ?? '';
      try { id = new ObjectId(rec.externalId); } catch { /* keep string */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { await client.db().collection(rec.module.toLowerCase()).updateOne({ _id: id as any }, { $set: rec.changedData }); }
      finally { await client.close(); }
    }
    writeLog({ tenantId, service: 'backend', level: 'info', event: 'connector.crm_writeback_update',
      message:  `CRM record "${rec.displayName || rec.externalId}" updated in ${connector.name} [${rec.module}]`,
      metadata: { connectorId: String(connector._id), connectorType: connector.type, module: rec.module, externalId: rec.externalId, changedFields: Object.keys(rec.changedData) },
    });
  } catch (err) {
    writeLog({ tenantId, service: 'backend', level: 'warn', event: 'connector.crm_writeback_failed',
      message:  `CRM write-back update to ${connector.name} failed: ${(err as Error).message}`,
      metadata: { connectorId: String(connector._id), module: rec.module, externalId: rec.externalId },
    });
  }
}

export async function pushCRMRecordDelete(tenantId: string, rec: CRMWBRecord): Promise<void> {
  if (!rec.externalId || !rec.channel || !WB_CHANNELS.has(rec.channel)) return;
  const connector = await wbGetConnector(tenantId, rec.channel);
  if (!connector) return;
  try {
    if (connector.type === 'zoho') {
      const token = await refreshZohoToken(connector);
      const base  = (connector.config.baseUrl || 'https://www.zohoapis.in/crm/v3').replace(/\/$/, '');
      await axios.delete(`${base}/${rec.module}?ids=${rec.externalId}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } });

    } else if (connector.type === 'salesforce') {
      const { accessToken, instanceUrl } = await refreshSalesforceToken(connector);
      await axios.delete(
        `${instanceUrl}/services/data/v59.0/sobjects/${rec.module}/${rec.externalId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
    } else if (connector.type === 'hubspot') {
      await axios.delete(
        `https://api.hubapi.com/crm/v3/objects/${hsObjectType(rec.module)}/${rec.externalId}`,
        { headers: { Authorization: `Bearer ${connector.config.accessToken}` } },
      );
    } else if (connector.type === 'mysql') {
      const { createConnection } = await import('mysql2/promise');
      const db = await createConnection({ host: connector.config.host, port: Number(connector.config.port) || 3306, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      try { await db.execute(`DELETE FROM \`${rec.module}\` WHERE id = ?`, [rec.externalId]); } finally { await db.end(); }
    } else if (connector.type === 'postgresql') {
      const { Client } = await import('pg');
      const db = new Client({ host: connector.config.host, port: Number(connector.config.port) || 5432, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      await db.connect();
      try { await db.query(`DELETE FROM "${rec.module}" WHERE id = $1`, [rec.externalId]); } finally { await db.end(); }
    } else if (connector.type === 'mongodb') {
      const { MongoClient, ObjectId } = await import('mongodb');
      const client = new MongoClient(connector.config.uri!);
      await client.connect();
      let id: import('mongodb').ObjectId | string = rec.externalId ?? '';
      try { id = new ObjectId(rec.externalId); } catch { /* keep string */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { await client.db().collection(rec.module.toLowerCase()).deleteOne({ _id: id as any }); } finally { await client.close(); }
    }
    writeLog({ tenantId, service: 'backend', level: 'warn', event: 'connector.crm_writeback_delete',
      message:  `CRM record "${rec.displayName || rec.externalId}" deleted from ${connector.name} [${rec.module}]`,
      metadata: { connectorId: String(connector._id), connectorType: connector.type, module: rec.module, externalId: rec.externalId },
    });
  } catch (err) {
    writeLog({ tenantId, service: 'backend', level: 'warn', event: 'connector.crm_writeback_failed',
      message:  `CRM write-back delete to ${connector.name} failed: ${(err as Error).message}`,
      metadata: { connectorId: String(connector._id), module: rec.module, externalId: rec.externalId },
    });
  }
}

export async function pushCRMRecordCreate(tenantId: string, rec: CRMWBRecord): Promise<string | null> {
  if (!rec.channel || !WB_CHANNELS.has(rec.channel)) return null;
  const connector = await wbGetConnector(tenantId, rec.channel);
  if (!connector) return null;
  try {
    if (connector.type === 'zoho') {
      const token = await refreshZohoToken(connector);
      const base  = (connector.config.baseUrl || 'https://www.zohoapis.in/crm/v3').replace(/\/$/, '');
      const body  = cleanZoho(rec.changedData);
      const r = await axios.post(`${base}/${rec.module}`, { data: [body] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      return (r.data?.data?.[0]?.details?.id as string) || null;

    } else if (connector.type === 'salesforce') {
      const { accessToken, instanceUrl } = await refreshSalesforceToken(connector);
      const body = cleanSF(rec.changedData);
      const r = await axios.post(
        `${instanceUrl}/services/data/v59.0/sobjects/${rec.module}`,
        body,
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      );
      return (r.data?.id as string) || null;
    } else if (connector.type === 'hubspot') {
      const r = await axios.post(
        `https://api.hubapi.com/crm/v3/objects/${hsObjectType(rec.module)}`,
        { properties: rec.changedData },
        { headers: { Authorization: `Bearer ${connector.config.accessToken}`, 'Content-Type': 'application/json' } },
      );
      return String(r.data?.id || '') || null;
    } else if (connector.type === 'mysql') {
      const { createConnection } = await import('mysql2/promise');
      const db = await createConnection({ host: connector.config.host, port: Number(connector.config.port) || 3306, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      try {
        const keys = Object.keys(rec.changedData);
        const cols = keys.map((k) => `\`${k}\``).join(', ');
        const phs  = keys.map(() => '?').join(', ');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [result] = await db.execute(`INSERT INTO \`${rec.module}\` (${cols}) VALUES (${phs})`, Object.values(rec.changedData) as any[]);
        return String((result as { insertId: number }).insertId);
      } finally { await db.end(); }
    } else if (connector.type === 'postgresql') {
      const { Client } = await import('pg');
      const db = new Client({ host: connector.config.host, port: Number(connector.config.port) || 5432, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      await db.connect();
      try {
        const keys = Object.keys(rec.changedData);
        const cols = keys.map((k) => `"${k}"`).join(', ');
        const phs  = keys.map((_, i) => `$${i + 1}`).join(', ');
        const r    = await db.query(`INSERT INTO "${rec.module}" (${cols}) VALUES (${phs}) RETURNING id`, Object.values(rec.changedData));
        return String(r.rows[0]?.id || '');
      } finally { await db.end(); }
    } else if (connector.type === 'mongodb') {
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(connector.config.uri!);
      await client.connect();
      try {
        const r = await client.db().collection(rec.module.toLowerCase()).insertOne(rec.changedData as import('mongodb').OptionalUnlessRequiredId<import('mongodb').Document>);
        return String(r.insertedId);
      } finally { await client.close(); }
    }
    return null;
  } catch (err) {
    writeLog({ tenantId, service: 'backend', level: 'warn', event: 'connector.crm_writeback_failed',
      message:  `CRM write-back create to ${connector?.name} failed: ${(err as Error).message}`,
      metadata: { module: rec.module },
    });
    return null;
  }
}

export async function pushCustomerDelete(tenantId: string, customer: WBPayload): Promise<void> {
  if (!customer.externalId || !customer.channel || !WB_CHANNELS.has(customer.channel)) return;
  const connector = await wbGetConnector(tenantId, customer.channel);
  if (!connector) return;
  try {
    if (connector.type === 'zoho') {
      const token = await refreshZohoToken(connector);
      const base  = (connector.config.baseUrl || 'https://www.zohoapis.in/crm/v3').replace(/\/$/, '');
      const mod   = customer.recordType === 'contact' ? 'Contacts' : 'Leads';
      await axios.delete(`${base}/${mod}?ids=${customer.externalId}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      );
    } else if (connector.type === 'salesforce') {
      const { accessToken, instanceUrl } = await refreshSalesforceToken(connector);
      const obj = customer.recordType === 'contact' ? 'Contact' : 'Lead';
      await axios.delete(
        `${instanceUrl}/services/data/v59.0/sobjects/${obj}/${customer.externalId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } else if (connector.type === 'hubspot') {
      await axios.delete(
        `https://api.hubapi.com/crm/v3/objects/contacts/${customer.externalId}`,
        { headers: { Authorization: `Bearer ${connector.config.accessToken}` } }
      );
    } else if (connector.type === 'mysql') {
      const { createConnection } = await import('mysql2/promise');
      const db  = await createConnection({ host: connector.config.host, port: Number(connector.config.port) || 3306, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      const tbl = (connector.mapping?.customerFields as Record<string, string>)?.['__table'] || 'customers';
      try { await db.execute(`DELETE FROM \`${tbl}\` WHERE id = ?`, [customer.externalId]); } finally { await db.end(); }
    } else if (connector.type === 'postgresql') {
      const { Client } = await import('pg');
      const db  = new Client({ host: connector.config.host, port: Number(connector.config.port) || 5432, database: connector.config.database, user: connector.config.username, password: connector.config.password });
      const tbl = (connector.mapping?.customerFields as Record<string, string>)?.['__table'] || 'customers';
      await db.connect();
      try { await db.query(`DELETE FROM "${tbl}" WHERE id = $1`, [customer.externalId]); } finally { await db.end(); }
    } else if (connector.type === 'mongodb') {
      const { MongoClient, ObjectId } = await import('mongodb');
      const client = new MongoClient(connector.config.uri!);
      const col    = (connector.mapping?.customerFields as Record<string, string>)?.['__collection'] || 'customers';
      await client.connect();
      let id: import('mongodb').ObjectId | string = customer.externalId ?? '';
      try { id = new ObjectId(customer.externalId!); } catch { /* keep string */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { await client.db().collection(col).deleteOne({ _id: id as any }); } finally { await client.close(); }
    }
    writeLog({
      tenantId, service: 'backend', level: 'warn', event: 'connector.writeback_delete',
      message: `"${customer.name || customer.externalId}" deleted from ${connector.name} (${connector.type})`,
      metadata: { connectorId: String(connector._id), connectorType: connector.type, externalId: customer.externalId },
    });
  } catch (err) {
    writeLog({
      tenantId, service: 'backend', level: 'warn', event: 'connector.writeback_failed',
      message: `Delete write-back to ${connector.name} (${connector.type}) failed: ${(err as Error).message}`,
      metadata: { connectorId: String(connector._id), externalId: customer.externalId },
    });
  }
}

// ── HubSpot webhook helpers ───────────────────────────────────────────────────

/** Find the HubSpot connector for a given portalId across all tenants. */
export async function findHubSpotConnectorByPortalId(
  portalId: string
): Promise<IConnector | null> {
  const conn = await Connector.findOne({
    type: 'hubspot',
    isActive: true,
    'config.hubId': portalId,
  }).select('+config.accessToken +config.apiKey +config.webhookSecret') as IConnector | null;
  if (conn) {
    decryptConnectorConfig(conn);
    if (!conn.config.accessToken && conn.config.apiKey) {
      conn.config.accessToken = conn.config.apiKey;
    }
  }
  return conn;
}

/** Fetch one HubSpot contact and upsert into Customer model. */
export async function hubSpotUpsertContact(
  tenantId: string,
  connector: IConnector,
  contactId: string
): Promise<void> {
  const headers = { Authorization: `Bearer ${connector.config.accessToken}` };

  const propsRes = await axios.get('https://api.hubapi.com/crm/v3/properties/contacts', { headers })
    .catch(() => ({ data: { results: [] } }));
  const allProps = (propsRes.data.results as Array<{ name: string }>).map((p) => p.name).join(',');

  const res = await axios.get(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
    { headers, params: { properties: allProps || 'firstname,lastname,email,phone,company' } }
  );

  const r     = res.data;
  const props = (r.properties as Record<string, string>) || {};
  const extra: Record<string, unknown> = {};
  const known: Record<string, string>  = {};
  for (const [key, val] of Object.entries(props)) {
    if (!val) continue;
    const schemaKey = HUBSPOT_KNOWN[key];
    if (schemaKey) { known[schemaKey] = val; }
    else           { extra[key] = val; }
  }

  const tid  = new mongoose.Types.ObjectId(tenantId);
  const name = [known.firstName, known.lastName].filter(Boolean).join(' ') || 'Unknown';
  await Customer.findOneAndUpdate(
    { tenantId: tid, channel: 'hubspot', externalId: String(r.id) },
    {
      $set: {
        name, firstName: known.firstName || '', lastName: known.lastName || '',
        email: known.email || '', phone: known.phone || '',
        company: known.company || '', leadSource: known.leadSource || '',
        channel: 'hubspot', sources: ['hubspot'], recordType: 'contact',
        status: 'new', externalId: String(r.id), customFields: extra,
        tags: ['hubspot', 'contact'], isActive: true,
      },
    },
    { upsert: true, new: true }
  );
}

/** Fetch one HubSpot CRM object (company/deal/ticket) and upsert into CRMRecord. */
export async function hubSpotUpsertCRMObject(
  tenantId: string,
  connector: IConnector,
  objectType: string,
  moduleName: string,
  displayField: string,
  objectId: string
): Promise<void> {
  const headers = { Authorization: `Bearer ${connector.config.accessToken}` };

  const propsRes = await axios.get(`https://api.hubapi.com/crm/v3/properties/${objectType}`, { headers })
    .catch(() => ({ data: { results: [] } }));
  const allProps = (propsRes.data.results as Array<{ name: string }>).map((p) => p.name).join(',');

  const res = await axios.get(
    `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}`,
    { headers, params: { properties: allProps || displayField } }
  );

  const r           = res.data;
  const props2      = (r.properties as Record<string, string>) || {};
  const displayName = props2[displayField] || props2['name'] || String(r.id);

  await upsertCRMRecords(
    tenantId, 'hubspot', moduleName,
    [{ externalId: String(r.id), displayName, data: props2 }],
    { connectorName: connector.name, triggeredBy: 'webhook' }
  );
}

