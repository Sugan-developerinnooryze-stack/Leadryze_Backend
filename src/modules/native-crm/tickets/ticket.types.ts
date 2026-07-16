export interface ITicket {
  _id: string;
  tenantId: string;
  subject: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  ticketStatus: 'open' | 'in_progress' | 'resolved' | 'closed';
  description?: string;
  contactName?: string;
  tags?: string[];
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTicketDTO {
  subject: string;
  priority?: string;
  ticketStatus?: string;
  description?: string;
  contactName?: string;
  tags?: string[];
}

export type UpdateTicketDTO = Partial<CreateTicketDTO>;
