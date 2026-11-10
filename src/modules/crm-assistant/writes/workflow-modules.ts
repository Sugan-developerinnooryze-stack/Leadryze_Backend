/** The 22 modules whose chat writes go through a guided form or a refusal
 * notice (Increment 7, spec B1, M25): the 21 writable modules of the module
 * map (crm-write.module-map.ts) plus quotation. The ten of Increment 6 and the
 * ten simple modules of Increment 7 take create, update and delete; invoices
 * and quotations take create and update, and their deletes are answered with
 * a notice (WriteCap.refused, M22). With workflows not effective every write
 * stays on the legacy crm_propose_write / crm-write path (L6). */
export const WORKFLOW_MODULE_KEYS: ReadonlySet<string> = new Set([
  'workorder', 'task', 'ticket', 'call', 'company', 'contact', 'lead', 'deal', 'customer', 'activity',
  'invoice', 'quotation',
  'category', 'service', 'part', 'product', 'asset', 'vehicle', 'expense', 'site', 'team', 'staff',
]);
