export interface ContractListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
  range?:     string;
  dateFrom?:  string;
  dateTo?:    string;
  filters?:   string;
  // Calendar additions — all optional, every existing caller that omits
  // them keeps today's exact behavior.
  /** 'overlap' is Calendar-only: matches any contract whose active span
   * (startDate..endDate) overlaps the requested range at all, instead of a
   * single-field range match — so a contract running Sep 1-Dec 31 still
   * shows while viewing October. */
  dateField?: 'startDate' | 'endDate' | 'overlap' | 'createdAt';
  /** A NativeTeam._id (not the business teamId code) — resolved server-side
   * to the stored business teamId before filtering. */
  teamId?: string;
  staffId?: string;
}
