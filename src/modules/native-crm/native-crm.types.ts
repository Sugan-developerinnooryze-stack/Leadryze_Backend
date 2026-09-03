export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

export interface ListOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  // Filter to records linked to one specific Field Service/Contact/Company
  // record (mirrors the relatedModule/relatedId trio on Task/Ticket/Call/
  // Meeting) — e.g. "show only calls for this customer".
  relatedModule?: string;
  relatedId?: string;
  // Filter to records whose own natural date field is in the future —
  // interpreted per-module by the individual list service (Calls: date,
  // Meetings: startDate, Tasks: dueDate). Not supported by every module.
  upcoming?: boolean;
  // Built-in field name, or `customFields.<key>` for a tenant custom field —
  // both sort identically via Mongo's native dot-path sort. JSON-encoded
  // IFlowCondition[] for customFieldFilters, same shape/convention
  // automation-rule.model.ts already uses. Not every module's list service
  // reads these yet — added here so the shared type doesn't need touching
  // again as more modules pick them up.
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  customFieldFilters?: string;
  // Ticket-only: 'on_track'|'warning'|'breached'|'no_sla', see
  // ticket-sla-policy.service.ts's slaStatusMongoFilter(). Not supported by
  // any other module's list service.
  slaStatus?: string;
}
