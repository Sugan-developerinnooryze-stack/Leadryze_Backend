/**
 * Phase 2 (Email/WhatsApp execution reliability) — classifySendError, the
 * pure function the automation engine's send_email/send_whatsapp/send_sms
 * retry loop uses to decide whether a failure is safe to auto-retry.
 *
 * The fuller end-to-end behavior this backs (an ambiguous outcome never
 * triggers a second real provider call, the run ends 'partial', the step is
 * logged with status 'unknown') lives inside processOneNode/runLoop, which
 * — consistent with this codebase's existing testing convention (see
 * automation-kill-switch.test.ts, automation-flow-run-stats.test.ts) — isn't
 * unit-tested end-to-end here; this file locks in the one piece of new
 * decision logic in isolation instead. The removal of the old withTimeout
 * race around these three calls (so no competing timer can let a retry
 * start while the original request is still unsettled) is a structural
 * change verifiable by reading the diff — there is no longer any code path
 * that starts a second provider call before the first one's promise has
 * fully settled.
 *
 * Run: npx jest --testPathPatterns=automation-send-error-classification.test.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Same reason automation-flow-run-stats.test.ts needs this — importing from
// automation-flow.service.ts transitively reaches pdf.controller.ts →
// sanitize-html (ESM-only, un-transformable by Jest). This test never
// touches PDF/HTML rendering.
jest.mock('sanitize-html', () => (html: string) => html);

import { classifySendError } from '../src/modules/native-crm/automation-flows/automation-flow.service';

describe('classifySendError', () => {
  it('classifies a definite rejection (Brevo-shaped 400 with a real body) as NOT ambiguous, with the real message', () => {
    const err = { response: { status: 400, data: { code: 'invalid_parameter', message: 'Invalid sender email' } } };
    const result = classifySendError(err);
    expect(result.ambiguous).toBe(false);
    expect(result.message).toBe('Invalid sender email');
  });

  it('classifies a definite rejection (Meta-shaped 401 with a nested error.message) as NOT ambiguous', () => {
    const err = { response: { status: 401, data: { error: { message: 'Error validating access token' } } } };
    const result = classifySendError(err);
    expect(result.ambiguous).toBe(false);
    expect(result.message).toBe('Error validating access token');
  });

  it('classifies a definite rejection (Twilio-shaped 400) as NOT ambiguous', () => {
    const err = { response: { status: 400, data: { code: 21211, message: 'The \'To\' number is not a valid phone number.' } } };
    const result = classifySendError(err);
    expect(result.ambiguous).toBe(false);
    expect(result.message).toContain('not a valid phone number');
  });

  it('classifies a network-level timeout (no response at all — axios ECONNABORTED) as ambiguous', () => {
    const err = { code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' };
    const result = classifySendError(err);
    expect(result.ambiguous).toBe(true);
    expect(result.message).toContain('timeout');
  });

  it('classifies a connection reset (no response at all) as ambiguous', () => {
    const err = { code: 'ECONNRESET', message: 'socket hang up' };
    const result = classifySendError(err);
    expect(result.ambiguous).toBe(true);
  });

  it('classifies a 502 (provider upstream failure — may have already accepted the request) as ambiguous', () => {
    const err = { response: { status: 502, data: {} } };
    const result = classifySendError(err);
    expect(result.ambiguous).toBe(true);
    expect(result.message).toContain('502');
  });

  it('classifies a 503 as ambiguous', () => {
    expect(classifySendError({ response: { status: 503, data: {} } }).ambiguous).toBe(true);
  });

  it('classifies a 504 as ambiguous', () => {
    expect(classifySendError({ response: { status: 504, data: {} } }).ambiguous).toBe(true);
  });

  it('does NOT classify a 429 (rate limit — a definite, real response) as ambiguous', () => {
    // A rate-limit rejection is the provider actively telling us no, not an
    // unknown outcome — it should keep today's existing retry behavior, not
    // be swept into "don't retry."
    const err = { response: { status: 429, data: { message: 'Too many requests' } } };
    expect(classifySendError(err).ambiguous).toBe(false);
  });

  it('falls back to a generic message when the provider body has no recognizable message field', () => {
    const err = { response: { status: 400, data: {} } };
    const result = classifySendError(err);
    expect(result.ambiguous).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('handles a plain Error (no response property at all) as ambiguous, using its own message', () => {
    const result = classifySendError(new Error('Something went wrong'));
    expect(result.ambiguous).toBe(true);
    expect(result.message).toBe('Something went wrong');
  });
});
