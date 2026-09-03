import { encrypt, decrypt, isEncrypted } from '../../../utils/crypto';
import { IFlowNode } from './automation-flow.model';

/** Case-insensitive — matched against a webhookHeaders entry's `key`. Kept
 * as a fixed, hand-authored list (mirrors this codebase's existing
 * SENSITIVE_FIELDS precedent in connector.service.ts) rather than a
 * heuristic — a false negative here means a real secret gets stored/logged
 * in plaintext, so the list errs toward including anything plausibly
 * secret-shaped. */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token', 'proxy-authorization',
]);

export function isSensitiveHeaderName(key: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(key.trim().toLowerCase());
}

export const MASKED_HEADER_PLACEHOLDER = '••••••••';

/** Save-path transform (createFlow/updateFlow) — encrypts a sensitive
 * header's plaintext value at rest via the same encrypt() utility already
 * used for PII and, separately, Connector's own OAuth tokens. A value
 * that's already ciphertext is passed through unchanged (never
 * double-encrypted — same guard connector.service.ts's own
 * encryptConnectorConfig already uses). A value that's exactly the masked
 * placeholder means "the user left this field alone while editing" — restore
 * whatever is CURRENTLY stored for that node+header rather than persisting
 * the placeholder text itself as the new "secret" (the same
 * don't-clobber-a-secret-with-its-own-mask problem Connector credential
 * editing already had to solve). `existingNodesById`, when supplied (an
 * update to an existing flow, never a brand-new create — there's nothing to
 * restore from on a create), maps node id -> that node's CURRENTLY STORED
 * (already-encrypted) shape. */
export function encryptWebhookSecrets(nodes: IFlowNode[], existingNodesById?: Map<string, IFlowNode>): IFlowNode[] {
  return nodes.map((node) => {
    if (node.type !== 'action' || node.actionType !== 'webhook_call' || !node.webhookHeaders?.length) return node;
    const existing = existingNodesById?.get(node.id);
    const existingByKey = new Map((existing?.webhookHeaders ?? []).map((h) => [h.key.toLowerCase(), h.value] as const));
    const webhookHeaders = node.webhookHeaders.map((h) => {
      if (!isSensitiveHeaderName(h.key)) return h;
      if (h.value === MASKED_HEADER_PLACEHOLDER) {
        const stored = existingByKey.get(h.key.toLowerCase());
        return stored !== undefined ? { ...h, value: stored } : h;
      }
      if (isEncrypted(h.value)) return h;
      return { ...h, value: encrypt(h.value) };
    });
    return { ...node, webhookHeaders };
  });
}

/** Read-path transform (getFlowById/listFlows, including each flow's
 * `draft`) — a sensitive header's real, encrypted-at-rest value is NEVER
 * returned through any GET/list response; the client only ever sees the
 * placeholder. Re-entering a new value on save replaces it (see
 * encryptWebhookSecrets above); leaving the placeholder means "keep the
 * existing encrypted value." */
export function maskWebhookSecretsForRead(nodes: IFlowNode[]): IFlowNode[] {
  return nodes.map((node) => {
    if (node.type !== 'action' || node.actionType !== 'webhook_call' || !node.webhookHeaders?.length) return node;
    return {
      ...node,
      webhookHeaders: node.webhookHeaders.map((h) =>
        (isSensitiveHeaderName(h.key) ? { ...h, value: MASKED_HEADER_PLACEHOLDER } : h)),
    };
  });
}

/** Execution-path transform — decrypts sensitive header values immediately
 * before the real outbound HTTP call in processOneNode's webhook_call
 * branch. Never used for anything client-facing (dry-run/logs use
 * redactWebhookHeadersForDisplay below instead, which masks rather than
 * decrypts). */
export function decryptWebhookHeadersForExecution(headers: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    out[h.key] = isSensitiveHeaderName(h.key) && isEncrypted(h.value) ? decrypt(h.value) : h.value;
  }
  return out;
}

/** Redaction for anything text-rendered — dry-run preview text, a run's own
 * logged step `result`, any writeLog/audit entry — applied consistently at
 * every such site rather than each one inventing its own masking. A
 * separate concern from encryption-at-rest: this never touches storage,
 * only what gets echoed back into human-readable text. */
export function redactWebhookHeadersForDisplay(
  headers: { key: string; value: string }[],
): { key: string; value: string }[] {
  return headers.map((h) => (isSensitiveHeaderName(h.key) ? { ...h, value: MASKED_HEADER_PLACEHOLDER } : h));
}
