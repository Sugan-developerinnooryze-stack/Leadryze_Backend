export type RelatedModule = 'contact' | 'company' | 'deal' | 'customer' | 'quotation' | 'workorder' | 'contract';

export interface ICall {
  _id: string;
  tenantId: string;
  contactName: string;
  direction?: 'inbound' | 'outbound';
  duration?: number;
  callStatus: 'planned' | 'completed' | 'missed' | 'cancelled';
  date?: Date;
  notes?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCallDTO {
  contactName: string;
  direction?: string;
  duration?: number;
  callStatus?: string;
  date?: string;
  notes?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
}

export type UpdateCallDTO = Partial<CreateCallDTO>;
