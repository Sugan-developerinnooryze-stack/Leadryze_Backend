import type { Cond } from '../contracts/plan';
import type { ConnectorConcept, ConnectorType } from './connectors';

/* Concepts: words that mean records in more than one place. Counting a
 * concept counts each source on its own, under that source's own gates, and
 * never adds the numbers together (decision D1).
 *
 * "customer" (D1): Field Service customers; Native CRM contacts whose status
 * is "customer"; and the connector Accounts and Companies (Zoho Accounts,
 * Salesforce Accounts, HubSpot Companies), counted only for vendors with an
 * active connector. Customer lists stay the Field Service module list. Engage
 * customers and connector Leads and Contacts (the legacy Customer collection)
 * are left out: none of them has a data scope or PII masking (D1, D11). */

export type ConceptKey = 'customer';

export type ConceptSource =
  | { kind: 'module'; module: string; where?: Cond[]; label: string }
  | { kind: 'connector'; type: ConnectorType; concept: ConnectorConcept };

export const CONCEPTS: Readonly<Record<ConceptKey, { singular: string; plural: string; sources: readonly ConceptSource[] }>> = Object.freeze({
  customer: Object.freeze({
    singular: 'Customer',
    plural: 'Customers',
    sources: Object.freeze([
      Object.freeze({ kind: 'module' as const, module: 'customer', label: 'Field Service customers' }),
      Object.freeze({
        kind: 'module' as const,
        module: 'contact',
        where: Object.freeze([Object.freeze({ f: 'status', op: 'eq' as const, v: 'customer' })]) as Cond[],
        label: 'Contacts marked as customers',
      }),
      Object.freeze({ kind: 'connector' as const, type: 'zoho' as const, concept: 'customer' as const }),
      Object.freeze({ kind: 'connector' as const, type: 'salesforce' as const, concept: 'customer' as const }),
      Object.freeze({ kind: 'connector' as const, type: 'hubspot' as const, concept: 'customer' as const }),
    ] as ConceptSource[]),
  }),
});
