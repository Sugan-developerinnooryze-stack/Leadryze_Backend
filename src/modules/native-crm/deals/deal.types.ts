export interface IDeal {
  _id: string;
  tenantId: string;
  title: string;
  amount?: number;
  currency: string;
  stage: string; // tenant-configurable pipeline stage key (native-crm/pipeline-config)
  closeDate?: Date;
  contactName?: string;
  companyName?: string;
  assignedStaffId?: string;
  notes?: string;
  tags?: string[];
  createdBy?: string;
  importBatchId?: string;
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
  assignedStaffId?: string;
  notes?: string;
  tags?: string[];
  importBatchId?: string;
}

export type UpdateDealDTO = Partial<CreateDealDTO>;
