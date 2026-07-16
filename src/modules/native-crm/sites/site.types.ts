export interface ISite {
  _id:           string;
  tenantId:      string;
  numId:         number;
  siteId:        string;
  name:          string;
  address:       string;
  city?:         string;
  state?:        string;
  postcode?:     string;
  country?:      string;
  customerId?:   string;
  contactPerson?: string;
  phone?:        string;
  notes?:        string;
  status:        'active' | 'inactive';
  createdBy?:    string;
  createdAt:     string;
  updatedAt:     string;
}

export interface SiteListOptions {
  page?:       number | string;
  limit?:      number | string;
  search?:     string;
  status?:     string;
  customerId?: string;
}
