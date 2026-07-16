import { z, ZodSchema } from 'zod';
import { Request, Response, NextFunction } from 'express';

interface ValidationSchemas {
  body?:   ZodSchema;
  params?: ZodSchema;
  query?:  ZodSchema;
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
        });
        return;
      }
      req[key] = result.data;
    }
    next();
  };
}
