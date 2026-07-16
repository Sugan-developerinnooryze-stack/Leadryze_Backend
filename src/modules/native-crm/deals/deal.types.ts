export interface IDeal {
  _id: string;
  tenantId: string;
  title: string;
  amount?: number;
  currency: string;
  stage: 'prospect' | 'qualified' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';
  closeDate?: Date;
  contactName?: string;
  companyName?: string;
  notes?: string;
  tags?: string[];
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDealDTO {
  title: string;
  amount?: number;
  currency?: string;
  stage?: string;
  closeDate?: string;
  contactName?: string;
  companyName?: string;
  notes?: string;
  tags?: string[];
}

export type UpdateDealDTO = Partial<CreateDealDTO>;
