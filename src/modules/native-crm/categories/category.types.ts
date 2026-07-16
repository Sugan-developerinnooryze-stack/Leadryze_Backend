export interface ICategory {
  _id:         string;
  tenantId:    string;
  numId:       number;
  categoryId:  string;
  name:        string;
  description?: string;
  color?:      string;
  icon?:       string;
  status:      'active' | 'inactive';
  createdBy?:  string;
  createdAt:   string;
  updatedAt:   string;
}

export interface CategoryListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
}
