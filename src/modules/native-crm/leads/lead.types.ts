export interface LeadListOptions {
  page?:       number | string;
  limit?:      number | string;
  search?:     string;
  status?:     string;
  source?:     string;
  rating?:     string;
  priority?:   string;
  leadOwner?:  string;
  isConverted?: string;
  /** Built-in field name, or `customFields.<key>` for a tenant custom field
   * — both sort identically via Mongo's native dot-path sort. */
  sortBy?:     string;
  sortDir?:    'asc' | 'desc';
  /** JSON-encoded IFlowCondition[] (automation-rule.model.ts's own shape,
   * reused rather than inventing a parallel filter format) — each
   * condition's `field` is expected as `customFields.<key>` for a custom
   * field, same convention automation already uses. */
  customFieldFilters?: string;
}
