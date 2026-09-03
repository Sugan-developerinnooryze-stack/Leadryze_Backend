/**
 * Phase 5 — Admin-only `automation.manage_settings` permission, DB-free
 * regression coverage.
 *
 * requirePermission()'s SUPER_ADMIN/TENANT_ADMIN bypass and its "no roleId"
 * 403 both return before ever touching the database (hasPermission() — the
 * one DB-dependent branch, for a Manager/Agent WITH a real roleId — is
 * intentionally not exercised here; that needs a live Mongo connection and
 * is documented as integration-test backlog in the Phase 5 report). This is
 * the real, exported middleware, not a re-implementation — a change to its
 * bypass logic would break this test.
 *
 * Run: npx jest --testPathPatterns=automation-settings-rbac.test.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-32-chars-long!!';

import fs from 'fs';
import path from 'path';
import { requirePermission } from '../src/middlewares/auth.middleware';

function makeRes() {
  const res: any = {
    statusCode: undefined as number | undefined,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  };
  return res;
}

describe('requirePermission("automation.manage_settings") — Admin-only kill-switch gate', () => {
  it('SUPER_ADMIN bypasses regardless of the permission key (never touches the DB)', async () => {
    const middleware = requirePermission('automation.manage_settings');
    const req: any = { user: { role: 'SUPER_ADMIN', roleId: undefined, tenantId: 't1' } };
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it('TENANT_ADMIN bypasses regardless of the permission key (never touches the DB)', async () => {
    const middleware = requirePermission('automation.manage_settings');
    const req: any = { user: { role: 'TENANT_ADMIN', roleId: undefined, tenantId: 't1' } };
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('MANAGER with no roleId is rejected 403 immediately (never reaches the DB-dependent check)', async () => {
    const middleware = requirePermission('automation.manage_settings');
    const req: any = { user: { role: 'MANAGER', roleId: undefined, tenantId: 't1' } };
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('AGENT with no roleId is rejected 403 immediately', async () => {
    const middleware = requirePermission('automation.manage_settings');
    const req: any = { user: { role: 'AGENT', roleId: undefined, tenantId: 't1' } };
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('an unauthenticated request (no req.user at all) is rejected 403, not a crash', async () => {
    const middleware = requirePermission('automation.manage_settings');
    const req: any = {};
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('automation-settings.routes.ts — permission keys wired correctly (source inspection)', () => {
  // A DB-mocked call-through test can't distinguish "wired to the wrong but
  // still-valid permission key" from correct — the closure captures the key
  // string, which isn't observable from outside without triggering the
  // DB-dependent hasPermission() branch. Reading the route file's own source
  // is the simplest reliable way to lock in "PATCH requires the Admin-only
  // manage_settings key, GET only requires the already-Manager-granted view
  // key" without new infrastructure.
  const routesSrc = fs.readFileSync(
    path.join(__dirname, '../src/modules/native-crm/automation-settings/automation-settings.routes.ts'),
    'utf8',
  );

  it('PATCH / is gated by automation.manage_settings', () => {
    const patchLine = routesSrc.split('\n').find((l) => l.includes("router.patch('/'"));
    expect(patchLine).toBeDefined();
    expect(patchLine).toContain('automation.manage_settings');
  });

  it('GET / is gated by automation.view, not the Admin-only manage_settings key', () => {
    const getLine = routesSrc.split('\n').find((l) => l.includes("router.get('/'"));
    expect(getLine).toBeDefined();
    expect(getLine).toContain('automation.view');
    expect(getLine).not.toContain('automation.manage_settings');
  });
});
