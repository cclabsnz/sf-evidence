import { LimitsCollector } from '../../../src/collectors/limits.js';
import { ORG_ID } from '../../../src/testing/specVectors.js';
import type { RestClient, SoqlClient } from '@cclabsnz/sf-core';

const COLLECTED_AT = '2026-08-15T09:00:12.482Z';
const HOUR = { from: '2026-08-15T09:00:00.000Z', to: '2026-08-15T10:00:00.000Z' };

function fakeRest(body: unknown, calls: string[] = []): RestClient {
  return {
    get: (async (path: string) => {
      calls.push(path);
      return body;
    }) as RestClient['get'],
    getRaw: async () => '',
    getRawToFile: async () => 0,
  };
}

const ctx = (rest?: RestClient, collectedAt = COLLECTED_AT) => ({
  soql: {} as SoqlClient,
  rest,
  orgId: ORG_ID,
  apiVersion: '64.0',
  collectedAt,
});

describe('LimitsCollector', () => {
  it('is a snapshot source with no source-side retention', () => {
    const c = new LimitsCollector();
    expect(c.kind).toBe('snapshot');
    expect(c.retentionDays).toBeNull();
  });

  it('emits one hour-bucketed sample with Used derived', async () => {
    const calls: string[] = [];
    const rest = fakeRest({ DailyApiRequests: { Max: 5000000, Remaining: 4211903 } }, calls);
    const out = await new LimitsCollector().collect(ctx(rest), { window: HOUR });

    expect(calls).toEqual(['/limits/']);
    expect(out.status).toBe('complete');
    expect(out.window).toEqual(HOUR);
    expect(out.achieved).toEqual([HOUR]);
    expect(out.records).toHaveLength(1);
    const rec = out.records[0]!;
    expect(rec.source).toBe('limits');
    expect(rec.source_id).toBe(`limits:${ORG_ID}:2026-08-15T09`);
    expect(rec.occurred_at).toBe('2026-08-15T09:00:00.000Z');
    expect(rec.collected_at).toBe(COLLECTED_AT);
    expect(rec.payload).toEqual({
      sampled_at: COLLECTED_AT,
      limits: { DailyApiRequests: { Max: 5000000, Remaining: 4211903, Used: 788097 } },
    });
  });

  it('keeps a limit with no Max verbatim and derives nothing for it', async () => {
    const odd = { Remaining: 3, 'Some App': { Max: 10, Remaining: 4 } };
    const rest = fakeRest({
      OnlyRemaining: odd,
      MaxAsString: { Max: '10', Remaining: 4 },
      WithExtra: { Max: 100, Remaining: 40, Foo: 'bar' },
    });
    const out = await new LimitsCollector().collect(ctx(rest), { window: HOUR });
    const limits = (out.records[0]!.payload as { limits: Record<string, unknown> }).limits;
    expect(limits.OnlyRemaining).toEqual(odd);
    expect(limits.MaxAsString).toEqual({ Max: '10', Remaining: 4 });
    expect(limits.WithExtra).toEqual({ Max: 100, Remaining: 40, Foo: 'bar', Used: 60 });
  });

  it('a second sample in the same hour dedupes', async () => {
    const rest = fakeRest({ DailyApiRequests: { Max: 10, Remaining: 4 } });
    const c = new LimitsCollector();
    const first = await c.collect(ctx(rest), { window: HOUR });
    const second = await c.collect(ctx(rest, '2026-08-15T09:41:00.000Z'), {
      window: HOUR,
      knownSourceIds: new Set(first.records.map((r) => r.source_id)),
    });
    expect(second.status).toBe('complete');
    expect(second.records).toHaveLength(0);
    expect(second.deduped).toBe(1);
    expect(second.fetched).toBe(1);
  });

  it('degrades with NO_REST_CLIENT when no REST client is wired', async () => {
    const out = await new LimitsCollector().collect(ctx(undefined), { window: HOUR });
    expect(out.status).toBe('failed');
    expect(out.records).toEqual([]);
    expect(out.achieved).toEqual([]);
    expect(out.degradations).toHaveLength(1);
    expect(out.degradations[0]!.code).toBe('NO_REST_CLIENT');
    expect(out.degradations[0]!.source).toBe('limits');
  });

  it('records a recognised API failure as a degradation and rethrows an unrecognised one', async () => {
    const denied = {
      get: async () => {
        throw Object.assign(new Error('limit'), {
          errorCode: 'REQUEST_LIMIT_EXCEEDED',
          statusCode: 403,
          name: 'ApiError',
        });
      },
    } as unknown as RestClient;
    const out = await new LimitsCollector().collect(ctx(denied), { window: HOUR });
    expect(out.status).toBe('failed');
    expect(out.achieved).toEqual([]);
    expect(out.degradations[0]!.code).toBe('REQUEST_LIMIT_EXCEEDED');

    const broken = {
      get: async () => {
        throw new Error('boom');
      },
    } as unknown as RestClient;
    await expect(new LimitsCollector().collect(ctx(broken), { window: HOUR })).rejects.toThrow('boom');
  });
});
