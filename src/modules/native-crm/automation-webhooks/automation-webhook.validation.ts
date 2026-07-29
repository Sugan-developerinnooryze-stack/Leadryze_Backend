import { z } from 'zod';

/** webhookToken is always crypto.randomBytes(24).toString('hex') — 48 lowercase
 * hex characters. Rejecting anything else here means a malformed candidate
 * never reaches the database at all (400, from this schema) — only a
 * syntactically-plausible-but-wrong token reaches the uniform 202 path in
 * the controller, which doesn't leak anything beyond the URL's general
 * shape (already known to whoever holds it). */
export const webhookTriggerParamsSchema = z.object({
  token: z.string().trim().regex(/^[a-f0-9]{48}$/),
});
