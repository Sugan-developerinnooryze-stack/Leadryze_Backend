import { z, ZodSchema } from 'zod';
import { Request, Response, NextFunction } from 'express';

interface ValidationSchemas {
  body?:   ZodSchema;
  params?: ZodSchema;
  query?:  ZodSchema;
}

/** `result.error.flatten().fieldErrors` (the `errors` field below, kept
 * as-is for backward compatibility — RecordDrawer.tsx/useAuth.ts/
 * errorMessage.ts all key into it by field NAME) collapses a nested path
 * like `nodes[1].emailBody` down to just its first segment, `nodes` —
 * correct for a flat form schema, useless for an array-of-objects payload
 * like an automation flow's own `nodes`, where every issue on every node
 * lands under the exact same single "nodes" key with the field/index
 * thrown away. `issue.path` itself is the full, precise path Zod already
 * computed — this only reformats it into something readable, and resolves
 * a `nodes[<i>]` path back to that node's own `id` when the raw input is
 * shaped that way, producing the exact `Node "<id>": ...` format the
 * automation builder's frontend already knows how to parse and
 * click-to-focus (see automation-flow.service.ts's own FlowValidationError
 * messages) — a Zod-level rejection now gets the same treatment a
 * service-level one already had, instead of being a dead end. */
function describeZodIssue(issue: z.ZodIssue, rawInput: unknown): string {
  const path = issue.path;
  if (path[0] === 'nodes' && typeof path[1] === 'number') {
    const node = (rawInput as { nodes?: unknown[] } | undefined)?.nodes?.[path[1]];
    const nodeId = node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string'
      ? (node as { id: string }).id : undefined;
    const field = path.slice(2).join('.');
    if (nodeId) return `Node "${nodeId}"${field ? ` (${field})` : ''}: ${issue.message}`;
  }
  const pathStr = path.join('.');
  return pathStr ? `${pathStr}: ${issue.message}` : issue.message;
}

export function validate(schemas: ValidationSchemas | ZodSchema) {
  // Backwards-compatible: if a raw ZodSchema is passed, treat as body-only
  const s: ValidationSchemas =
    schemas instanceof z.ZodType
      ? { body: schemas as ZodSchema }
      : (schemas as ValidationSchemas);

  return (req: Request, res: Response, next: NextFunction): void => {
    for (const key of ['params', 'body', 'query'] as const) {
      if (!s[key]) continue;
      const result = s[key]!.safeParse(req[key]);
      if (!result.success) {
        res.status(400).json({
          success: false,
          message:  'Validation failed',
          errors:   result.error.flatten().fieldErrors,
          // Additive — every existing caller keeps reading `errors` exactly
          // as before. New, more useful shape for a caller that wants it
          // (automation-flow.controller.ts's sendFlowError emits the same
          // field for its own service-level FlowValidationError, so the
          // frontend has one consistent place to look regardless of which
          // layer rejected the request).
          issues: result.error.issues.map((issue) => describeZodIssue(issue, req[key])),
        });
        return;
      }
      req[key] = result.data;
    }
    next();
  };
}
