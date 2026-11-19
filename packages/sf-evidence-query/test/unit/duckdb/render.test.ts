import type { QueryFiles } from '@cclabsnz/sf-evidence-engine';
import { openQuerySession, type QuerySession } from '../../../src/duckdb/session.js';

/**
 * Timestamp rendering in the session's row conversion. `getRowObjectsJson` labels every
 * TIMESTAMPTZ with the Node process's current UTC offset, whatever the session TimeZone and
 * whatever the offset was at that instant, so these pin the session's own rendering.
 */

const NO_FILES: QueryFiles = { bySource: {} as QueryFiles['bySource'], orphanCount: 0, orgLabels: {}, missingOrgs: [], rejectedPaths: 0 };

let session: QuerySession | undefined;

afterEach(() => {
  session?.close();
  session = undefined;
});

async function row(sql: string, timezone = 'Pacific/Auckland'): Promise<Record<string, unknown>> {
  session = await openQuerySession({ files: NO_FILES, timezone });
  const r = await session.run(sql);
  return r.rows[0]!;
}

describe('timestamp rendering', () => {
  it('renders TIMESTAMP as ISO UTC, milliseconds only when non-zero', async () => {
    const r = await row(
      "SELECT TIMESTAMP '2026-08-14 02:11:09' a, TIMESTAMP '2026-08-14 02:11:09.48' b, TIMESTAMP '2026-08-14 02:11:09.000123' c, TIMESTAMP '1969-12-31 23:59:59.5' d, 'infinity'::TIMESTAMP e",
    );
    expect(r).toEqual({
      a: '2026-08-14T02:11:09Z',
      b: '2026-08-14T02:11:09.480Z',
      // Sub-millisecond digits are kept, never truncated.
      c: '2026-08-14T02:11:09.000123Z',
      d: '1969-12-31T23:59:59.500Z',
      e: 'infinity',
    });
  });

  it('renders TIMESTAMPTZ with the --timezone offset at that instant, never Z', async () => {
    const auck = await row(
      "SELECT TIMESTAMPTZ '2026-08-14 02:11:09Z' winter, TIMESTAMPTZ '2026-11-17 08:00:12.482Z' summer, '-infinity'::TIMESTAMPTZ inf",
    );
    expect(auck).toEqual({ winter: '2026-08-14T14:11:09+12:00', summer: '2026-11-17T21:00:12.482+13:00', inf: '-infinity' });
    session!.close();
    const utc = await row("SELECT TIMESTAMPTZ '2026-08-14 02:11:09Z' t, TIMESTAMPTZ '1969-12-31 23:59:59.5Z' before_epoch", 'UTC');
    expect(utc).toEqual({ t: '2026-08-14T02:11:09+00:00', before_epoch: '1969-12-31T23:59:59.500+00:00' });
    session!.close();
    const kol = await row("SELECT TIMESTAMPTZ '2026-08-14 02:11:09Z' t", 'Asia/Kolkata');
    expect(kol.t).toBe('2026-08-14T07:41:09+05:30');
  });

  it('renders timestamps nested in lists, structs and maps', async () => {
    const r = await row(
      "SELECT [TIMESTAMPTZ '2026-08-14 02:11:09Z'] l, {'x': TIMESTAMP '2026-08-14 02:11:09'} s, MAP {'k': TIMESTAMPTZ '2026-08-14 02:11:09Z'} m, 9007199254740993::BIGINT b",
    );
    expect(r).toEqual({
      l: ['2026-08-14T14:11:09+12:00'],
      s: { x: '2026-08-14T02:11:09Z' },
      m: [{ key: 'k', value: '2026-08-14T14:11:09+12:00' }],
      // BIGINT stays the precise string getRowObjectsJson gives.
      b: '9007199254740993',
    });
  });
});
