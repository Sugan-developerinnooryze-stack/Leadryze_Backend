/* Named relations between modules (plan 3.4, Increment 5): the parent holds
 * the key a child refers to (a customer's customerId on its invoices, a work
 * order's workOrderId on its expenses, a company's _id on its contacts).
 * query/relations.ts reads a relation in two steps, each under its own
 * module's gates and scope: "customers with invoices" (has / has_none) reads
 * the child's keys first; "work orders for ABC Industries" (for) finds the
 * parent first. The keys only ever become extra $and members next to the
 * other module's closed scope object, so a relation never widens what a
 * caller sees.
 *
 * A plan names a relation by the other module's key: has / has_none on a
 * parent target name the child ({ kind: 'has', name: 'invoice' } on
 * customers), for on a child target names the parent ({ kind: 'for', name:
 * 'customer' } on work orders). One relation per parent and child pair. */

export interface RelationDef {
  /** "customer->invoice": unique, for logs and tests. */
  key: string;
  /** The module whose records are referred to. */
  parent: string;
  /** The module whose records refer to the parent. */
  child: string;
  /** Path on the parent holding the referred key: its business number field, or '_id'. */
  parentKey: string;
  /** Path on the child holding the parent's key. */
  childKey: string;
  /** What the keys are: the parent's business number, or its _id. */
  format: 'business' | 'objectId';
  /** objectId format only: how the child stores the parent's _id (site.customerId is an
   * ObjectId; contact.companyId and deal.companyId / contactId hold its hex string). */
  childStores?: 'objectId' | 'string';
  /** The child key is a list (staffIds): a child refers to every parent its list holds. */
  many?: true;
  /** A second path on the child that may hold the parent's key: the single
   * staffId of contracts and work orders saved before staffIds (contracts never
   * sync the two). The Contracts and Work Orders screens filter by either. */
  alsoChildKey?: string;
  /** The child key is typed by hand (an expense's Work Order ID field, stored as
   * typed): it refers to the parent whatever its case. */
  caseInsensitive?: true;
  /** Older children may hold the parent's _id as a string instead of its number
   * (receipts of an invoice: syncInvoicePaidAmount and getInvoiceById match both). */
  alsoIdString?: true;
  /** The child's own list() adds a createdAt floor when it is filtered by this
   * customer (decision D19): its page can list fewer than the answer. */
  listFloor?: true;
}

function business(parent: string, child: string, parentKey: string, childKey: string, extra: Partial<RelationDef> = {}): RelationDef {
  return Object.freeze({ key: `${parent}->${child}`, parent, child, parentKey, childKey, format: 'business' as const, ...extra });
}

function byId(parent: string, child: string, childKey: string, childStores: 'objectId' | 'string'): RelationDef {
  return Object.freeze({ key: `${parent}->${child}`, parent, child, parentKey: '_id', childKey, format: 'objectId' as const, childStores });
}

export const RELATIONS: readonly RelationDef[] = Object.freeze([
  // A customer's business number on its documents (customer.service.ts deleteCustomer counts all five by it).
  business('customer', 'workorder', 'customerId', 'customerId', { listFloor: true }),
  business('customer', 'invoice', 'customerId', 'customerId', { listFloor: true }),
  business('customer', 'quotation', 'customerId', 'customerId', { listFloor: true }),
  business('customer', 'contract', 'customerId', 'customerId', { listFloor: true }),
  business('customer', 'receipt', 'customerId', 'customerId', { listFloor: true }),
  byId('customer', 'site', 'customerId', 'objectId'),
  business('workorder', 'invoice', 'workOrderId', 'workOrderId'),
  business('workorder', 'expense', 'workOrderId', 'workOrderId', { caseInsensitive: true }),
  business('invoice', 'receipt', 'invoiceId', 'invoiceId', { alsoIdString: true }),
  business('quotation', 'workorder', 'quotationId', 'quotationId'),
  business('quotation', 'invoice', 'quotationId', 'quotationId'),
  business('quotation', 'contract', 'quotationId', 'quotationId'),
  business('contract', 'workorder', 'contractId', 'contractId'),
  business('contract', 'invoice', 'contractId', 'contractId'),
  business('staff', 'workorder', 'staffId', 'staffIds', { many: true, alsoChildKey: 'staffId' }),
  business('staff', 'contract', 'staffId', 'staffIds', { many: true, alsoChildKey: 'staffId' }),
  business('team', 'workorder', 'teamId', 'teamId'),
  business('team', 'contract', 'teamId', 'teamId'),
  byId('company', 'contact', 'companyId', 'string'),
  byId('company', 'deal', 'companyId', 'string'),
  byId('contact', 'deal', 'contactId', 'string'),
]);

/** The fields a record is named by when someone types its name ("work orders
 * for ABC Industries"): searched escaped and case-insensitively, each group
 * on its own; a group of several paths ("firstName lastName") is matched
 * against those values joined with a space, as titles join them. Only fields
 * a table may show (never PII). A module with none (invoices) is found by its
 * record number only. Increment 6 adds the records a guided form names: a
 * work order's site, the record a task, ticket or call relates to, and the
 * task, ticket, call, activity or deal a change or delete names. Increment 7
 * adds the catalog and fleet modules a change or delete names, a service's
 * category and a document's catalog lines. */
export const ENTITY_NAME_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  customer: Object.freeze(['name', 'company']),
  workorder: Object.freeze(['title']),
  invoice: Object.freeze([]),
  quotation: Object.freeze(['title']),
  contract: Object.freeze(['title']),
  staff: Object.freeze(['firstName lastName']),
  team: Object.freeze(['name']),
  company: Object.freeze(['name']),
  contact: Object.freeze(['firstName lastName', 'company']),
  lead: Object.freeze(['firstName lastName', 'company']),
  site: Object.freeze(['name']),
  task: Object.freeze(['title']),
  ticket: Object.freeze(['subject']),
  call: Object.freeze(['contactName']),
  activity: Object.freeze(['subject']),
  deal: Object.freeze(['title']),
  category: Object.freeze(['name']),
  service: Object.freeze(['name']),
  part: Object.freeze(['name']),
  product: Object.freeze(['name']),
  asset: Object.freeze(['name']),
  vehicle: Object.freeze(['name']),
  expense: Object.freeze(['title']),
});

/** Where else a name that matched nothing may be: the modules that name
 * people and organisations (counted under each one's own gates). */
export const ENTITY_ELSEWHERE_MODULES: readonly string[] = Object.freeze(['company', 'contact', 'customer', 'lead']);

/** The relations whose parent is `parent` (its record card's related counts). */
export function relationsFrom(parent: string): RelationDef[] {
  return RELATIONS.filter((r) => r.parent === parent);
}

/** The relations whose child is `child` (the parents "for X" can name). */
export function relationsTo(child: string): RelationDef[] {
  return RELATIONS.filter((r) => r.child === child);
}

/** The relation a plan names on `target`: has / has_none name the child of a
 * parent target, for names the parent of a child target. */
export function relationFor(target: string, kind: 'has' | 'has_none' | 'for', name: string): RelationDef | undefined {
  return kind === 'for'
    ? RELATIONS.find((r) => r.child === target && r.parent === name)
    : RELATIONS.find((r) => r.parent === target && r.child === name);
}

/** The parent "for X" means when nobody named one: the customer where the
 * child has a customer relation, else the child's only parent; undefined when
 * there is none or more than one (a deal's company or contact). */
export function defaultParentFor(child: string): string | undefined {
  const parents = relationsTo(child).map((r) => r.parent);
  if (parents.includes('customer')) return 'customer';
  return parents.length === 1 ? parents[0] : undefined;
}
