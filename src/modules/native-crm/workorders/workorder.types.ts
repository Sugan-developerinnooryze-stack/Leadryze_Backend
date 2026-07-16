export interface WorkorderListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
  staffId?: string;
  customerId?: string;
  contractId?: string;
}
