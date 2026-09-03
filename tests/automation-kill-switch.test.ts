/**
 * Phase 5 — Emergency automation kill switch, DB-free regression coverage.
 *
 * `isAutomationPausedForTenant` is the pure predicate every kill-switch
 * guard site (executeFlow/resumeFlow/decideApproval in
 * automation-flow.service.ts, runOneRule in automation-rule.service.ts)
 * calls after its own `Tenant.findById(...).select('settings.
 * automationsPaused').lean()` fetch — that fetch itself needs a live Mongo
 * connection and isn't covered here (see the Phase 5 report's integration-
 * test backlog); this file locks in the boolean interpretation of whatever
 * that fetch returns, which is the part that actually decides pause/resume
 * behavior and the part most likely to silently regress.
 *
 * Run: npx jest --testPathPatterns=automation-kill-switch.test.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { isAutomationPausedForTenant } from '../src/modules/native-crm/automation-rules/automation-rule.service';

describe('isAutomationPausedForTenant', () => {
  it('returns true when automationsPaused is explicitly true', () => {
    expect(isAutomationPausedForTenant({ settings: { automationsPaused: true } })).toBe(true);
  });

  it('returns false when automationsPaused is explicitly false', () => {
    expect(isAutomationPausedForTenant({ settings: { automationsPaused: false } })).toBe(false);
  });

  it('treats a missing automationsPaused field as unpaused (backward-compatible default)', () => {
    // The real-world shape for every tenant that existed before Phase 5 and
    // has never toggled the switch — confirmed live against a real,
    // untouched tenant document during Phase 5 verification: a `.lean()`
    // read does NOT materialize Mongoose's own schema default, so this
    // function's own falsy check is what actually provides the "missing =
    // unpaused" guarantee, not the schema.
    expect(isAutomationPausedForTenant({ settings: {} })).toBe(false);
  });

  it('treats a missing `settings` object entirely as unpaused', () => {
    expect(isAutomationPausedForTenant({} as any)).toBe(false);
  });

  it('treats a null tenant (e.g. a deleted/not-found tenant) as unpaused, not a crash', () => {
    expect(isAutomationPausedForTenant(null)).toBe(false);
  });

  it('treats an undefined tenant as unpaused, not a crash', () => {
    expect(isAutomationPausedForTenant(undefined)).toBe(false);
  });

  it('is independent of any per-flow `enabled` concept — reads only settings.automationsPaused', () => {
    // Global pause (Tenant.settings.automationsPaused) and a single flow's
    // own `enabled` boolean are deliberately separate concepts living on
    // separate documents (Tenant vs AutomationFlow) — this guards against a
    // future refactor accidentally wiring a flow's enabled state into the
    // tenant-wide pause check. `enabled` here is a decoy field this function
    // has no reason to read.
    const decoy = { enabled: false, settings: { automationsPaused: false } } as any;
    expect(isAutomationPausedForTenant(decoy)).toBe(false);
    const decoy2 = { enabled: true, settings: { automationsPaused: true } } as any;
    expect(isAutomationPausedForTenant(decoy2)).toBe(true);
  });
});
