import { AuditTrailCollector } from '../../../src/collectors/auditTrail.js';
import { mergeWindows } from '../../../src/lib/windows.js';
import { ORG_ID } from '../../../src/testing/specVectors.js';
import type { SoqlClient } from '@cclabsnz/sf-core';

function rows(n: number, monthOffset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    Id: `0Ym5j00000XyZ${String(i).padStart(2, '0')}CAA`,
    Action: 'PermSetAssign',
    Section: 'Manage Users',
    Display: `change ${i}`,
    CreatedDate: `2026-0${8 - monthOffset}-14T02:11:0${i % 10}.000+0000`,
    CreatedById: '0055j00000AaBbCcAAG',
    DelegateUser: i === 0 ? 'support.admin@example.govt.nz' : null,
    CreatedByContext: null,
    CreatedByIssuer: null,
    CreatedBy: { Name: 'Jo Taylor', Username: 'jo.taylor@example.govt.nz' },
  }));
}

function fakeSoql(impl: (soql: string) => Promise<unknown[]>): SoqlClient {
  return {
    query: async () => ({ totalSize: 0, done: true, records: [] }),
    queryAll: (async (soql: string) => impl(soql)) as SoqlClient['queryAll'],
  } as SoqlClient;
}

const CTX = {
  orgId: ORG_ID,
  apiVersion: '64.0',
  collectedAt: '2026-08-15T09:00:00.000Z',
};

const WINDOW = { from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' };

describe('AuditTrailCollector', () => {
  it('declares the documented 180-day retention window', () => {
    expect(new AuditTrailCollector().retentionDays).toBe(180);
  });

  it('collects and normalises rows, preserving DelegateUser', async () => {
    const soql = fakeSoql(async () => rows(3));
    const outcome = await new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW });

    expect(outcome.status).toBe('complete');
    expect(outcome.records).toHaveLength(3);
    expect((outcome.records[0]!.payload as Record<string, unknown>).DelegateUser).toBe(
      'support.admin@example.govt.nz',
    );
  });

  it('selects DelegateUser and the CreatedBy join', async () => {
    let seen = '';
    const soql = fakeSoql(async (q) => {
      seen = q;
      return [];
    });
    await new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW });
    expect(seen).toContain('DelegateUser');
    expect(seen).toContain('CreatedBy.Username');
  });

  it('filters on CreatedDate, the only usable time filter on this object', async () => {
    // The window spans three month slices, so assert the bounds of the whole run:
    // the first slice opens at the window start, the last closes at the window end.
    const seen: string[] = [];
    const soql = fakeSoql(async (q) => {
      seen.push(q);
      return [];
    });
    await new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW });
    expect(seen[0]).toMatch(/WHERE CreatedDate >= 2026-06-01T00:00:00Z/);
    expect(seen[seen.length - 1]).toMatch(/CreatedDate < 2026-08-15T09:00:00Z/);
  });

  it('emits SOQL dateTime literals without milliseconds or quotes', () => {
    // Salesforce accepts YYYY-MM-DDThh:mm:ssZ only; .000Z risks MALFORMED_QUERY, and no
    // unit test reaches a live org to catch it.
    const soql = new AuditTrailCollector().describeQueries()[0]!.soql;
    expect(soql).not.toMatch(/\.\d{3}Z/);
    expect(soql).not.toContain("'2026");
  });

  it('describes the window as placeholders, never a date that looks like the real one', () => {
    const soql = new AuditTrailCollector().describeQueries()[0]!.soql;
    expect(soql).toContain('CreatedDate >= <from> AND CreatedDate < <to>');
    expect(soql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('never uses an aggregate, which this object does not support', async () => {
    let seen = '';
    const soql = fakeSoql(async (q) => {
      seen = q;
      return [];
    });
    await new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW });
    expect(seen.toUpperCase()).not.toContain('COUNT(');
    expect(seen.toUpperCase()).not.toContain('GROUP BY');
  });

  it('never filters on Section or Display, which are not filterable', async () => {
    let seen = '';
    const soql = fakeSoql(async (q) => {
      seen = q;
      return [];
    });
    await new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW });
    const where = seen.slice(seen.toUpperCase().indexOf('WHERE'));
    expect(where).not.toContain('Section =');
    expect(where).not.toContain('Display');
  });

  it('slices the window by month so one oversized query cannot lose the whole run', async () => {
    const seen: string[] = [];
    const soql = fakeSoql(async (q) => {
      seen.push(q);
      return [];
    });
    await new AuditTrailCollector().collect(
      { ...CTX, soql },
      { window: { from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' } },
    );
    expect(seen.length).toBe(3); // June, July, August
  });

  it('refuses to drop a row with no Id, rather than losing it silently', async () => {
    // A bare `continue` counted the row in `fetched` but in neither `written` nor
    // `deduped`, so the run reported fetched !== written + deduped with nothing explaining
    // the difference — while normaliseAuditTrailRow treated the same condition as fatal.
    // The two modules now agree, and they agree on the loud answer.
    const soql = fakeSoql(async () => [{ ...rows(1)[0], Id: undefined }]);
    await expect(
      new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW }),
    ).rejects.toThrow(/missing Id/i);
  });

  it('keeps fetched === written + deduped for every row it accepts', async () => {
    const soql = fakeSoql(async () => rows(3));
    const outcome = await new AuditTrailCollector().collect(
      { ...CTX, soql },
      { window: WINDOW },
    );
    expect(outcome.fetched).toBe(outcome.records.length + outcome.deduped);
  });

  it('deduplicates records that appear in more than one slice', async () => {
    const soql = fakeSoql(async () => rows(2));
    const outcome = await new AuditTrailCollector().collect(
      { ...CTX, soql },
      { window: { from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' } },
    );
    // Three slices each return the same two Ids; dedupe on SetupAuditTrail.Id.
    expect(outcome.records).toHaveLength(2);
    // fetched counts every row returned across all three slices, before dedupe; deduped
    // counts the four re-appearances (two in slice two, two in slice three).
    expect(outcome.fetched).toBe(6);
    expect(outcome.deduped).toBe(4);
  });

  it('excludes source ids already present in the archive', async () => {
    // WINDOW spans three month slices, and this fake returns the same three rows for
    // every slice: 3 new in the first slice (minus the 1 pre-known), then all 3 re-appear
    // as dedupes in each of the other two slices.
    const soql = fakeSoql(async () => rows(3));
    const outcome = await new AuditTrailCollector().collect(
      { ...CTX, soql },
      { window: WINDOW, knownSourceIds: new Set(['0Ym5j00000XyZ00CAA']) },
    );
    expect(outcome.records).toHaveLength(2);
    expect(outcome.fetched).toBe(9);
    expect(outcome.deduped).toBe(7);
  });

  it('degrades rather than throwing when the user lacks permission', async () => {
    const soql = fakeSoql(async () => {
      throw Object.assign(new Error('no access'), {
        errorCode: 'INSUFFICIENT_ACCESS',
        statusCode: 403,
        name: 'ApiError',
      });
    });
    const outcome = await new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW });

    expect(outcome.status).toBe('degraded');
    expect(outcome.records).toEqual([]);
    expect(outcome.degradations[0]?.code).toBe('INSUFFICIENT_ACCESS');
  });

  // A failure that is not retried by halving, so these tests pin month-slice bookkeeping.
  it('marks the source partial when some slices succeed and one fails', async () => {
    // C7: a partially covered window must never be reported as complete.
    let call = 0;
    const soql = fakeSoql(async () => {
      call += 1;
      if (call === 2) {
        throw Object.assign(new Error('timeout'), {
          errorCode: 'REQUEST_LIMIT_EXCEEDED',
          statusCode: 400,
          name: 'ApiError',
        });
      }
      return rows(1);
    });
    const outcome = await new AuditTrailCollector().collect(
      { ...CTX, soql },
      { window: { from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' } },
    );
    expect(outcome.status).toBe('partial');
    expect(outcome.degradations[0]?.code).toBe('REQUEST_LIMIT_EXCEEDED');
  });

  it('recovers a timed-out month by halving and reports it complete', async () => {
    let call = 0;
    const soql = fakeSoql(async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error('timeout'), {
          errorCode: 'QUERY_TIMEOUT',
          statusCode: 400,
          name: 'ApiError',
        });
      }
      return [];
    });
    const w = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };
    const outcome = await new AuditTrailCollector().collect({ ...CTX, soql }, { window: w });
    expect(outcome.status).toBe('complete');
    expect(outcome.degradations).toEqual([]);
    expect(call).toBe(3);
  });

  it('is partial with hour-scale degradations when a timeout persists for a short sub-range', async () => {
    const w = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };
    const bad = { from: '2026-06-10T00:00:00.000Z', to: '2026-06-10T01:00:00.000Z' };
    const soql = fakeSoql(async (q) => {
      const m = /CreatedDate >= (\S+) AND CreatedDate < (\S+) /.exec(q)!;
      const from = Date.parse(m[1]!);
      const to = Date.parse(m[2]!);
      if (from < Date.parse(bad.to) && to > Date.parse(bad.from)) {
        throw Object.assign(new Error('timeout'), {
          errorCode: 'QUERY_TIMEOUT',
          statusCode: 400,
          name: 'ApiError',
        });
      }
      return [];
    });
    const outcome = await new AuditTrailCollector().collect({ ...CTX, soql }, { window: w });

    expect(outcome.status).toBe('partial');
    expect(outcome.degradations.length).toBeGreaterThan(0);
    for (const d of outcome.degradations) {
      expect(d.code).toBe('QUERY_TIMEOUT');
      expect(Date.parse(d.window!.to) - Date.parse(d.window!.from)).toBeLessThanOrEqual(7_200_000);
    }
    const tiled = mergeWindows([...outcome.achieved, ...outcome.degradations.map((d) => d.window!)]);
    expect(tiled).toEqual([w]);
  });

  describe('per-slice outcomes', () => {
    // Slices of this window: Jan 10-Feb 1, Feb, Mar, Apr, May 1-20.
    const SLICED = { from: '2026-01-10T00:00:00.000Z', to: '2026-05-20T00:00:00.000Z' };
    const S = {
      jan: { from: '2026-01-10T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      feb: { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
      mar: { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
      apr: { from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
      may: { from: '2026-05-01T00:00:00.000Z', to: '2026-05-20T00:00:00.000Z' },
    };
    const limitExceeded = () =>
      Object.assign(new Error('request limit exceeded'), {
        errorCode: 'REQUEST_LIMIT_EXCEEDED',
        statusCode: 400,
        name: 'ApiError',
      });
    const failingCalls = (failing: number[]) => {
      let call = 0;
      return fakeSoql(async () => {
        call += 1;
        if (failing.includes(call)) throw limitExceeded();
        return [];
      });
    };

    it('records one degradation per failed slice, each with its exact window', async () => {
      const outcome = await new AuditTrailCollector().collect(
        { ...CTX, soql: failingCalls([2, 4]) },
        { window: SLICED },
      );
      expect(outcome.status).toBe('partial');
      expect(outcome.degradations).toHaveLength(2);
      expect(outcome.degradations.map((d) => d.window)).toEqual([S.feb, S.apr]);
      expect(outcome.achieved).toEqual([S.jan, S.mar, S.may]);
    });

    it('keeps non-adjacent succeeded slices separate and merges adjacent ones', async () => {
      const outcome = await new AuditTrailCollector().collect(
        { ...CTX, soql: failingCalls([3]) },
        { window: SLICED },
      );
      expect(outcome.achieved).toEqual([
        { from: S.jan.from, to: S.feb.to },
        { from: S.apr.from, to: S.may.to },
      ]);
    });

    it('is degraded with nothing achieved when every slice fails', async () => {
      const outcome = await new AuditTrailCollector().collect(
        { ...CTX, soql: failingCalls([1, 2, 3, 4, 5]) },
        { window: SLICED },
      );
      expect(outcome.status).toBe('degraded');
      expect(outcome.achieved).toEqual([]);
      expect(outcome.degradations).toHaveLength(5);
    });
  });

  it('propagates an unrecognised error instead of hiding it as a degradation', async () => {
    const soql = fakeSoql(async () => {
      throw new Error('socket hang up');
    });
    await expect(
      new AuditTrailCollector().collect({ ...CTX, soql }, { window: WINDOW }),
    ).rejects.toThrow(/socket hang up/);
  });

  it('describes its queries for `explain` without contacting an org', () => {
    const described = new AuditTrailCollector().describeQueries();
    expect(described).toHaveLength(1);
    expect(described[0]!.object).toBe('SetupAuditTrail');
    expect(described[0]!.permission).toMatch(/View Setup and Configuration/i);
    expect(described[0]!.soql).toContain('DelegateUser');
  });

  it('throws on an inverted window instead of reporting a plausible empty complete', async () => {
    // A caller contract violation, not a coverage gap: this must fail loudly, not fall
    // through to `status: 'complete', records: []`, which would look like a real result.
    const soql = fakeSoql(async () => rows(1));
    await expect(
      new AuditTrailCollector().collect(
        { ...CTX, soql },
        { window: { from: '2026-08-15T09:00:00.000Z', to: '2026-06-01T00:00:00.000Z' } },
      ),
    ).rejects.toThrow(/2026-08-15T09:00:00\.000Z.*2026-06-01T00:00:00\.000Z/s);
  });

  it('is complete with zero records and issues zero queries on a zero-width window', async () => {
    // window.from === window.to: a genuinely empty interval, reachable when a re-run's
    // `since` watermark equals `now`. `complete` is honest here, but only because it is
    // reached as an explicit decision, not a loop that silently never ran.
    let calls = 0;
    const soql = fakeSoql(async () => {
      calls += 1;
      return rows(1);
    });
    const outcome = await new AuditTrailCollector().collect(
      { ...CTX, soql },
      { window: { from: '2026-08-15T09:00:00.000Z', to: '2026-08-15T09:00:00.000Z' } },
    );
    expect(outcome.status).toBe('complete');
    expect(outcome.records).toEqual([]);
    expect(calls).toBe(0);
  });
});
