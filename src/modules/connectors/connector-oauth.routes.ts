import { Router } from 'express';
import * as controller from './connector-oauth.controller';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';

/** Mounted at the SAME `/connectors` path as connector.routes.ts, but
 * registered BEFORE it in app.ts — Express tries routers in mount order, so
 * `/connectors/:type/callback` matches here first and never reaches
 * connector.routes.ts's own `router.use(authenticate, requireTenant)`
 * blanket middleware. That's deliberate: the callback is hit by a browser
 * redirect FROM Zoho/HubSpot's own server, which carries no Authorization
 * header — it can't be authenticated the normal way, only via the signed
 * `state` param (see connector-oauth.controller.ts). The authorize-URL
 * endpoint below is a normal authenticated route; it just lives in this
 * file too so both halves of the flow sit together. */
const router = Router();

router.get(
  '/:type/oauth/authorize',
  authenticate,
  requireTenant,
  requirePermission('connector.configure'),
  controller.initiateOAuth,
);

router.get('/:type/callback', controller.handleOAuthCallback);

export default router;
