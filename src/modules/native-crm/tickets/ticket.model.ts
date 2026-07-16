import mongoose from 'mongoose';
import { ticketSchema } from './ticket.schema';

export const Ticket = mongoose.model('CrmTicket', ticketSchema, 'crm_tickets');
