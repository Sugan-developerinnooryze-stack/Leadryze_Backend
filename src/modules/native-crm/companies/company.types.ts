export interface ICompany {
  _id: string;
  tenantId: string;
  name: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  phone?: string;
  website?: string;
  city?: string;
  country?: string;
  companyStatus: 'active' | 'inactive' | 'prospect';
  notes?: string;
  tags?: string[];
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCompanyDTO {
  name: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  phone?: string;
  website?: string;
  city?: string;
  country?: string;
  companyStatus?: string;
  notes?: string;
  tags?: string[];
}

export type UpdateCompanyDTO = Partial<CreateCompanyDTO>;
