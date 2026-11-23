import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveReader } from '../../../src/archive/reader.js';
import { LocalSink } from '../../../src/sinks/local.js';
import { planWindows, runCollect } from '../../../src/pipeline/runCollect.js';
import { ORG_ID } from '../../../src/testing/specVectors.js';
import { buildBatch } from '../../../src/chain/manifestBuilder.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import type { SoqlClient } from '@cclabsnz/sf-core';

function fakeSoql(impl: (soql: string) => Promise<unknown[]>): SoqlClient {
  return {
    query: async () => ({ totalSize: 0, done: true, records: [] }),
    queryAll: (async (soql: string) => impl(soql)) as SoqlClient['queryAll'],
  } as SoqlClient;
}

const ROW = {
  Id: '0Ym5j00000XyZ01CAA',
  Action: 'PermSetAssign',
  Section: 'Manage Users',
  Display: 'change',
  CreatedDate: '2026-08-14T02:11:09.000+0000',
  CreatedById: '0055j00000AaBbCcAAG',
  DelegateUser: 'support.admin@example.govt.nz',
  CreatedByContext: null,
  CreatedByIssuer: null,
  CreatedBy: { Name: 'Jo Taylor', Username: 'jo.taylor@example.govt.nz' },
};

describe('runCollect', () => {
  let root: string;
  let sink: LocalSink;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-'));
    sink = new LocalSink(root);
    await sink.init();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const base = () => ({
    orgId: ORG_ID,
    sources: ['audit-trail' as const],
    sinks: [sink],
    soql: fakeSoql(async () => [ROW]),
    now: new Date('2026-08-15T09:00:00.000Z'),
  });

  it('writes a genesis manifest on the first run', async () => {
    const result = await runCollect(base());
    expect(result.manifest.seq).toBe(1);
    expect(result.manifest.prev).toBe(`sha256:${'0'.repeat(64)}`);
    expect(result.degraded).toBe(false);
  });

  it('links the second run to the first', async () => {
    const first = await runCollect(base());
    const second = await runCollect(base());
    expect(second.manifest.seq).toBe(2);
    expect(second.manifest.prev).toBe(first.manifest.hash);
  });

  it('is idempotent: a re-run archives no new records', async () => {
    await runCollect(base());
    const second = await runCollect(base());
    expect(second.sources[0]!.recordsWritten).toBe(0);
    // The second run is incremental: one 15-minute overlap window inside August, so one
    // SOQL round-trip. This fake returns the already-archived row for it, and it is skipped.
    expect(second.sources[0]!.recordsDeduped).toBe(1);
    expect(second.sources[0]!.recordsFetched).toBe(1);
  });

  it('still writes a manifest on a zero-record run', async () => {
    // A run that happened and found nothing is evidence too; its absence would look
    // identical to a run that never happened.
    await runCollect(base());
    const second = await runCollect(base());
    expect(second.manifest.seq).toBe(2);
    await expect(sink.readManifest(ORG_ID, 2)).resolves.not.toBeNull();
  });

  it('backfills the full 180-day window on the first run', async () => {
    const seen: string[] = [];
    await runCollect({ ...base(), soql: fakeSoql(async (q) => { seen.push(q); return []; }) });
    expect(seen[0]).toContain('2026-02-1'); // 180 days before 2026-08-15
  });

  it('dry-run writes nothing and says so', async () => {
    const result = await runCollect({ ...base(), dryRun: true });
    expect(result.dryRun).toBe(true);
    await expect(sink.head(ORG_ID)).resolves.toBeNull();
    await expect(sink.listManifests(ORG_ID)).resolves.toEqual([]);
  });

  it('reports degraded when a source could not be read, and still writes the manifest', async () => {
    const soql = fakeSoql(async () => {
      throw Object.assign(new Error('no access'), {
        errorCode: 'INSUFFICIENT_ACCESS',
        statusCode: 403,
        name: 'ApiError',
      });
    });
    const result = await runCollect({ ...base(), soql });

    expect(result.degraded).toBe(true);
    expect(result.sources[0]!.status).toBe('degraded');
    // The degradation is part of the evidence, not just terminal output.
    const manifest = await sink.readManifest(ORG_ID, 1);
    expect(manifest!.degradations[0]!.code).toBe('INSUFFICIENT_ACCESS');
  });

  it('archives audit-trail and reports the run degraded when LoginHistory is not readable', async () => {
    const soql = fakeSoql(async (q) => {
      if (q.includes('FROM LoginHistory')) {
        throw Object.assign(new Error('no access'), {
          errorCode: 'INSUFFICIENT_ACCESS',
          statusCode: 403,
          name: 'ApiError',
        });
      }
      return [ROW];
    });
    const result = await runCollect({
      ...base(),
      sources: ['audit-trail' as const, 'login-history' as const],
      soql,
    });

    const audit = result.sources.find((s) => s.source === 'audit-trail')!;
    const login = result.sources.find((s) => s.source === 'login-history')!;
    expect(audit.status).toBe('complete');
    expect(audit.recordsWritten).toBe(1);
    expect(login.status).toBe('degraded');
    expect(login.recordsWritten).toBe(0);
    expect(result.degraded).toBe(true);
  });

  it('reports degraded when the only degradation is a field downgrade on a complete source', async () => {
    let first = true;
    const soql = fakeSoql(async (q) => {
      if (q.includes('FROM LoginHistory') && first) {
        first = false;
        throw Object.assign(new Error('No such column'), {
          errorCode: 'INVALID_FIELD',
          statusCode: 400,
          name: 'ApiError',
        });
      }
      return [];
    });
    const result = await runCollect({ ...base(), sources: ['login-history' as const], soql });

    expect(result.sources[0]!.status).toBe('complete');
    expect(result.sources[0]!.degradations).toHaveLength(1);
    expect(result.degraded).toBe(true);
  });

  it('puts every failed slice of a source into the manifest degradations', async () => {
    let call = 0;
    const soql = fakeSoql(async () => {
      call += 1;
      if (call === 2 || call === 4) {
        throw Object.assign(new Error('timeout'), {
          errorCode: 'REQUEST_LIMIT_EXCEEDED',
          statusCode: 400,
          name: 'ApiError',
        });
      }
      return [];
    });
    const result = await runCollect({
      ...base(),
      soql,
      since: '2026-01-10T00:00:00.000Z',
      until: '2026-05-20T00:00:00.000Z',
    });

    expect(result.sources[0]!.degradations).toHaveLength(2);
    const manifest = await sink.readManifest(ORG_ID, 1);
    expect(manifest!.degradations).toHaveLength(2);
    expect(manifest!.degradations.map((d) => d.window?.from)).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
    expect(manifest!.sources[0]!.achieved).toHaveLength(3);
  });

  it('finds and reports orphan record files, and does not adopt them', async () => {
    // Seeded with a real orphan: asserting [] on a clean archive proved nothing about the
    // code path, since a clean archive has no orphans whatever the implementation does.
    await runCollect(base());
    const orphan = `org_id=${ORG_ID}/source=audit-trail/year=2026/month=08/part-20260901T000000Z-ZZZZZZZZ.ndjson`;
    await writeFile(
      join(root, ...orphan.split('/')),
      JSON.stringify({ source_id: '0Ym5j00000ORPHANAAA' }) + '\n',
    );

    const result = await runCollect(base());

    expect(result.orphansFound.map((o) => o.relPath)).toEqual([orphan]);
    // "Found", not "adopted": the orphan's record is in no manifest and so in no chain.
    const manifest = (await sink.readManifest(ORG_ID, 2))!;
    const paths = manifest.sources.flatMap((s) => s.files.map((f) => f.path));
    expect(paths).not.toContain(orphan);
  });

  it('reports a failing sink as failed for that sink, without discarding the run', async () => {
    // SPEC.md §8.2: a sink write failure "aborts *that sink* ... with the run reported as
    // failed for that sink". It must not throw past the sinks that already accepted the
    // batch and leave the caller with nothing.
    const failing = {
      id: 'git' as const,
      capabilities: { ...sink.capabilities, canonical: true },
      describe: () => sink.describe(),
      init: async () => {},
      checkReadable: async () => {},
      head: async () => null,
      readManifest: async () => null,
      listManifests: async () => [],
      readFile: async () => Buffer.alloc(0),
      listOrphans: async () => [],
      queryRoot: () => null,
      listOrgs: async () => [],
      readState: async () => null,
      writeState: async () => {},
      putBatch: async () => {
        throw new Error('disk full');
      },
    };

    const result = await runCollect({ ...base(), sinks: [sink, failing] });

    expect(result.sinks[0]).toMatchObject({ id: 'local', written: true });
    expect(result.sinks[1]).toMatchObject({ id: 'git', written: false, error: 'disk full' });
    // The local sink kept the batch, so it is on disk and verifiable.
    await expect(sink.readManifest(ORG_ID, 1)).resolves.not.toBeNull();
    // But the run is not reported as clean: one canonical sink's chain did not advance.
    expect(result.degraded).toBe(true);
  });

  it('fails the run when no canonical sink accepted the batch', async () => {
    const failing = {
      ...sink,
      id: 'local' as const,
      capabilities: { ...sink.capabilities },
      describe: () => sink.describe(),
      init: async () => {},
      checkReadable: async () => {},
      head: async () => null,
      readManifest: async () => null,
      listManifests: async () => [],
      readFile: async () => Buffer.alloc(0),
      listOrphans: async () => [],
      queryRoot: () => null,
      listOrgs: async () => [],
      readState: async () => null,
      writeState: async () => {},
      putBatch: async () => {
        throw new Error('disk full');
      },
    };
    const err = await runCollect({ ...base(), sinks: [failing] }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/No canonical sink completed this run/);
    expect((err as Error).message).toMatch(/disk full/);
    // It must not assert an empty archive. Sinks write record files, then the manifest,
    // then head — a failure partway through leaves real files behind, and this function
    // cannot tell how far each sink got. It points at verify instead of guessing.
    expect((err as Error).message).not.toMatch(/nothing was archived/i);
    expect((err as Error).message).toMatch(/sf evidence verify --org-id/);
  });

  it('refuses to run without a canonical sink', async () => {
    const mirror = { ...sink, capabilities: { ...sink.capabilities, canonical: false } } as typeof sink;
    await expect(runCollect({ ...base(), sinks: [mirror] })).rejects.toThrow(/canonical sink/i);
  });

  it('reports recordsDeduped as rows skipped this run, not the whole archive', async () => {
    // Regression guard: recordsDeduped used to be `known.size` — the entire archive's
    // known-id count for the source — rather than the number of rows this run's SOQL
    // actually returned and skipped. A narrow-window re-run against a larger archive is
    // exactly where the two numbers diverge.
    const archiveRows = Array.from({ length: 5 }, (_, i) => ({
      ...ROW,
      Id: `0Ym5j00000XyZ0${i}CAA`,
      // Inside the narrow window below. Dedupe reads only the month partitions a window
      // touches, which is sound because a record's CreatedDate, and so its partition, never
      // changes: an id can only be redelivered by a window that contains its CreatedDate.
      CreatedDate: '2026-08-14T02:12:00.000+0000',
    }));
    await runCollect({ ...base(), soql: fakeSoql(async () => archiveRows) });

    // Narrow second run: the org returns two rows for this one-day window — one brand
    // new id, and one that happens to already be archived (e.g. re-queried on a boundary).
    const narrowRows = [
      { ...ROW, Id: '0Ym5j00000XyZ99CAA', CreatedDate: '2026-08-14T02:11:09.000+0000' },
      { ...ROW, Id: '0Ym5j00000XyZ00CAA', CreatedDate: '2026-08-14T02:12:00.000+0000' },
    ];
    const second = await runCollect({
      ...base(),
      since: '2026-08-14T00:00:00.000Z',
      until: '2026-08-15T00:00:00.000Z',
      soql: fakeSoql(async () => narrowRows),
    });

    expect(second.sources[0]!.recordsFetched).toBe(2);
    expect(second.sources[0]!.recordsWritten).toBe(1);
    expect(second.sources[0]!.recordsDeduped).toBe(1); // not 5, the whole archive
  });

  it('a second run with no --since queries only the incremental window', async () => {
    await runCollect(base());
    const seen: string[] = [];
    await runCollect({
      ...base(),
      now: new Date('2026-08-15T10:00:00.000Z'),
      soql: fakeSoql(async (q) => {
        seen.push(q);
        return [];
      }),
    });
    // Retention moved on an hour too, so there is no gap behind the covered range: the only
    // window is the last covered instant (09:00) minus the 15-minute overlap, up to now.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('CreatedDate >= 2026-08-15T08:45:00Z');
    expect(seen[0]).toContain('CreatedDate < 2026-08-15T10:00:00Z');
  });

  it('re-collects a gap inside the retention window and records only what it queried', async () => {
    await runCollect({ ...base(), since: '2026-03-01T00:00:00.000Z' });
    const seen: string[] = [];
    const second = await runCollect({
      ...base(),
      now: new Date('2026-08-15T10:00:00.000Z'),
      soql: fakeSoql(async (q) => {
        seen.push(q);
        return [];
      }),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('CreatedDate >= 2026-02-16T10:00:00Z');
    expect(seen[0]).toContain('CreatedDate < 2026-03-01T00:00:00Z');
    expect(seen[1]).toContain('CreatedDate >= 2026-08-15T08:45:00Z');

    const entry = (await sink.readManifest(ORG_ID, 2))!.sources[0]!;
    expect(entry.status).toBe('complete');
    expect(entry.window).toEqual({ from: '2026-02-16T10:00:00.000Z', to: '2026-08-15T10:00:00.000Z' });
    // Complete, but the run did not query March to August: `achieved` must say so, or
    // `achievedOf` would read the whole spanning window as covered by this run.
    expect(entry.achieved).toEqual([
      { from: '2026-02-16T10:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
      { from: '2026-08-15T08:45:00.000Z', to: '2026-08-15T10:00:00.000Z' },
    ]);
    expect(second.sources[0]!.window).toEqual(entry.window);
    expect(second.sources[0]!.queried).toEqual(entry.achieved);
  });

  it('reports achieved separately from queried: a partial source covered less than it queried', async () => {
    let call = 0;
    const result = await runCollect({
      ...base(),
      since: '2026-06-01T00:00:00.000Z',
      soql: fakeSoql(async () => {
        call += 1;
        if (call === 2) {
          throw Object.assign(new Error('limit'), {
            errorCode: 'REQUEST_LIMIT_EXCEEDED',
            statusCode: 400,
            name: 'ApiError',
          });
        }
        return [];
      }),
    });
    const s = result.sources[0]!;
    const entry = (await sink.readManifest(ORG_ID, 1))!.sources[0]!;
    expect(s.status).toBe('partial');
    expect(s.queried).toEqual([{ from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }]);
    expect(s.achieved.length).toBeGreaterThan(0);
    expect(s.achieved).not.toEqual(s.queried);
    expect(s.achieved).toEqual(entry.achieved);
  });

  it('keeps a single-window complete entry byte-identical, with no achieved field', async () => {
    await runCollect(base());
    const entry = (await sink.readManifest(ORG_ID, 1))!.sources[0]!;
    expect(entry.status).toBe('complete');
    expect('achieved' in entry).toBe(false);
  });

  it('writes coverage.json after the run, matching the archive', async () => {
    await runCollect(base());
    const cache = JSON.parse(
      await readFile(join(root, `org_id=${ORG_ID}`, '_state', 'coverage.json'), 'utf8'),
    );
    expect(cache.version).toBe(3);
    expect(cache.seq).toBe(1);
    expect(cache.summaries[0].coverage).toEqual([
      { from: '2026-02-16T09:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
    ]);
  });

  it('never writes coverage.json on a dry run', async () => {
    await runCollect(base());
    await rm(join(root, `org_id=${ORG_ID}`, '_state'), { recursive: true });
    await runCollect({ ...base(), dryRun: true });
    await expect(
      readFile(join(root, `org_id=${ORG_ID}`, '_state', 'coverage.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not stall on coverage that runs past the last run', async () => {
    // A legacy entry whose window ran into the future (an unvalidated --until, or clock
    // skew). No run covers time after its own created_at, so planning clips there.
    await sink.putBatch(
      buildBatch({
        orgId: ORG_ID,
        runId: '01K3QF8H2N0000000000000001',
        createdAt: '2026-08-15T09:00:00.000Z',
        collectedAt: '2026-08-15T09:00:00.000Z',
        prevManifestHash: GENESIS_PREV,
        seq: 1,
        outcomes: [
          {
            source: 'audit-trail',
            status: 'complete',
            window: { from: '2026-02-16T09:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
            achieved: [{ from: '2026-02-16T09:00:00.000Z', to: '2026-12-01T00:00:00.000Z' }],
            records: [],
          },
        ],
        degradations: [],
      }),
    );

    const seen: string[] = [];
    const result = await runCollect({
      ...base(),
      now: new Date('2026-08-16T09:00:00.000Z'),
      soql: fakeSoql(async (q) => {
        seen.push(q);
        return [];
      }),
    });

    expect(result.sources[0]!.queried[0]!.from <= '2026-08-15T09:00:00.000Z').toBe(true);
    expect(result.sources[0]!.queried[0]!.from).toBe('2026-08-15T08:45:00.000Z');
    expect(seen[0]).toContain('CreatedDate >= 2026-08-15T08:45:00Z');
  });

  it('records which clock ended its windows: local unless the host says it read the org clock', async () => {
    expect((await runCollect({ ...base(), dryRun: true })).clock).toBe('local');
    const read = await runCollect({ ...base(), dryRun: true, clock: 'org' });
    expect(read.clock).toBe('org');
    expect(read.clockNote).toBeUndefined();
    const fallback = await runCollect({ ...base(), dryRun: true, clock: 'local', clockNote: 'no Date header' });
    expect(fallback.clockNote).toBe('no Date header');
  });

  it('answers the same when _state is deleted', async () => {
    await runCollect({ ...base(), since: '2026-03-01T00:00:00.000Z' });
    await rm(join(root, `org_id=${ORG_ID}`, '_state'), { recursive: true });
    const seen: string[] = [];
    await runCollect({
      ...base(),
      now: new Date('2026-08-15T10:00:00.000Z'),
      soql: fakeSoql(async (q) => {
        seen.push(q);
        return [];
      }),
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('CreatedDate >= 2026-02-16T10:00:00Z');
  });
});

describe('planWindows', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const retentionStart = '2026-02-16T09:00:00.000Z';
  const R = 180;

  it('planWindows collects from 15 minutes before the last covered instant', () => {
    expect(
      planWindows({
        now,
        retentionDays: R,
        coverage: [{ from: retentionStart, to: '2026-08-15T08:00:00.000Z' }],
      }),
    ).toEqual([{ from: '2026-08-15T07:45:00.000Z', to: '2026-08-15T09:00:00.000Z' }]);
  });

  it('planWindows re-collects a gap inside the retention window', () => {
    expect(
      planWindows({
        now,
        retentionDays: R,
        coverage: [
          { from: '2026-01-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
          { from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T08:00:00.000Z' },
        ],
      }),
    ).toEqual([
      { from: '2026-05-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
      { from: '2026-08-15T07:45:00.000Z', to: '2026-08-15T09:00:00.000Z' },
    ]);
  });

  it('re-collects the uncovered start of the retention window', () => {
    expect(
      planWindows({
        now,
        retentionDays: R,
        coverage: [{ from: '2026-03-01T00:00:00.000Z', to: '2026-08-15T08:00:00.000Z' }],
      }),
    ).toEqual([
      { from: retentionStart, to: '2026-03-01T00:00:00.000Z' },
      { from: '2026-08-15T07:45:00.000Z', to: '2026-08-15T09:00:00.000Z' },
    ]);
  });

  it('merges a gap that touches the overlap window into it', () => {
    expect(
      planWindows({
        now,
        retentionDays: R,
        coverage: [
          { from: retentionStart, to: '2026-08-15T07:00:00.000Z' },
          { from: '2026-08-15T07:50:00.000Z', to: '2026-08-15T08:00:00.000Z' },
        ],
      }),
    ).toEqual([{ from: '2026-08-15T07:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }]);
  });

  it('planWindows clamps until to now', () => {
    expect(
      planWindows({ now, retentionDays: R, coverage: [], until: '2026-09-01T00:00:00.000Z' }),
    ).toEqual([{ from: retentionStart, to: '2026-08-15T09:00:00.000Z' }]);
    expect(
      planWindows({
        now,
        retentionDays: R,
        coverage: [],
        since: '2026-08-01T00:00:00.000Z',
        until: '2026-09-01T00:00:00.000Z',
      }),
    ).toEqual([{ from: '2026-08-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }]);
  });

  it('honours an explicit since over coverage', () => {
    expect(
      planWindows({
        now,
        retentionDays: R,
        since: '2026-08-01T00:00:00.000Z',
        until: '2026-08-02T00:00:00.000Z',
        coverage: [{ from: retentionStart, to: '2026-08-15T08:00:00.000Z' }],
      }),
    ).toEqual([{ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' }]);
  });

  it('backfills the whole retention window on backfill or with no coverage', () => {
    const full = [{ from: retentionStart, to: '2026-08-15T09:00:00.000Z' }];
    expect(planWindows({ now, retentionDays: R, coverage: [] })).toEqual(full);
    expect(
      planWindows({
        now,
        retentionDays: R,
        backfill: true,
        coverage: [{ from: retentionStart, to: '2026-08-15T08:00:00.000Z' }],
      }),
    ).toEqual(full);
  });

  it('never plans a window older than retention, where the data no longer exists', () => {
    // Coverage that ended long ago: its overlap start is outside retention. Querying there
    // would record as achieved a range Salesforce has already deleted.
    expect(
      planWindows({
        now,
        retentionDays: R,
        coverage: [{ from: '2026-01-01T00:00:00.000Z', to: '2026-01-10T00:00:00.000Z' }],
      }),
    ).toEqual([{ from: retentionStart, to: '2026-08-15T09:00:00.000Z' }]);
  });

  it('plans an empty window at until when until is already covered', () => {
    expect(
      planWindows({
        now,
        retentionDays: R,
        until: '2026-08-01T00:00:00.000Z',
        coverage: [{ from: retentionStart, to: '2026-08-15T08:00:00.000Z' }],
      }),
    ).toEqual([{ from: '2026-08-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }]);
  });
});

describe('runCollect with a snapshot source', () => {
  let root: string;
  let sink: LocalSink;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-'));
    sink = new LocalSink(root);
    await sink.init();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const rest = (calls: string[]) =>
    ({
      get: async (p: string) => {
        calls.push(p);
        return { DailyApiRequests: { Max: 10, Remaining: 4 } };
      },
    }) as unknown as import('@cclabsnz/sf-core').RestClient;

  const args = (calls: string[], now: string) => ({
    orgId: ORG_ID,
    sources: ['limits' as const],
    sinks: [sink],
    soql: fakeSoql(async () => []),
    rest: rest(calls),
    now: new Date(now),
  });

  it('collects exactly the current hour, ignoring planning inputs, and dedupes within it', async () => {
    const calls: string[] = [];
    const first = await runCollect({ ...args(calls, '2026-08-15T09:00:12.000Z'), backfill: true, since: '2026-01-01' });
    const hour = { from: '2026-08-15T09:00:00.000Z', to: '2026-08-15T10:00:00.000Z' };
    expect(first.sources[0]!.queried).toEqual([hour]);
    expect(first.sources[0]!.window).toEqual(hour);
    expect(first.sources[0]!.recordsWritten).toBe(1);
    expect(first.degraded).toBe(false);
    const entry = (await sink.readManifest(ORG_ID, 1))!.sources[0]!;
    expect(entry.achieved).toBeUndefined();

    const second = await runCollect(args(calls, '2026-08-15T09:40:00.000Z'));
    expect(second.sources[0]!.recordsWritten).toBe(0);
    expect(second.sources[0]!.recordsDeduped).toBe(1);
    expect(calls).toEqual(['/limits/', '/limits/']);

    const nextHour = await runCollect(args(calls, '2026-08-15T10:05:00.000Z'));
    expect(nextHour.sources[0]!.recordsWritten).toBe(1);
  });

  it('lastWritten is the stored sample time (payload.sampled_at); a deduped run moves lastSuccess only', async () => {
    const calls: string[] = [];
    await runCollect(args(calls, '2026-08-15T09:00:12.000Z'));
    await runCollect(args(calls, '2026-08-15T09:40:00.000Z'));
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    const file = (await sink.readManifest(ORG_ID, 1))!.sources[0]!.files[0]!.path;
    const stored = JSON.parse((await sink.readFile(file)).toString('utf8').trim()) as {
      payload: { sampled_at: string };
    };
    expect(summary!.lastWritten).toBe(stored.payload.sampled_at);
    expect(summary!.lastWritten).toBe('2026-08-15T09:00:12.000Z');
    expect(summary!.lastSuccess).toBe('2026-08-15T09:40:00.000Z');
  });

  it('reports a run without a REST client as degraded, with the degradation on the manifest', async () => {
    const result = await runCollect({ ...args([], '2026-08-15T09:00:12.000Z'), rest: undefined });
    expect(result.degraded).toBe(true);
    expect(result.sources[0]!.status).toBe('failed');
    expect(result.sources[0]!.degradations[0]!.code).toBe('NO_REST_CLIENT');
    expect((await sink.readManifest(ORG_ID, 1))!.sources[0]!.achieved).toEqual([]);
  });
});
