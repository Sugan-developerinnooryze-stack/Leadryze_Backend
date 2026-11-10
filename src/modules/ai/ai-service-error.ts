import axios from 'axios';
import { Response } from 'express';
import { sendError } from '../../utils/response';
import { logger } from '../../utils/logger';

/* LR-PL-AI-001: what a staff member is told when the AI service could not
 * answer an assistant turn. The AI service's own failure used to reach the
 * chat as a bare 500 carrying axios's text ("Request failed with status code
 * 429"). Now a busy or unreachable AI service is a 503 with a plain
 * try-again message, a slow one a 504, and anything else a 502; the upstream
 * status and error code go to the log only. */

export const AI_BUSY_MESSAGE = 'The assistant is busy right now — please try again in a minute.';
export const AI_UNAVAILABLE_MESSAGE = 'The assistant is not available right now — please try again in a minute.';
export const AI_SLOW_MESSAGE = 'The assistant is taking longer than expected — it may still finish. Please wait before asking again.';
export const AI_FAILED_MESSAGE = 'The assistant could not answer just now — please try again.';

/** Seconds a busy or unavailable reply asks the client to wait (Retry-After). */
export const AI_RETRY_AFTER_SECONDS = 60;

export interface AiServiceFailure {
  status: number;
  message: string;
  retryAfterSeconds?: number;
  /** For the log: the AI service's (or the hosting layer's) status, if it answered. */
  upstreamStatus?: number;
  /** For the log: axios's error code (ECONNABORTED, ECONNREFUSED, ...). */
  code?: string;
}

/** The reply for an error thrown by the call to the AI service, or null when
 * the error did not come from that call (left to the normal error handler). */
export function aiServiceFailure(err: unknown): AiServiceFailure | null {
  if (!axios.isAxiosError(err)) return null;
  const upstreamStatus = err.response?.status;
  const code = err.code;
  if (upstreamStatus === undefined) {
    // No answer at all: a timeout, or the service could not be reached.
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return { status: 504, message: AI_SLOW_MESSAGE, code };
    return { status: 503, message: AI_UNAVAILABLE_MESSAGE, retryAfterSeconds: AI_RETRY_AFTER_SECONDS, code };
  }
  if (upstreamStatus === 429) {
    return { status: 503, message: AI_BUSY_MESSAGE, retryAfterSeconds: AI_RETRY_AFTER_SECONDS, upstreamStatus, code };
  }
  if (upstreamStatus === 502 || upstreamStatus === 503) {
    return { status: 503, message: AI_UNAVAILABLE_MESSAGE, retryAfterSeconds: AI_RETRY_AFTER_SECONDS, upstreamStatus, code };
  }
  if (upstreamStatus === 504) return { status: 504, message: AI_SLOW_MESSAGE, upstreamStatus, code };
  return { status: 502, message: AI_FAILED_MESSAGE, upstreamStatus, code };
}

/** Logs the failure (route, tenant, upstream status and code; never the
 * message text) and sends the clear reply. */
export function sendAiServiceFailure(res: Response, failure: AiServiceFailure, route: string, tenantId?: string): void {
  logger.warn('AI service call failed', {
    route, tenantId, status: failure.status, upstreamStatus: failure.upstreamStatus, code: failure.code,
  });
  if (failure.retryAfterSeconds) res.setHeader('Retry-After', String(failure.retryAfterSeconds));
  sendError(res, failure.message, failure.status);
}
