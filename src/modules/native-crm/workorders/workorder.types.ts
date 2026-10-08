export interface WorkorderListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
  staffId?: string;
  customerId?: string;
  contractId?: string;
  range?:     string;
  dateFrom?:  string;
  dateTo?:    string;
  filters?:   string;
  // Calendar additions — all optional, every existing caller that omits
  // them keeps today's exact behavior.
  /** Which date field the range/dateFrom/dateTo above applies to — defaults
   * to 'createdAt' when omitted or not in this allow-list. The Calendar
   * sends 'scheduledDate' so events place on when the visit is actually
   * scheduled, not when the record was created. */
  dateField?: 'scheduledDate' | 'completedDate' | 'createdAt';
  /** A NativeTeam._id (not the business teamId code) — resolved server-side
   * to the stored business teamId before filtering. */
  teamId?: string;
  /** 'my' resolves to the caller's own linked staffId; 'unassigned' matches
   * staffId/staffIds empty — both composed with row-level data scope, never
   * a blind overwrite (see applyDataScopeToFilter). 'assigned' is a generic
   * "has at least one staff member" condition (distinct from the separate
   * `staffId` param, which picks one SPECIFIC person) — handled locally in
   * listWorkorders since the shared data-scope helper has no "exists"
   * concept, composed as an additional AND clause on top of row-level scope. */
  ownerTab?: 'my' | 'unassigned' | 'assigned';
}
