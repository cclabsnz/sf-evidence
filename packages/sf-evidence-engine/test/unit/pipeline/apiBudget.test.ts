import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkApiBudget } from '../../../src/pipeline/apiBudget.js';
import { runCollect } from '../../../src/pipeline/runCollect.js';
import { ArchiveReader } from '../../../src/archive/reader.js';
import { LocalSink } from '../../../src/sinks/local.js';
import { ORG_ID } from '../../../src/testing/specVectors.js';
import type { RestClient, SoqlClient } from '@cclabsnz/sf-core';

function fakeRest(body: unknown, calls: string[] = []): RestClient {
  return {
    get: (async (path: string) => {
      calls.push(path);
      if (body instanceof Error) throw body;
      return body;
    }) as RestClient['get'],
    getRaw: async () => '',
    getRawToFile: async () => 0,
  };
}

const daily = (Max: number, Remaining: number) => ({ DailyApiRequests: { Max, Remaining } });

describe('checkApiBudget', () => {
  it('refuses a backfill when remaining is under the floor', async () => {
    const out = await checkApiBudget(fakeRest(daily(100_000, 4_000)), 5_000);
    expect(out).toEqual({ ok: false, remaining: 4_000, floor: 5_000 });
  });

  it('allows a run at exactly the floor', async () => {
    expect(await checkApiBudget(fakeRest(daily(100_000, 5_000)), 5_000)).toEqual({ ok: true });
  });

  it('uses max(5000, 10% of Max) by default', async () => {
    // 10% of 1,000,000 is 100,000, which beats the 5,000 minimum.
    expect(await checkApiBudget(fakeRest(daily(1_000_000, 99_999)))).toEqual({
      ok: false,
      remaining: 99_999,
      floor: 100_000,
    });
    expect(await checkApiBudget(fakeRest(daily(1_000_000, 100_000)))).toEqual({ ok: true });
    // 10% of 20,000 is 2,000, so the 5,000 minimum wins.
    expect(await checkApiBudget(fakeRest(daily(20_000, 4_999)))).toEqual({
      ok: false,
      remaining: 4_999,
      floor: 5_000,
    });
  });

  it('returns ok without a REST client', async () => {
    expect(await checkApiBudget(undefined)).toEqual({ ok: true });
  });

  it('throws when the org response has no usable DailyApiRequests', async () => {
    await expect(checkApiBudget(fakeRest({}), 5_000)).rejects.toThrow(/DailyApiRequests/);
  });
});

describe('checkApiBudget floor validation', () => {
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('throws on floor %s instead of passing it', async (floor) => {
    // NaN makes `remaining < floor` false, so an unvalidated NaN reported a pass as checked.
    await expect(checkApiBudget(fakeRest(daily(100_000, 1)), floor)).rejects.toThrow(/floor/i);
  });

  it('accepts a floor of 0', async () => {
    expect(await checkApiBudget(fakeRest(daily(100_000, 0)), 0)).toEqual({ ok: true });
  });

  it('rejects a bad floor even when there is no REST client', async () => {
    await expect(checkApiBudget(undefined, Number.NaN)).rejects.toThrow(/floor/i);
  });
});

describe('runCollect API budget guard', () => {
  let root: string;
  let sink: LocalSink;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-budget-'));
    sink = new LocalSink(root);
    await sink.init();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const queries: string[] = [];
  const soql = (): SoqlClient =>
    ({
      query: async () => ({ totalSize: 0, done: true, records: [] }),
      queryAll: (async (q: string) => {
        queries.push(q);
        return [];
      }) as SoqlClient['queryAll'],
    }) as SoqlClient;
  beforeEach(() => {
    queries.length = 0;
  });

  const base = (rest?: RestClient, extra: object = {}) => ({
    orgId: ORG_ID,
    sources: ['audit-trail' as const],
    sinks: [sink],
    soql: soql(),
    rest,
    now: new Date('2026-08-15T09:00:00.000Z'),
    ...extra,
  });

  it('refuses a backfill when remaining is under the floor', async () => {
    const calls: string[] = [];
    const result = await runCollect(base(fakeRest(daily(100_000, 4_000), calls), { apiFloor: 5_000 }));
    const s = result.sources[0]!;
    expect(s.status).toBe('degraded');
    expect(s.degradations).toHaveLength(1);
    expect(s.degradations[0]!.code).toBe('API_BUDGET_FLOOR');
    expect(s.degradations[0]!.remediation).toContain('4000');
    expect(s.degradations[0]!.remediation).toContain('5000');
    expect(s.degradations[0]!.remediation).toContain('--api-floor');
    expect(s.apiBudgetChecked).toBe(true);
    expect(s.queried).toEqual([]);
    expect(s.recordsWritten).toBe(0);
    expect(queries).toHaveLength(0);
    expect(result.degraded).toBe(true);
  });

  it('claims no coverage for a refused source', async () => {
    await runCollect(base(fakeRest(daily(100_000, 4_000)), { apiFloor: 5_000 }));
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });
    expect(summary?.coverage ?? []).toEqual([]);
  });

  it('collects when remaining is above the floor', async () => {
    const result = await runCollect(base(fakeRest(daily(100_000, 90_000))));
    expect(result.sources[0]!.status).toBe('complete');
    expect(result.sources[0]!.apiBudgetChecked).toBe(true);
  });

  it('never guards a short incremental window', async () => {
    await runCollect(base(fakeRest(daily(100_000, 90_000))));
    const calls: string[] = [];
    const later = new Date('2026-08-15T10:00:00.000Z');
    const result = await runCollect(base(fakeRest(daily(100_000, 1), calls), { now: later }));
    expect(calls).toEqual([]);
    expect(result.sources[0]!.status).toBe('complete');
    expect(result.sources[0]!.apiBudgetChecked).toBeUndefined();
  });

  it('never guards a snapshot source', async () => {
    const calls: string[] = [];
    const result = await runCollect({
      ...base(fakeRest(daily(100_000, 1), calls)),
      sources: ['limits' as const],
    });
    expect(calls).toEqual(['/limits/']); // the collector's own read only
    expect(result.sources[0]!.apiBudgetChecked).toBeUndefined();
  });

  describe('on a source that already has coverage', () => {
    // Coverage from 1 August only, so the next run plans a repair of 16 Feb to 1 Aug (well
    // over 7 days) plus the routine incremental window from 08:45.
    const later = new Date('2026-08-15T10:00:00.000Z');
    const seedAugust = () =>
      runCollect(base(fakeRest(daily(100_000, 90_000)), { since: '2026-08-01T00:00:00.000Z' }));

    it('refuses only the repair windows; the incremental window still runs', async () => {
      await seedAugust();
      queries.length = 0;
      const result = await runCollect(base(fakeRest(daily(100_000, 1)), { now: later, apiFloor: 5_000 }));
      const s = result.sources[0]!;
      const incremental = { from: '2026-08-15T08:45:00.000Z', to: '2026-08-15T10:00:00.000Z' };
      const repair = { from: '2026-02-16T10:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };

      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('CreatedDate >= 2026-08-15T08:45:00Z');
      expect(s.queried).toEqual([incremental]);
      expect(s.achieved).toEqual([incremental]);
      // Less than planned: the repair was refused, so the source is not complete.
      expect(s.status).toBe('partial');
      expect(s.apiBudgetChecked).toBe(true);
      expect(s.degradations).toHaveLength(1);
      expect(s.degradations[0]).toMatchObject({ code: 'API_BUDGET_FLOOR', window: repair });
      expect(s.degradations[0]!.detail).toMatch(/repair/i);
      expect(result.degraded).toBe(true);

      const entry = (await sink.readManifest(ORG_ID, 2))!;
      expect(entry.sources[0]!.achieved).toEqual([incremental]);
      expect(entry.degradations).toEqual(s.degradations);
    });

    it('runs the repair windows too when the budget allows', async () => {
      await seedAugust();
      queries.length = 0;
      const result = await runCollect(base(fakeRest(daily(100_000, 90_000)), { now: later }));
      // The repair is sliced by month, then the incremental window.
      expect(queries[0]).toContain('CreatedDate >= 2026-02-16T10:00:00Z');
      expect(queries.at(-1)).toContain('CreatedDate >= 2026-08-15T08:45:00Z');
      expect(result.sources[0]!.status).toBe('complete');
      expect(result.sources[0]!.apiBudgetChecked).toBe(true);
    });

    it('does not guard a long incremental window with no repair: the incremental always runs', async () => {
      await runCollect(base(fakeRest(daily(100_000, 90_000))));
      const calls: string[] = [];
      const month = new Date('2026-09-15T09:00:00.000Z');
      const result = await runCollect(base(fakeRest(daily(100_000, 1), calls), { now: month, apiFloor: 5_000 }));
      expect(calls).toEqual([]);
      expect(result.sources[0]!.status).toBe('complete');
      expect(result.sources[0]!.apiBudgetChecked).toBeUndefined();
    });

    it('guards the whole plan on --backfill, as on a first run', async () => {
      await seedAugust();
      queries.length = 0;
      const result = await runCollect(
        base(fakeRest(daily(100_000, 1)), { now: later, backfill: true, apiFloor: 5_000 }),
      );
      expect(queries).toHaveLength(0);
      expect(result.sources[0]!.status).toBe('degraded');
      expect(result.sources[0]!.queried).toEqual([]);
    });
  });

  it('fails the run on an invalid floor rather than reporting the budget as unchecked', async () => {
    await expect(runCollect(base(fakeRest(daily(100_000, 90_000)), { apiFloor: Number.NaN }))).rejects.toThrow(/floor/i);
  });

  it('records that the budget was not checked when there is no REST client', async () => {
    const result = await runCollect(base(undefined));
    expect(result.sources[0]!.status).toBe('complete');
    expect(result.sources[0]!.apiBudgetChecked).toBe(false);
  });

  it('proceeds and records apiBudgetChecked false when GET /limits/ fails', async () => {
    const result = await runCollect(base(fakeRest(new Error('boom'))));
    expect(result.sources[0]!.status).toBe('complete');
    expect(result.sources[0]!.apiBudgetChecked).toBe(false);
    expect(result.sources[0]!.apiBudgetNote).toContain('boom');
  });

  it('carries the reason when /limits/ has no usable DailyApiRequests', async () => {
    const result = await runCollect(base(fakeRest({})));
    expect(result.sources[0]!.apiBudgetChecked).toBe(false);
    expect(result.sources[0]!.apiBudgetNote).toMatch(/DailyApiRequests/);
  });

  it('carries a note when there is no REST client', async () => {
    const result = await runCollect(base(undefined));
    expect(result.sources[0]!.apiBudgetNote).toMatch(/no REST client/i);
  });

  it('has no note when the budget was checked', async () => {
    const result = await runCollect(base(fakeRest(daily(100_000, 90_000))));
    expect(result.sources[0]!.apiBudgetNote).toBeUndefined();
  });
});
