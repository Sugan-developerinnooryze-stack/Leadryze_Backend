/** Escapes every regular-expression metacharacter in `text`, so the text
 * matches literally when compiled with `new RegExp(...)` or sent as a Mongo
 * `$regex`: "c++" -> "c\+\+", "(" -> "\(", ".*" -> "\.\*".
 *
 * The one shared copy (tests/crm-assist-regex-guard.test.ts keeps it the only
 * definition). The internal CRM assistant gateway escapes user search text
 * with it before calling a list() service that compiles the text as is; the
 * services themselves are unchanged, since the screens and the widget's
 * /crm-search call them too (D27). */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
