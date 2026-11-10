import mongoose from 'mongoose';
import { Ticket } from './ticket.model';
import { getNextSequence } from '../shared/counter.model';
import { resolveClientPrefix } from '../../../utils/client-id';
import { indexNativeSearchRecord } from '../shared/search-index';

/* LR-PL-TKT-001: tickets created before ticket numbers existed have no
 * ticketNumber / ticketId / numId and show "-" in the Tickets list. New
 * tickets are numbered by the pre-save hook (ticket.schema.ts), which skips
 * existing documents, so old ones are only numbered by this backfill, run by
 * hand through src/scripts/backfill-ticket-numbers.ts. Already issued numbers
 * are never changed; old tickets take the next free numbers of their tenant,
 * oldest first. */

const NO_NUMBER = { $or: [{ ticketNumber: { $exists: false } }, { ticketNumber: null }, { ticketNumber: '' }] };

export interface UnnumberedTicket {
  /** The ticket's _id. */
  id: string;
  tenantId: string;
  clientId?: string;
  subject?: string;
  createdAt?: Date;
}

export interface DuplicateTicketNumber {
  tenantId: string;
  ticketNumber: string;
  count: number;
}

export interface NumberedTicket {
  /** The ticket's _id. */
  id: string;
  tenantId: string;
  ticketNumber: string;
}

function tenantScope(tenantIds: string[]): Record<string, unknown> {
  if (!tenantIds.length) return {};
  for (const id of tenantIds) {
    if (!mongoose.isValidObjectId(id)) throw new Error(`"${id}" is not a tenant id`);
  }
  return { tenantId: { $in: tenantIds.map((id) => new mongoose.Types.ObjectId(id)) } };
}

/** Tickets without a number, by tenant and then oldest first. An empty
 * tenantIds list means every tenant. Reads only. */
export async function findUnnumberedTickets(tenantIds: string[] = []): Promise<UnnumberedTicket[]> {
  const rows = await Ticket.find({ ...tenantScope(tenantIds), ...NO_NUMBER })
    .sort({ tenantId: 1, createdAt: 1, _id: 1 })
    .select('_id tenantId clientId subject createdAt')
    .lean();
  return (rows as any[]).map((t) => ({
    id: String(t._id), tenantId: String(t.tenantId), clientId: t.clientId || undefined,
    subject: t.subject, createdAt: t.createdAt,
  }));
}

/** Ticket numbers used more than once within a tenant. Reads only. */
export async function findDuplicateTicketNumbers(tenantIds: string[] = []): Promise<DuplicateTicketNumber[]> {
  const rows = await Ticket.aggregate([
    { $match: { ...tenantScope(tenantIds), ticketNumber: { $type: 'string', $ne: '' } } },
    { $group: { _id: { tenantId: '$tenantId', ticketNumber: '$ticketNumber' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { '_id.tenantId': 1, '_id.ticketNumber': 1 } },
  ]);
  return rows.map((r: any) => ({ tenantId: String(r._id.tenantId), ticketNumber: r._id.ticketNumber, count: r.count }));
}

/**
 * Gives each listed ticket the next free number of its tenant, in the order
 * given (findUnnumberedTickets: oldest first), in the same format as a new
 * ticket ({clientId}-TKT-{0000}). The write only applies while the ticket
 * still has no number, so a ticket numbered in the meantime is left as it is
 * (counted as skipped; its reserved number stays unused). updatedAt is not
 * changed. The search index entry is refreshed so the number can be found.
 */
export async function numberTickets(tickets: UnnumberedTicket[]): Promise<{ numbered: NumberedTicket[]; skipped: number }> {
  const numbered: NumberedTicket[] = [];
  let skipped = 0;
  for (const t of tickets) {
    const tid = new mongoose.Types.ObjectId(t.tenantId);
    const numId = await getNextSequence(tid, 'tickets', Ticket as any);
    const prefix = t.clientId || (await resolveClientPrefix(tid));
    const ticketNumber = `${prefix}-TKT-${String(numId).padStart(4, '0')}`;
    const updated: any = await Ticket.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(t.id), ...NO_NUMBER },
      { $set: { numId, clientId: prefix, ticketNumber, ticketId: ticketNumber } },
      { new: true, timestamps: false },
    ).lean();
    if (!updated) { skipped += 1; continue; }
    numbered.push({ id: t.id, tenantId: t.tenantId, ticketNumber });
    indexNativeSearchRecord(t.tenantId, 'native', 'tickets', updated, updated.subject);
  }
  return { numbered, skipped };
}
