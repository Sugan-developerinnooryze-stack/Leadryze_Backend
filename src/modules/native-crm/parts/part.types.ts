export interface IPart {
  _id:          string;
  tenantId:     string;
  numId:        number;
  partId:       string;
  name:         string;
  partNumber?:  string;
  description?: string;
  price:        number;
  unit?:        string;
  quantity:     number;
  status:       'active' | 'inactive';
  createdBy?:   string;
  createdAt:    string;
  updatedAt:    string;
}

export interface PartListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
}
