export type RelatedModule = 'contact' | 'company' | 'deal' | 'customer' | 'quotation' | 'workorder' | 'contract';

// The 4-state SLA model ticket-sla-policy.service.ts's deriveSlaStatus()/
// slaStatusMongoFilter() both key off — a resolved/closed ticket always
// reports 'on_track' regardless of whether it breached before closing.
export type SlaStatus = 'on_track' | 'warning' | 'breached' | 'no_sla';

export interface ITicket {
  _id: string;
  tenantId: string;
  subject: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  ticketStatus: 'open' | 'in_progress' | 'resolved' | 'closed';
  description?: string;
  contactName?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;

  // SLA — server-computed only, never client-writable (absent from
  // CreateTicketDTO/UpdateTicketDTO below on purpose).
  resolutionDueAt?: Date | null;
  firstResponseDueAt?: Date | null;
  resolutionWarningAt?: Date | null;
  firstResponseWarningAt?: Date | null;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
  firstRespondedAt?: Date | null;
  // Derived on read via deriveSlaStatus() — not stored on the document itself.
  slaStatus?: SlaStatus;
}

export interface CreateTicketDTO {
  subject: string;
  branchId?: string | null;
  priority?: string;
  ticketStatus?: string;
  description?: string;
  contactName?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
}

export type UpdateTicketDTO = Partial<CreateTicketDTO>;
