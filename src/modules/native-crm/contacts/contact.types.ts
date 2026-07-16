export interface IContact {
  _id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  status: 'lead' | 'contact' | 'customer';
  source?: 'website' | 'referral' | 'social' | 'email' | 'cold' | 'other';
  notes?: string;
  tags?: string[];
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContactDTO {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  status?: string;
  source?: string;
  notes?: string;
  tags?: string[];
}

export type UpdateContactDTO = Partial<CreateContactDTO>;
