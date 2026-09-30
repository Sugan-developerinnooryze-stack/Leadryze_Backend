/** The canonical entityModule → {permission, flag} mapping — mirrors
 * Sidebar.tsx's NATIVE_MODULE_PERM/FIELD_SERVICE_MODULE_PERM/*_FLAG maps on
 * the frontend, backend-side. Built for the tenant-wide Recent Activity feed
 * (timeline.routes.ts's /recent route), the one endpoint that legitimately
 * spans many permission domains at once instead of being gated by a single
 * fixed requirePermission() call — every other route just uses
 * requirePermission/requireModuleEnabled directly and has no need for this.
 *
 * Keys are the literal entityModule strings actually passed to logTimeline()
 * across the codebase (confirmed by grep, not assumed) — note these are NOT
 * uniformly plural/singular (e.g. 'leads' vs 'deal'/'task'/'workorder') since
 * that's simply what each call site already writes; this map has to match
 * reality, not a tidier convention. Only modules that actually call
 * logTimeline() anywhere are listed — Tickets/Calls/Meetings/Contacts/
 * Companies currently log no timeline entries at all, so they never appear
 * in the feed (not a bug in this feature, just what data exists today). */
export const ENTITY_MODULE_ACCESS: Record<string, { permission: string; flag: string }> = {
  leads:      { permission: 'native_crm.leads.view',   flag: 'fs_leads' },
  deal:       { permission: 'native_crm.deals.view',   flag: 'native_deals' },
  task:       { permission: 'native_crm.tasks.view',   flag: 'native_tasks' },
  workorder:  { permission: 'fs.workorders.view',      flag: 'fs_workorders' },
  customer:   { permission: 'fs.customers.view',       flag: 'fs_customers' },
  invoice:    { permission: 'fs.invoices.view',        flag: 'fs_invoices' },
  contract:   { permission: 'fs.contracts.view',        flag: 'fs_contracts' },
  quotation:  { permission: 'fs.quotations.view',       flag: 'fs_quotations' },
};
