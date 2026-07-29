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
}
