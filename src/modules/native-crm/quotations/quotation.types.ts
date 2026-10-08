export interface QuotationListOptions {
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
  dateField?: 'validUntil' | 'createdAt';
  /** A NativeTeam._id (not the business teamId code) — resolved server-side
   * to the stored business teamId before filtering. */
  teamId?: string;
  staffId?: string;
}
