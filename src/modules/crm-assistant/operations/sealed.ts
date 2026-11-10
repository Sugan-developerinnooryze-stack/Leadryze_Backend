import { decrypt, encrypt } from '../../../utils/crypto';
import type { EntityChoice, FormValue, ReviewBlock } from '../contracts/views';
import type { FormOrigin, PrefillSource, SealedLine, SourceSnapshot, StartSource, StoredRefValue } from '../writes/workflow-types';

/* The sealed payload of an operation (operation.model.ts `sealed`, AES-GCM
 * through utils/crypto.ts): the only place an operation's values live. Two
 * shapes share the store, told apart by source.origin: the existing
 * assistant's proposals ('legacy_propose', Increment 2) and the guided
 * forms' drafts and reviews ('workflow', Increment 6). The payload hash
 * covers only `values` and the version token, so it is computed the same
 * way for both (operation.service.ts hashOfOperation). */

export type VersionToken = { updatedAt?: string; __v?: number };

export interface LegacySealed {
  values: Record<string, unknown>; review: ReviewBlock;
  source: {
    origin: 'legacy_propose';
    /** lead / deal / contact / company: the version token captured at review. */
    versionToken?: VersionToken;
    /** The record's name at review (update and delete). */
    targetLabel?: string;
    /** Set when applied: the record's name for the result card. */
    resultTitle?: string;
  };
}

export interface WorkflowSealed {
  v: 2;
  form: Record<string, FormValue>; origins: Record<string, FormOrigin>;
  masked: string[]; refs: Record<string, StoredRefValue>;
  candidates: Record<string, EntityChoice[]>; hints: Record<string, string>;
  provenance: Record<string, PrefillSource>; notTaken: string[];
  /** Write data last computed; at review exactly what is hashed and written. */
  values: Record<string, unknown>;
  /** Increment 7: a document's lines; absent for a module without lines. */
  lines?: SealedLine[];
  /** Only while staged. */
  review?: ReviewBlock;
  source: {
    origin: 'workflow'; startedBy: StartSource; versionToken?: VersionToken; targetLabel?: string; resultTitle?: string;
    /** Set when applied, only for a create its creator can't see (a work order or customer not assigned to
     * them, L15 and L20): every later answer about it leaves out the link to the record. Absent otherwise. */
    resultUnseen?: true;
    /** The record a create is made from, as start read it. */
    from?: SourceSnapshot;
    /** Set when applied: one more sentence for the result, said again on a repeated confirm. */
    resultNote?: string;
  };
}

export type SealedPayload = LegacySealed | WorkflowSealed;

export function seal(payload: SealedPayload): string {
  return encrypt(JSON.stringify(payload));
}

/** Either shape; throws on a string that was not sealed with this key. */
export function unseal(sealed: string): SealedPayload {
  return JSON.parse(decrypt(sealed)) as SealedPayload;
}

export function isWorkflowSealed(p: SealedPayload): p is WorkflowSealed {
  return p.source.origin === 'workflow';
}
