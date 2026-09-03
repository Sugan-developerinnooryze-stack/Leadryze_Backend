import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../config';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import { createConnector } from './connector.service';
import { OAuthStateNonce } from './oauth-state-nonce.model';
import { logger } from '../../utils/logger';

/** Real "Connect" button flow for Zoho/HubSpot — replaces the old manual
 * copy-paste (Zoho: authorize yourself, paste the resulting code; HubSpot:
 * paste a Private App token). Salesforce deliberately stays on its existing
 * Client Credentials flow (already a real, working, non-interactive OAuth
 * integration — no browser redirect involved, so it has no equivalent here).
 *
 * Two-step dance: initiateOAuth (authenticated, called by our own frontend)
 * returns the provider's real authorize URL; the browser is sent there,
 * the user approves, and the provider redirects back to
 * handleOAuthCallback (necessarily PUBLIC — no Authorization header on a
 * browser redirect from a third-party server). Tenant identity survives the
 * round trip via `state`, a short-lived signed JWT (same JWT_SECRET already
 * used everywhere) rather than a session — this backend is stateless
 * between requests. */

type OAuthConnectorType = 'zoho' | 'hubspot';

function isOAuthType(t: string): t is OAuthConnectorType {
  return t === 'zoho' || t === 'hubspot';
}

/** Same `BACKEND_PUBLIC_URL || localhost:5000` fallback the existing
 * HubSpot webhook URL already uses (connector.service.ts's createConnector)
 * — kept identical so both derive from the same one env var. */
function redirectUriFor(type: OAuthConnectorType): string {
  const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:5000';
  return `${base}/api/v1/connectors/${type}/callback`;
}

const STATE_EXPIRES_IN = '10m';

function signState(tenantId: string, type: OAuthConnectorType, userId: string): string {
  return jwt.sign(
    { tenantId, type, userId, nonce: crypto.randomBytes(8).toString('hex') },
    config.jwt.secret,
    { expiresIn: STATE_EXPIRES_IN },
  );
}

/** Verifies signature/expiry/type, then consumes the embedded nonce via
 * OAuthStateNonce's unique index — a duplicate-key error means this exact
 * state was already used once (replay), rejected here rather than letting
 * the callback proceed a second time. A validly-signed-but-already-used
 * state and an invalid/expired one are both rejected the same way from the
 * caller's perspective, by design — no need to distinguish them externally. */
async function verifyState(state: string, expectedType: OAuthConnectorType): Promise<string> {
  const payload = jwt.verify(state, config.jwt.secret) as { tenantId: string; type: string; nonce: string };
  if (payload.type !== expectedType) throw new Error('OAuth state does not match the callback provider');
  try {
    await OAuthStateNonce.create({ nonce: payload.nonce });
  } catch (err: any) {
    if (err?.code === 11000) throw new Error('OAuth state has already been used');
    throw err;
  }
  return payload.tenantId;
}

/** GET /api/v1/connectors/:type/oauth/authorize — authenticated. Returns
 * the URL to redirect the browser to; the frontend does
 * `window.location.href = authorizeUrl` itself rather than this endpoint
 * 302-ing directly, since it's called via an authenticated AJAX request,
 * not a plain navigation. */
export async function initiateOAuth(req: AuthRequest, res: Response): Promise<void> {
  const type = req.params.type;
  if (!isOAuthType(type)) {
    sendError(res, 'OAuth connect is only available for zoho and hubspot — salesforce already uses its own Client Credentials flow', 400);
    return;
  }

  const state = signState(req.tenantId!, type, req.user!.userId);
  const redirectUri = redirectUriFor(type);

  const authorizeUrl = type === 'zoho'
    ? `https://accounts.zoho.in/oauth/v2/auth?${new URLSearchParams({
        // Matches the scope already documented in the manual-flow UI
        // (ConnectorsPage.tsx's own Zoho hint) — must match whatever this
        // Self Client / Server-based Application was actually registered
        // with in the Zoho API Console.
        scope: 'ZohoCRM.modules.ALL',
        client_id: process.env.ZOHO_CLIENT_ID || '',
        response_type: 'code',
        access_type: 'offline',
        redirect_uri: redirectUri,
        prompt: 'consent',
        state,
      }).toString()}`
    : `https://app.hubspot.com/oauth/authorize?${new URLSearchParams({
        client_id: process.env.HUBSPOT_CLIENT_ID || '',
        redirect_uri: redirectUri,
        // Matches the scope already documented in the manual-flow UI
        // (ConnectorsPage.tsx's own HubSpot hint) — must match the scopes
        // actually configured on this HubSpot app.
        scope: 'crm.objects.contacts.read',
        state,
      }).toString()}`;

  sendSuccess(res, { authorizeUrl });
}

/** GET /api/v1/connectors/:type/callback — PUBLIC, hit by the provider's
 * own redirect. Never renders JSON back to the provider's redirect (there's
 * no one there to read it) — always ends in a redirect back to the
 * frontend's Connectors page, with a query param the page reads to show a
 * toast. */
export async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
  const type = req.params.type;
  const connectorsPageUrl = `${config.app.frontendUrl}/connectors`;

  if (!isOAuthType(type)) {
    res.redirect(`${connectorsPageUrl}?oauth=error&reason=unsupported_type`);
    return;
  }

  const { code, state, error: providerError } = req.query as Record<string, string | undefined>;

  if (providerError) {
    res.redirect(`${connectorsPageUrl}?oauth=error&type=${type}&reason=${encodeURIComponent(providerError)}`);
    return;
  }
  if (!code || !state) {
    res.redirect(`${connectorsPageUrl}?oauth=error&type=${type}&reason=missing_code`);
    return;
  }

  let tenantId: string;
  try {
    tenantId = await verifyState(state, type);
  } catch (err) {
    logger.warn('Connector OAuth callback rejected — invalid, expired, or already-used state', { type, error: (err as Error).message });
    res.redirect(`${connectorsPageUrl}?oauth=error&type=${type}&reason=invalid_or_expired_state`);
    return;
  }

  try {
    if (type === 'zoho') {
      const redirectUri = redirectUriFor('zoho');
      const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
        params: {
          code,
          client_id:     process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        },
      });
      if (!tokenRes.data.access_token) {
        throw new Error(tokenRes.data.error || 'Zoho code exchange failed — the authorization code may have expired');
      }
      // Reuses createConnector() as-is rather than duplicating its
      // deactivate-old-connector/encrypt/persist logic — same shape the
      // manual authCode flow already produces once IT exchanges a code
      // (connector.service.ts's createConnector, the `data.type === 'zoho'
      // && authCode` branch), so both entry points converge on one stored
      // connector shape.
      await createConnector(tenantId, {
        name: 'Zoho CRM',
        type: 'zoho',
        config: {
          accessToken:  tokenRes.data.access_token,
          refreshToken: tokenRes.data.refresh_token,
          // reuse existing fields: username = clientId, apiKey = clientSecret
          // — same convention refreshZohoToken() already reads from.
          username: process.env.ZOHO_CLIENT_ID,
          apiKey:   process.env.ZOHO_CLIENT_SECRET,
          baseUrl:  'https://www.zohoapis.in/crm/v3',
        } as any,
      } as any);
    } else {
      const redirectUri = redirectUriFor('hubspot');
      const tokenRes = await axios.post(
        'https://api.hubapi.com/oauth/v1/token',
        new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     process.env.HUBSPOT_CLIENT_ID || '',
          client_secret: process.env.HUBSPOT_CLIENT_SECRET || '',
          redirect_uri:  redirectUri,
          code,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      if (!tokenRes.data.access_token) {
        throw new Error(tokenRes.data.error || tokenRes.data.message || 'HubSpot code exchange failed');
      }
      await createConnector(tenantId, {
        name: 'HubSpot',
        type: 'hubspot',
        config: {
          accessToken:  tokenRes.data.access_token,
          refreshToken: tokenRes.data.refresh_token,
        } as any,
      } as any);
    }

    res.redirect(`${connectorsPageUrl}?oauth=success&type=${type}`);
  } catch (err: any) {
    const reason = err?.response?.data?.error_description || err?.response?.data?.error || err?.message || 'exchange_failed';
    logger.warn('Connector OAuth token exchange failed', { type, tenantId, reason });
    res.redirect(`${connectorsPageUrl}?oauth=error&type=${type}&reason=${encodeURIComponent(reason)}`);
  }
}
