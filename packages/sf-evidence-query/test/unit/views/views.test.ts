import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSink, resolveQueryFiles, type QueryFiles } from '@cclabsnz/sf-evidence-engine';
import { FIXTURE, writeQueryFixture } from '@cclabsnz/sf-evidence-engine/testing/query';
import { openQuerySession, type QuerySession } from '../../../src/duckdb/session.js';

/**
 * The three views as a user sees them: compiled by the engine, run by real DuckDB over the
 * fixture archive, and rendered by the session's row conversion. Expected values are the
 * fixture's, so a pass means the dictionary's promises hold end to end.
 */

let root: string;
let sink: LocalSink;
let filesA: QueryFiles;
let session: QuerySession | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sfe-query-views-'));
  await writeQueryFixture(root);
  sink = new LocalSink(root);
  filesA = await resolveQueryFiles(sink, [FIXTURE.orgA]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  session?.close();
  session = undefined;
});

async function open(orgIds: string[] = [FIXTURE.orgA], timezone = 'Pacific/Auckland'): Promise<QuerySession> {
  const files = orgIds.length === 1 && orgIds[0] === FIXTURE.orgA ? filesA : await resolveQueryFiles(sink, orgIds);
  session = await openQuerySession({ files, timezone });
  return session;
}

/** The one row `sql` returns; fails the test if there is not exactly one. */
async function one(s: QuerySession, sql: string): Promise<Record<string, unknown>> {
  const r = await s.run(sql);
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!;
}

const change = (id: string): string => `SELECT * FROM setup_changes WHERE source_id = '${id}'`;

describe('setup_changes', () => {
  it('attributes a Login-As row to the delegate, not the impersonated user', async () => {
    const row = await one(await open(), change(FIXTURE.ids.a2));
    expect(row.via_login_as).toBe(true);
    expect(row.performed_by).toBe('admin@fixture.example');
    expect(row.performed_by_id).toBeNull();
    expect(row.recorded_as).toBe('jane@fixture.example');
    expect(row.recorded_as_id).toBe('005A00000000002AAA');
  });

  it('attributes an ordinary row to its creator', async () => {
    const row = await one(await open(), change(FIXTURE.ids.a1));
    expect(row.performed_by_id).toBe('005A00000000001AAA');
    expect(row.via_login_as).toBe(false);
    expect(row.org_label).toBe(FIXTURE.orgNames.A);
  });

  it('keeps null usernames and sections null', async () => {
    const row = await one(await open(), change(FIXTURE.ids.a3));
    expect(row.performed_by).toBeNull();
    expect(row.recorded_as).toBeNull();
    expect(row.section).toBeNull();
  });

  it('renders local time with the offset of --timezone at that instant', async () => {
    const auckland = await one(await open(), change(FIXTURE.ids.a1));
    expect(auckland.occurred_at_local).toBe('2026-08-14T14:11:09+12:00');
    expect(auckland.occurred_at_utc).toBe('2026-08-14T02:11:09Z');
    session!.close();

    const newYork = await one(await open([FIXTURE.orgA], 'America/New_York'), change(FIXTURE.ids.a1));
    expect(newYork.occurred_at_local).toBe('2026-08-13T22:11:09-04:00');
    expect(newYork.occurred_at_utc).toBe('2026-08-14T02:11:09Z');
  });

  // The session zone is UTC whatever --timezone says, so a naive *_utc value compared with a
  // zoned one (now(), a TIMESTAMPTZ literal) is read as UTC. Under an Auckland session zone the
  // same comparison silently shifted *_utc by 12 hours and dropped a1 from the first count.
  it.each([
    ["at a1's instant", "TIMESTAMPTZ '2026-08-14T02:11:09Z'", 3],
    ["one second after a1's instant", "TIMESTAMPTZ '2026-08-14T02:11:10Z'", 2],
    ['the same instant written with an Auckland offset', "TIMESTAMPTZ '2026-08-14 14:11:09+12'", 3],
  ] as const)('compares occurred_at_utc with a zoned value %s exactly, under --timezone Pacific/Auckland', async (_label, bound, n) => {
    const row = await one(await open([FIXTURE.orgA], 'Pacific/Auckland'), `SELECT count(*) AS n FROM setup_changes WHERE occurred_at_utc >= ${bound}`);
    expect(Number(row.n)).toBe(n);
  });

  it('counts every org in a session over both', async () => {
    const row = await one(await open([FIXTURE.orgA, FIXTURE.orgB]), 'SELECT count(*) AS n FROM setup_changes');
    // count(*) is BIGINT, which the session leaves as a precise string (Task 9 owns JSON numbers).
    expect(Number(row.n)).toBe(4);
  });
});

describe('records', () => {
  it('pins the hive partition types', async () => {
    const s = await open();
    const typed = await one(s, 'SELECT DISTINCT typeof(month) AS t FROM records');
    expect(typed.t).toBe('INTEGER');
    // The two August changes; the orphan in the same directory is in no manifest, so not read.
    const august = await one(s, 'SELECT count(*) AS n FROM records WHERE month = 8');
    expect(Number(august.n)).toBe(2);
  });

  it('has one row per org, source and source_id', async () => {
    const r = await (await open([FIXTURE.orgA, FIXTURE.orgB])).run(
      'SELECT org_id, source, source_id, count(*) c FROM records GROUP BY ALL HAVING c > 1',
    );
    expect(r.rows).toEqual([]);
  });
});

describe('limit_samples', () => {
  it('is long form over the top-level limits only', async () => {
    const r = await (await open()).run('SELECT * FROM limit_samples ORDER BY limit_name');
    expect(r.rows.map((x) => x.limit_name)).toEqual([
      'DailyApiRequests',
      'DataStorageMB',
      'NoRemaining',
      'PermissionSets',
      'ZeroCap',
    ]);
    const by = Object.fromEntries(r.rows.map((x) => [x.limit_name as string, x]));
    expect(by.DataStorageMB!.pct_used).toBe(80);
    expect(by.ZeroCap!.pct_used).toBeNull();
    expect(by.NoRemaining!.used).toBeNull();
    expect(by.NoRemaining!.pct_used).toBeNull();
    expect(by.CreateCustom).toBeUndefined();
    expect(by['PermissionSets.CreateCustom']).toBeUndefined();
    for (const row of r.rows) {
      expect(row.sampled_at_utc).toBe('2026-11-17T08:00:12.482Z');
      expect(row.hour_utc).toBe('2026-11-17T08:00:00Z');
      // November is NZDT; with the August +12:00 above, proof the offset is per instant.
      expect(row.sampled_at_local).toBe('2026-11-17T21:00:12.482+13:00');
    }
  });

  it('is empty, with the same columns and types, for an org with no limits', async () => {
    const full = (await (await open()).run('SELECT * FROM limit_samples')).columns;
    session!.close();
    const empty = await (await open([FIXTURE.orgB])).run('SELECT * FROM limit_samples');
    expect(empty.rows).toEqual([]);
    expect(empty.columns).toEqual(full);
  });
});
