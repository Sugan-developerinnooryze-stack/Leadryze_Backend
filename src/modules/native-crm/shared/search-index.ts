import { indexCRMRecords, removeMeiliRecords, buildMeiliId } from '../../../services/meilisearch.service';

/** The three namespaces this file's callers use — distinct from every
 * connector `channel` value (always a real connector type) and from
 * `Customer.channel`'s own enum (which never includes 'native'), so these
 * are collision-free additions to the existing crm_records Meili index,
 * not a new index. See tender-squishing-nebula.md's Decision #3 table for
 * the full channel/module -> frontend-route mapping. */
export type NativeSearchChannel = 'native' | 'native-crm' | 'custom-module';

/** Mirror one native-crm / field-service / custom-module record into the
 * SAME Meilisearch index connector syncs already use — reuses
 * indexCRMRecords() as-is (already generic over any `data` bag, already
 * flattens nested objects, already fire-and-forget/never-throws internally)
 * rather than a parallel implementation. Call this AFTER the record is
 * already saved to MongoDB, mirroring upsertCRMRecords()'s own ordering in
 * crm-record.service.ts. Strips _id/__v/tenantId before spreading the rest
 * as `data` — this is what makes a record's own `customFields: Mixed`
 * property (and everything else on the document) searchable for free,
 * with no separate custom-fields indexing step. */
export function indexNativeSearchRecord(
  tenantId: string,
  channel: NativeSearchChannel,
  module: string,
  // `any` deliberately, not a stricter shape — this is called with
  // .toObject()/.lean() results from ~25 different Mongoose models, each
  // with its own concrete, non-index-signature interface (IContractDoc,
  // ICustomerDoc, etc.) that TypeScript won't structurally widen to
  // Record<string, unknown> on its own. Matches this codebase's own
  // existing convention of `data: any` in the exact same service files.
  doc: any,
  displayName: string,
): void {
  const { _id, __v, tenantId: _t, ...rest } = doc as Record<string, unknown>;
  void indexCRMRecords([{
    tenantId, channel, module,
    externalId: String(_id),
    displayName: displayName || 'Untitled',
    data: rest,
  }]);
}

/** Removes one record's mirrored copy — same buildMeiliId() convention
 * indexCRMRecords()/removeMeiliRecords() already use internally, so a
 * removal always targets the exact document a prior indexNativeSearchRecord()
 * call created. */
export function removeNativeSearchRecord(
  tenantId: string,
  channel: NativeSearchChannel,
  module: string,
  id: string,
): void {
  void removeMeiliRecords([buildMeiliId(tenantId, channel, module, id)]);
}
