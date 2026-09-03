/** Shared list-query helpers for tenant custom fields (`customFields: Mixed`
 * on Lead/Deal/etc) — search and filter, so every module's listX() wires
 * this up the same way instead of reinventing it per module. */

/** Matches `search` against ANY value currently stored under a record's
 * `customFields` object, without needing to know the tenant's custom field
 * KEYS ahead of time (no extra DB round-trip to fetch field definitions —
 * `$objectToArray` + `$filter` walks whatever keys actually exist on each
 * document). Meant to be OR'd alongside a module's existing built-in-field
 * search clauses, not used standalone. */
export function customFieldsSearchExpr(search: string): Record<string, any> {
  return {
    $expr: {
      $gt: [
        {
          $size: {
            $filter: {
              input: { $objectToArray: { $ifNull: ['$customFields', {}] } },
              as: 'cf',
              cond: {
                $regexMatch: { input: { $toString: '$$cf.v' }, regex: search, options: 'i' },
              },
            },
          },
        },
        0,
      ],
    },
  };
}
