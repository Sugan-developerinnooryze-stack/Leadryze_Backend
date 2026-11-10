/* The app routes a chat link may point to: each module's list page and, where
 * the app has one, its detail page. Canonical copy; tests/fixtures/crm-assist/
 * routes.json mirrors it (checked by the contract test), and the frontend repo
 * checks the same JSON against src/App.tsx (scripts/check-chat-routes.mjs).
 * Links are only ever built on the server, from this table. */

export interface RouteTemplate {
  /** List page, e.g. "/native-crm/workorders". In the Custom Modules entry
   * it holds ":slug", the module's slug (customModuleSlug). */
  list: string;
  /** Detail page. ":id" is the record's 24-hex _id; "query_lead" means the
   * Leads page opens the record from "?lead=<id>" (LeadsPage.tsx). */
  detail?: { pattern: string; param: 'path_id' | 'query_lead' };
}

export const ROUTE_TEMPLATES: Readonly<Record<string, RouteTemplate>> = {
  lead: { list: '/native-crm/leads', detail: { pattern: '/native-crm/leads?lead=:id', param: 'query_lead' } },
  deal: { list: '/native-crm/deals' },
  workorder: { list: '/native-crm/workorders', detail: { pattern: '/native-crm/workorders/:id', param: 'path_id' } },
  invoice: { list: '/native-crm/invoices', detail: { pattern: '/native-crm/invoices/:id', param: 'path_id' } },
  quotation: { list: '/native-crm/quotations', detail: { pattern: '/native-crm/quotations/:id', param: 'path_id' } },
  contract: { list: '/native-crm/contracts', detail: { pattern: '/native-crm/contracts/:id', param: 'path_id' } },
  receipt: { list: '/native-crm/receipts' },
  category: { list: '/native-crm/categories' },
  service: { list: '/native-crm/services' },
  part: { list: '/native-crm/parts' },
  product: { list: '/native-crm/products' },
  asset: { list: '/native-crm/assets' },
  vehicle: { list: '/native-crm/vehicles' },
  expense: { list: '/native-crm/expenses' },
  site: { list: '/native-crm/sites' },
  team: { list: '/native-crm/teams', detail: { pattern: '/native-crm/teams/:id', param: 'path_id' } },
  staff: { list: '/native-crm/staffs', detail: { pattern: '/native-crm/staffs/:id', param: 'path_id' } },
  customer: { list: '/native-crm/customers', detail: { pattern: '/native-crm/customers/:id', param: 'path_id' } },
  supervisor: { list: '/native-crm/supervisors' },
  activity: { list: '/native-crm/activities' },
  company: { list: '/crm/companies', detail: { pattern: '/crm/companies/:id', param: 'path_id' } },
  contact: { list: '/crm/contacts', detail: { pattern: '/crm/contacts/:id', param: 'path_id' } },
  task: { list: '/crm/tasks' },
  ticket: { list: '/crm/tickets', detail: { pattern: '/crm/tickets/:id', param: 'path_id' } },
  call: { list: '/crm/calls' },
  meeting: { list: '/crm/meetings' },
  // Custom Module records (module keys "custom:<slug>"): one list page per
  // module (CustomModulePage.tsx). Records open in a drawer on that page, so
  // there is no detail page.
  custom: { list: '/native-crm/custom/:slug' },
};

const OBJECT_ID = /^[a-f0-9]{24}$/i;
/** A Custom Module's slug as the app makes it (custom-module.service.ts
 * toSlug): lower-case letters, digits and hyphens ("site-visits"). */
const SLUG = /^[a-z0-9-]+$/;
const CUSTOM_MODULE_PREFIX = 'custom:';

/** The slug of a Custom Module key ("custom:site-visits" -> "site-visits");
 * undefined for any other key, or a slug the app can't have made. */
export function customModuleSlug(module: string): string | undefined {
  if (!module.startsWith(CUSTOM_MODULE_PREFIX)) return undefined;
  const slug = module.slice(CUSTOM_MODULE_PREFIX.length);
  return SLUG.test(slug) ? slug : undefined;
}

/** A module's own entry (never an inherited Object property). */
function templateOf(module: string): RouteTemplate | undefined {
  return Object.prototype.hasOwnProperty.call(ROUTE_TEMPLATES, module) ? ROUTE_TEMPLATES[module] : undefined;
}

/** True when `path` is `template` with `param` (":id" or ":slug") replaced by
 * a value `value` accepts, and nothing else. */
function matchesTemplate(template: string, param: string, value: RegExp, path: string): boolean {
  const [before, after = ''] = template.split(param);
  if (path.length <= before.length + after.length || !path.startsWith(before) || !path.endsWith(after)) return false;
  return value.test(path.slice(before.length, path.length - after.length));
}

/** True when `path` is exactly a list page (a Custom Module's with a valid
 * slug) or a detail page (with a 24-hex id) from ROUTE_TEMPLATES. */
export function isKnownAppLink(path: string): boolean {
  return Object.values(ROUTE_TEMPLATES).some((t) => (t.list.includes(':slug') ? matchesTemplate(t.list, ':slug', SLUG, path) : path === t.list)
    || (!!t.detail && matchesTemplate(t.detail.pattern, ':id', OBJECT_ID, path)));
}

/** Server-side link builders: the detail page when the app has one, else the
 * list. A Custom Module ("custom:<slug>") links to its own list page. */
export function listLinkFor(module: string): { path: string; exact: boolean } | undefined {
  const slug = customModuleSlug(module);
  if (slug !== undefined) return { path: ROUTE_TEMPLATES.custom.list.replace(':slug', slug), exact: false };
  const t = templateOf(module);
  return t && !t.list.includes(':slug') ? { path: t.list, exact: false } : undefined;
}

export function recordLinkFor(module: string, id: string): { path: string; exact: boolean } | undefined {
  const t = templateOf(module);
  if (t?.detail && OBJECT_ID.test(id)) return { path: t.detail.pattern.replace(':id', id), exact: true };
  return listLinkFor(module);
}
