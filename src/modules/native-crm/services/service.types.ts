export interface IService {
  _id:          string;
  tenantId:     string;
  numId:        number;
  serviceId:    string;
  name:         string;
  description?: string;
  categoryId?:  string;
  price:        number;
  unit?:        string;
  duration?:    number;
  status:       'active' | 'inactive';
  createdBy?:   string;
  createdAt:    string;
  updatedAt:    string;
}

export interface ServiceListOptions {
  page?:       number | string;
  limit?:      number | string;
  search?:     string;
  status?:     string;
  categoryId?: string;
}
