export interface IStaff {
  _id:        string;
  tenantId:   string;
  numId:      number;
  staffId:    string;
  firstName:  string;
  lastName:   string;
  email?:     string;
  phone?:     string;
  teamId?:    string;
  role?:      string;
  status:     'active' | 'inactive' | 'onleave';
  createdBy?: string;
  createdAt:  string;
  updatedAt:  string;
}

export interface StaffListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
  teamId?: string;
}
