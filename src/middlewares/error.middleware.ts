import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';
import { sendError } from '../utils/response';

export function notFound(req: Request, res: Response): void {
  sendError(res, `Route ${req.originalUrl} not found`, 404);
}

export function errorHandler(
  err: Error & { statusCode?: number; code?: number; name?: string },
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
  });

  if (err instanceof ZodError) { sendError(res, 'Validation error', 422, err.errors); return; }
  if (err.name === 'ValidationError') { sendError(res, err.message, 422); return; }
  if (err.name === 'CastError') { sendError(res, 'Invalid ID format', 400); return; }
  if (err.code === 11000) { sendError(res, 'Duplicate entry — resource already exists', 409); return; }

  const statusCode = err.statusCode || 500;
  const message =
    statusCode === 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message;
  sendError(res, message, statusCode);
}
