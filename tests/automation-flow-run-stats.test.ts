/**
 * Phase 5 — Operations Dashboard run-stats aggregation, DB-free regression
 * coverage.
 *
 * The actual query EXECUTION (does Mongo return the right rows for the
 * right tenant) was verified live against a real database during Phase 5
 * verification and isn't repeatable here without one — see the Phase 5
 * report's integration-test backlog. What IS reliably testable without a
 * DB: that getFlowRunStats() builds the pipeline this file's own doc
 * comment promises (tenant-scoped $match first, a $facet with exactly the
 * two branches it's supposed to have, the right $cond expressions per
 * status), and that its own post-processing produces the documented
 * {perFlow, summary} shape — including the empty-result fallback — given a
 * canned aggregate() response. AutomationFlowRun.aggregate is mocked so
 * this never touches Mongo.
 *
 * Run: npx jest --testPathPatterns=automation-flow-run-stats.test.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const aggregateMock = jest.fn();
jest.mock('../src/modules/native-crm/automation-flows/automation-flow-run.model', () => ({
  AutomationFlowRun: { aggregate: (...args: unknown[]) => aggregateMock(...args) },
}));

import { getFlowRunStats } from '../src/modules/native-crm/automation-flows/automation-flow.service';

const TENANT_ID = '6a3cab08c3fc75c6089ad38e';

describe('getFlowRunStats — pipeline construction', () => {
  beforeEach(() => aggregateMock.mockReset());

  it('scopes the pipeline to the given tenant as the FIRST stage', async () => {
    aggregateMock.mockResolvedValue([{ perFlow: [], todaySummary: [] }]);
    await getFlowRunStats(TENANT_ID);
    const pipeline = aggregateMock.mock.calls[0][0];
    expect(pipeline[0]).toHaveProperty('$match');
    expect(pipeline[0].$match.tenantId.toString()).toBe(TENANT_ID);
  });

  it('builds exactly one $facet stage with perFlow and todaySummary branches', async () => {
    aggregateMock.mockResolvedValue([{ perFlow: [], todaySummary: [] }]);
    await getFlowRunStats(TENANT_ID);
    const pipeline = aggregateMock.mock.calls[0][0];
    const facetStage = pipeline.find((s: any) => '$facet' in s);
    expect(facetStage).toBeDefined();
    expect(Object.keys(facetStage.$facet).sort()).toEqual(['perFlow', 'todaySummary']);
  });

  it('perFlow branch sorts by startedAt desc before grouping by flowId (the $first "most recent" trick)', async () => {
    aggregateMock.mockResolvedValue([{ perFlow: [], todaySummary: [] }]);
    await getFlowRunStats(TENANT_ID);
    const [, facetStage] = aggregateMock.mock.calls[0][0];
    const perFlow = facetStage.$facet.perFlow;
    expect(perFlow[0]).toEqual({ $sort: { startedAt: -1 } });
    expect(perFlow[1].$group._id).toBe('$flowId');
    expect(perFlow[1].$group.lastRunAt).toEqual({ $first: '$startedAt' });
    expect(perFlow[1].$group.lastStatus).toEqual({ $first: '$status' });
  });

  it('perFlow branch counts all four run statuses independently, not folded together', async () => {
    aggregateMock.mockResolvedValue([{ perFlow: [], todaySummary: [] }]);
    await getFlowRunStats(TENANT_ID);
    const [, facetStage] = aggregateMock.mock.calls[0][0];
    const group = facetStage.$facet.perFlow[1].$group;
    for (const status of ['completed', 'failed', 'partial', 'paused']) {
      const field = `${status}Count`;
      expect(group[field].$sum.$cond[0]).toEqual({ $eq: ['$status', status] });
    }
  });

  it('todaySummary branch filters on startedAt >= start-of-today, independent of perFlow', async () => {
    const before = Date.now();
    aggregateMock.mockResolvedValue([{ perFlow: [], todaySummary: [] }]);
    await getFlowRunStats(TENANT_ID);
    const [, facetStage] = aggregateMock.mock.calls[0][0];
    const todayMatch = facetStage.$facet.todaySummary[0].$match.startedAt.$gte;
    // Must be today's midnight, not "now" — a tenant querying stats at
    // 23:59 and again at 00:01 the next day must see runsToday reset.
    expect(todayMatch.getHours()).toBe(0);
    expect(todayMatch.getMinutes()).toBe(0);
    expect(todayMatch.getTime()).toBeLessThanOrEqual(before);
  });

  it('returns exact {perFlow, summary} shape from a realistic aggregate() response', async () => {
    const perFlowRow = {
      _id: 'flow1', totalRuns: 5, completedCount: 3, failedCount: 1, partialCount: 0,
      pausedCount: 1, lastRunAt: new Date('2026-08-28T10:00:00Z'), lastStatus: 'paused',
    };
    aggregateMock.mockResolvedValue([{
      perFlow: [perFlowRow],
      todaySummary: [{ runsToday: 4, failedToday: 1, completedToday: 3 }],
    }]);
    const result = await getFlowRunStats(TENANT_ID);
    expect(result.perFlow).toEqual([perFlowRow]);
    expect(result.summary).toEqual({ runsToday: 4, failedToday: 1, completedToday: 3 });
  });

  it('falls back to zeroed summary when todaySummary is empty (no runs today at all) — never undefined/crash', async () => {
    aggregateMock.mockResolvedValue([{ perFlow: [], todaySummary: [] }]);
    const result = await getFlowRunStats(TENANT_ID);
    expect(result.summary).toEqual({ runsToday: 0, failedToday: 0, completedToday: 0 });
    expect(result.perFlow).toEqual([]);
  });

  it('falls back safely when aggregate() resolves an empty array entirely (defensive — should not happen with $facet, but must not crash)', async () => {
    aggregateMock.mockResolvedValue([]);
    const result = await getFlowRunStats(TENANT_ID);
    expect(result.perFlow).toEqual([]);
    expect(result.summary).toEqual({ runsToday: 0, failedToday: 0, completedToday: 0 });
  });
});
