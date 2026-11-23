import { collectSliced } from '../../../src/collectors/slicing.js';
import { mergeWindows } from '../../../src/lib/windows.js';
import { sfApiError } from '../../fixtures/httpApiError.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function timeout(): Error {
  return Object.assign(new Error('timeout'), {
    errorCode: 'QUERY_TIMEOUT',
    statusCode: 400,
    name: 'ApiError',
  });
}

const len = (w: { from: string; to: string }) => Date.parse(w.to) - Date.parse(w.from);
const OPTS = { source: 'audit-trail' as const };

describe('collectSliced', () => {
  it('halves a timed-out slice and keeps both halves', async () => {
    const window = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };
    const fetch = async (slice: { from: string; to: string }) => {
      if (len(slice) > 10 * DAY) throw timeout();
      return [slice.from];
    };
    const result = await collectSliced(window, fetch, OPTS);

    expect(result.degradations).toEqual([]);
    expect(result.achieved).toEqual([window]);
    expect(result.rows.length).toBeGreaterThan(1);
  });

  it('records the exact bounds of a slice that still times out at the one-hour floor', async () => {
    const window = { from: '2026-06-10T00:00:00.000Z', to: '2026-06-10T02:00:00.000Z' };
    const result = await collectSliced(window, async () => {
      throw timeout();
    }, OPTS);

    expect(result.degradations.map((d) => d.window)).toEqual([
      { from: '2026-06-10T00:00:00.000Z', to: '2026-06-10T01:00:00.000Z' },
      { from: '2026-06-10T01:00:00.000Z', to: '2026-06-10T02:00:00.000Z' },
    ]);
    expect(result.degradations.every((d) => d.code === 'QUERY_TIMEOUT')).toBe(true);
    expect(result.achieved).toEqual([]);
  });

  it('keeps the rest of the month achieved when only a small stretch keeps timing out', async () => {
    const window = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };
    const bad = { from: '2026-06-10T00:00:00.000Z', to: '2026-06-10T01:00:00.000Z' };
    const fetch = async (slice: { from: string; to: string }) => {
      if (slice.from < bad.to && slice.to > bad.from) throw timeout();
      return [];
    };
    const result = await collectSliced(window, fetch, OPTS);

    expect(result.degradations.length).toBeGreaterThan(0);
    for (const d of result.degradations) {
      expect(d.window!.from < bad.to && d.window!.to > bad.from).toBe(true);
      expect(len(d.window!)).toBeLessThanOrEqual(2 * HOUR);
    }
    // Achieved and degraded slices tile the window exactly: nothing lost, nothing invented.
    const all = mergeWindows([...result.achieved, ...result.degradations.map((d) => d.window!)]);
    expect(all).toEqual([window]);
    expect(result.achieved.length).toBe(2);
  });

  it('handles a very large slice without spreading it as call arguments', async () => {
    const window = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' };
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    const result = await collectSliced(window, async () => big, OPTS);
    expect(result.rows).toHaveLength(200_000);
    expect(result.degradations).toEqual([]);
  });

  it('propagates an unrecognised error rather than recording it as reduced coverage', async () => {
    const window = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' };
    await expect(
      collectSliced(window, async () => {
        throw new Error('socket hang up');
      }, OPTS),
    ).rejects.toThrow('socket hang up');
  });

  it('records other recognised errors against the slice without halving', async () => {
    const window = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' };
    let calls = 0;
    const result = await collectSliced(window, async () => {
      calls += 1;
      throw Object.assign(new Error('no'), {
        errorCode: 'INSUFFICIENT_ACCESS',
        statusCode: 403,
        name: 'ApiError',
      });
    }, OPTS);
    expect(calls).toBe(1);
    expect(result.degradations).toHaveLength(1);
    expect(result.degradations[0]).toMatchObject({ code: 'INSUFFICIENT_ACCESS', window });
  });

  it('never reports a window as achieved when its fetch never ran', async () => {
    const window = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' };
    let calls = 0;
    const result = await collectSliced(window, async () => {
      calls += 1;
      return [];
    }, OPTS);
    expect(calls).toBe(0);
    expect(result).toEqual({ rows: [], achieved: [], degradations: [] });
  });

  it('honours a custom floor', async () => {
    const window = { from: '2026-06-10T00:00:00.000Z', to: '2026-06-10T04:00:00.000Z' };
    const result = await collectSliced(window, async () => {
      throw timeout();
    }, { ...OPTS, floorMs: 2 * HOUR });
    expect(result.degradations.map((d) => len(d.window!))).toEqual([2 * HOUR, 2 * HOUR]);
  });
});

describe('collectSliced with the error shape jsforce actually throws', () => {
  it('halves a slice on a real-shape QUERY_TIMEOUT (no statusCode)', async () => {
    const window = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };
    const asked: number[] = [];
    const fetch = async (slice: { from: string; to: string }) => {
      asked.push(len(slice));
      if (len(slice) > 10 * DAY) throw sfApiError('QUERY_TIMEOUT', 'Your query request was running for too long.');
      return [slice.from];
    };
    const result = await collectSliced(window, fetch, OPTS);

    expect(asked[0]).toBe(30 * DAY);
    expect(asked).toContain(15 * DAY);
    expect(result.degradations).toEqual([]);
    expect(result.achieved).toEqual([window]);
  });
});

describe('collectSliced after a permission error', () => {
  it.each(['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INVALID_TYPE'])(
    'stops on %s and records one degradation to the end of the window',
    async (code) => {
      const window = { from: '2026-05-15T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' };
      const asked: string[] = [];
      const fetch = async (slice: { from: string; to: string }) => {
        asked.push(slice.from);
        if (slice.from >= '2026-06-01') throw sfApiError(code);
        return [slice.from];
      };
      const result = await collectSliced(window, fetch, { source: 'login-history' });

      // May succeeded, June was denied, July and August were never asked for.
      expect(asked).toEqual(['2026-05-15T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);
      expect(result.achieved).toEqual([{ from: window.from, to: '2026-06-01T00:00:00.000Z' }]);
      expect(result.degradations).toHaveLength(1);
      expect(result.degradations[0]).toMatchObject({ code, window: { from: '2026-06-01T00:00:00.000Z', to: window.to } });
    },
  );

  it('keeps going after other recognised errors', async () => {
    const window = { from: '2026-05-15T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' };
    const asked: string[] = [];
    const result = await collectSliced(
      window,
      async (slice) => {
        asked.push(slice.from);
        throw sfApiError('REQUEST_LIMIT_EXCEEDED');
      },
      OPTS,
    );
    expect(asked).toHaveLength(4);
    expect(result.degradations).toHaveLength(4);
  });
});
