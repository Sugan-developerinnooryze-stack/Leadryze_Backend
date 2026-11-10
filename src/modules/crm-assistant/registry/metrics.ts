/* Named money totals (plan 3.4 and 4.6, decision D5, Increment 5): what the
 * assistant means by "purchase amount", "outstanding" and "payments
 * received". Each is one sum over one module's records, run by
 * query/metrics.ts under that module's gates and scope. Field Service
 * documents carry no currency of their own, so every total is per company
 * currency (each record's branch FS settings currency), and amounts of
 * different currencies are never added together. The basis sentence goes
 * under every answer, so the definition is never hidden. The list behind a
 * total (its drill) carries the same `include` as plan conditions
 * (query/metrics.ts), so it lists exactly the records the total adds up.
 * Increment 8 adds the deal totals (pipeline value, won value), each in the
 * deal's own currency, and totals by date (bucketField). */

export type MetricKey = 'purchase_amount' | 'outstanding' | 'payments_received' | 'pipeline_value' | 'won_value';

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Lower-case words the grammar may match (no word maps to two metrics). */
  synonyms: readonly string[];
  /** The module whose records are summed (a plan's target). */
  module: string;
  /** What each record adds: a stored amount, or its balance due (total minus
   * paid, never below 0, as the invoice's balanceDue reads). */
  value: { kind: 'field'; field: string } | { kind: 'balance'; total: string; paid: string };
  /** Which records count, besides the plan's own conditions:
   *  not_cancelled  the stage is not in the cancelled set (loadStageInfo: final
   *                 stages tagged cancelled or lost, or keyed cancel, lost,
   *                 reject or disqualif);
   *  unpaid         also not paid: the paid flag isn't true and the stage isn't
   *                 a final stage tagged with the paid outcome;
   *  equals         a field holds one value (receipts: status completed);
   *  open           the stage is not final: not in loadStageInfo's terminal
   *                 set, inactive stages included;
   *  outcome        the stage is tagged with this outcome in the tenant's
   *                 pipeline (peekStages, inactive stages included). */
  include:
    | { kind: 'not_cancelled' }
    | { kind: 'unpaid'; paidFlag: string; paidOutcome: string }
    | { kind: 'equals'; field: string; value: string }
    | { kind: 'open' }
    | { kind: 'outcome'; outcome: string };
  /** Absent: each record's company currency (Field Service documents carry
   * none). A field: the record's own, trimmed and upper-cased; blank counts in
   * its company's currency. */
  currency?: { field: string };
  /** The date a window such as "this month" applies to, when it has one. */
  dateField?: string;
  /** The date a total may be broken down by per day, week, month, quarter or
   * year. Absent: never by date. */
  bucketField?: string;
  /** Fields a total can be broken down by (one row per value and currency). */
  groupBy: readonly string[];
  /** The definition, shown with every answer. */
  basis: string;
}

export const METRICS: readonly MetricDef[] = Object.freeze([
  Object.freeze({
    key: 'purchase_amount' as const,
    label: 'Purchase amount',
    synonyms: Object.freeze([
      'purchase amount', 'purchase amounts', 'purchase value', 'purchases', 'billed amount', 'amount billed', 'total billed',
      'invoiced amount', 'amount invoiced', 'total invoiced',
    ]),
    module: 'invoice',
    value: Object.freeze({ kind: 'field' as const, field: 'servicesAmountWithTax' }),
    include: Object.freeze({ kind: 'not_cancelled' as const }),
    groupBy: Object.freeze(['customerId']),
    basis: 'Purchase amount is the total with tax of every invoice, leaving out cancelled invoices (a final stage tagged '
      + 'cancelled or lost, or named cancelled, lost, rejected or disqualified), in each company\'s currency.',
  }),
  Object.freeze({
    key: 'outstanding' as const,
    label: 'Outstanding',
    synonyms: Object.freeze([
      'outstanding', 'outstanding amount', 'amount outstanding', 'outstanding balance', 'unpaid amount', 'amount unpaid',
      'receivables', 'dues',
    ]),
    module: 'invoice',
    value: Object.freeze({ kind: 'balance' as const, total: 'servicesAmountWithTax', paid: 'paidAmount' }),
    include: Object.freeze({ kind: 'unpaid' as const, paidFlag: 'paid', paidOutcome: 'paid' }),
    bucketField: 'dueDate',
    groupBy: Object.freeze(['customerId']),
    basis: 'Outstanding is the balance due of every invoice that is not paid or cancelled: its total with tax minus what '
      + 'has been paid on it, in each company\'s currency.',
  }),
  Object.freeze({
    key: 'payments_received' as const,
    label: 'Payments received',
    synonyms: Object.freeze([
      'payments received', 'payment received', 'payments collected', 'amount received', 'amount collected',
      'collections', 'money received',
    ]),
    module: 'receipt',
    value: Object.freeze({ kind: 'field' as const, field: 'amount' }),
    include: Object.freeze({ kind: 'equals' as const, field: 'status', value: 'completed' }),
    dateField: 'paymentDate',
    bucketField: 'paymentDate',
    groupBy: Object.freeze(['customerId']),
    basis: 'Payments received adds up completed receipts only, by payment date, in each company\'s currency; pending and '
      + 'refunded receipts are left out. An invoice\'s paid amount also counts pending receipts, so the two can differ.',
  }),
  Object.freeze({
    key: 'pipeline_value' as const,
    label: 'Pipeline value',
    synonyms: Object.freeze([
      'pipeline value', 'deal pipeline value', 'open pipeline value', 'value of the pipeline', 'pipeline amount',
      'value of open deals', 'open deal value', 'open deals value',
    ]),
    module: 'deal',
    value: Object.freeze({ kind: 'field' as const, field: 'amount' }),
    include: Object.freeze({ kind: 'open' as const }),
    currency: Object.freeze({ field: 'currency' }),
    groupBy: Object.freeze(['stage']),
    basis: 'Pipeline value adds up the amount of every open deal (in a stage that is not final), in each deal\'s own '
      + 'currency; a deal with no currency counts in its company\'s currency. Different currencies are never added together.',
  }),
  Object.freeze({
    key: 'won_value' as const,
    label: 'Won value',
    synonyms: Object.freeze([
      'won value', 'won deal value', 'won deals value', 'value of won deals', 'won amount', 'amount won', 'value won',
    ]),
    module: 'deal',
    value: Object.freeze({ kind: 'field' as const, field: 'amount' }),
    include: Object.freeze({ kind: 'outcome' as const, outcome: 'won' }),
    currency: Object.freeze({ field: 'currency' }),
    dateField: 'closeDate',
    bucketField: 'closeDate',
    groupBy: Object.freeze([]),
    basis: 'Won value adds up the amount of every deal in a stage tagged won, by close date, in each deal\'s own currency; '
      + 'a deal with no currency counts in its company\'s currency. A won deal with no close date is in no date window. '
      + 'Different currencies are never added together.',
  }),
]);

/** The named metric `key` of `module` (a plan's target), if it has one. */
export function metricFor(module: string, key: string): MetricDef | undefined {
  return METRICS.find((m) => m.module === module && m.key === key);
}

/** The named metrics of `module` (the planner catalog's metric names). */
export function metricsFor(module: string): MetricDef[] {
  return METRICS.filter((m) => m.module === module);
}

/** A named metric by its key, whatever its module. */
export function metricByKey(key: string): MetricDef | undefined {
  return METRICS.find((m) => m.key === key);
}
