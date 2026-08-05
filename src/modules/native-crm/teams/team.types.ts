export interface ITeam {
  _id:          string;
  tenantId:     string;
  numId:        number;
  teamId:       string;
  name:         string;
  description?: string;
  status:       'active' | 'inactive';
  showInWidget?: boolean;
  managerUserId?: string | null;
  serviceIds?:  string[];
  createdBy?:   string;
  createdAt:    string;
  updatedAt:    string;
}

export interface TeamListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
  showInWidget?: boolean;
  /** Row-level scoping only — never client-supplied, set internally from
   * req.dataScope by the controller when the requester is a MANAGER. */
  teamIdIn?: string[];
}
