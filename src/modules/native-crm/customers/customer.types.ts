export interface ICustomer {
  _id:          string;
  tenantId:     string;
  numId:        number;
  customerId:   string;
  name:         string;
  company?:     string;
  designation?: string;
  email?:       string;
  phone?:       string;
  mobile?:      string;
  website?:     string;
  address?:     string;
  city?:       string;
  state?:      string;
  postcode?:   string;
  country?:    string;
  notes?:      string;
  tags?:       string[];
  status:      'active' | 'inactive';
  createdBy?:  string;
  createdAt:   string;
  updatedAt:   string;
}

export interface CustomerListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
}
