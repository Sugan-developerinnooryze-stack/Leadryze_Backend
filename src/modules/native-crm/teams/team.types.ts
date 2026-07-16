export interface ITeam {
  _id:          string;
  tenantId:     string;
  numId:        number;
  teamId:       string;
  name:         string;
  description?: string;
  status:       'active' | 'inactive';
  createdBy?:   string;
  createdAt:    string;
  updatedAt:    string;
}

export interface TeamListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
}
