/**
 * Phase 5 — small wiring/copy regressions that are cheap and reliable to
 * guard via source inspection, without a DB/HTTP server/new test
 * infrastructure. Two unrelated things share this file because both are
 * "read a source file, assert a substring/line-order" checks of the same
 * shape:
 *
 * 1. The /runs/stats route-ordering fix (Express matches route
 *    registration in order — /runs/stats must be registered before
 *    /runs/:id or :id greedily swallows the literal "stats" segment).
 * 2. Frontend terminology/copy this phase specifically fixed (global
 *    "PAUSED" vs a single flow's own "Disabled", and the scheduled-trigger
 *    skip-not-defer caveat). The frontend has no test runner of its own
 *    (no vitest/jest in frontend/package.json) and this project's Phase 5
 *    instructions were explicit not to add one — reading the .tsx source
 *    from here, via backend's already-working Jest, is the only DB-free,
 *    no-new-infrastructure way to keep any regression coverage on this
 *    copy at all.
 *
 * Run: npx jest --testPathPatterns=automation-dashboard-wiring.test.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import fs from 'fs';
import path from 'path';

describe('automation-flow.routes.ts — /runs/stats registered before /runs/:id', () => {
  const routesSrc = fs.readFileSync(
    path.join(__dirname, '../src/modules/native-crm/automation-flows/automation-flow.routes.ts'),
    'utf8',
  );
  const lines = routesSrc.split('\n');
  const statsLineIdx = lines.findIndex((l) => l.includes("router.get('/runs/stats'"));
  const idLineIdx = lines.findIndex((l) => l.includes("router.get('/runs/:id'"));

  it('both routes are present', () => {
    expect(statsLineIdx).toBeGreaterThan(-1);
    expect(idLineIdx).toBeGreaterThan(-1);
  });

  it('/runs/stats is registered before /runs/:id', () => {
    expect(statsLineIdx).toBeLessThan(idLineIdx);
  });
});

describe('AutomationFlowsPage.tsx — global pause vs per-flow disabled copy', () => {
  const pageSrc = fs.readFileSync(
    path.join(__dirname, '../../frontend/src/pages/native-crm/settings/AutomationFlowsPage.tsx'),
    'utf8',
  );

  it('the tenant-wide summary card reads "Disabled Flows", not "Paused Flows" (would collide with the global switch\'s own "paused" language)', () => {
    expect(pageSrc).toContain('Disabled Flows');
    expect(pageSrc).not.toContain('Paused Flows');
  });

  it('a per-flow card labels its own state "Enabled"/"Disabled", never "Paused"', () => {
    expect(pageSrc).toMatch(/'Enabled'\s*:\s*'Disabled'/);
  });

  it('the global banner exists and uses ALL-CAPS PAUSED language distinct from per-flow copy', () => {
    expect(pageSrc).toContain('ALL AUTOMATIONS PAUSED');
  });

  it('the scheduled-trigger skip-not-defer behavior is stated in reachable UI copy, not only in code comments', () => {
    expect(pageSrc).toContain('skipped, not queued');
  });

  it('a real "Resume All Automations" action is reachable from the paused banner itself', () => {
    expect(pageSrc).toContain('Resume All Automations');
  });
});
