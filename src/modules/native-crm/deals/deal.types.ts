export interface IDeal {
  _id: string;
  tenantId: string;
  branchId?: string | null;
  title: string;
  amount?: number;
  currency: string;
  stage: string; // tenant-configurable pipeline stage key (native-crm/pipeline-config)
  closeDate?: Date;
  contactName?: string;
  companyName?: string;
  assignedStaffId?: string;
  contactId?: string;
  companyId?: string;
  notes?: string;
  tags?: string[];
  createdBy?: string;
  importBatchId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDealDTO {
  branchId?: string | null;
  title: string;
  amount?: number;
  currency?: string;
  stage?: string;
  closeDate?: string;
  contactName?: string;
  companyName?: string;
  assignedStaffId?: string;
  contactId?: string;
  companyId?: string;
  notes?: string;
  tags?: string[];
  importBatchId?: string;
}

export type UpdateDealDTO = Partial<CreateDealDTO>;
