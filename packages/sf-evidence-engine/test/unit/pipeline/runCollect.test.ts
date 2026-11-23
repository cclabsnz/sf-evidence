import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveReader } from '../../../src/archive/reader.js';
import { LocalSink } from '../../../src/sinks/local.js';
import { planRounds, planWindows, ROUND_MS, runCollect } from '../../../src/pipeline/runCollect.js';
import { verifyChain } from '../../../src/chain/verifier.js';
import { ORG_ID } from '../../../src/testing/specVectors.js';
import { buildBatch, manifestHash } from '../../../src/chain/manifestBuilder.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import { mergeWindows } from '../../../src/lib/windows.js';
import type { SoqlClient } from '@cclabsnz/sf-core';
import { sfApiError } from '../../fixtures/httpApiError.js';
import type { Sink } from '../../../src/types/sink.js';

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
    // A 180-day first run is committed in 7-day rounds: 26 manifests, the first at genesis.
    expect(result.manifests).toHaveLength(26);
    expect(result.manifests[0]!.seq).toBe(1);
    expect(result.manifests[0]!.prev).toBe(`sha256:${'0'.repeat(64)}`);
    expect(result.manifest).toEqual(result.manifests[25]);
    expect(result.degraded).toBe(false);
  });

  it('links the second run to the first', async () => {
    const first = await runCollect(base());
    const second = await runCollect(base());
    expect(second.manifest.seq).toBe(first.manifest.seq + 1);
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
    const first = await runCollect(base());
    const second = await runCollect(base());
    expect(second.manifest.seq).toBe(first.manifest.seq + 1);
    await expect(sink.readManifest(ORG_ID, second.manifest.seq)).resolves.not.toBeNull();
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
    // Two month slices fail. They fall in different 7-day rounds, so in different manifests.
    const soql = fakeSoql(async (q) => {
      if (q.includes('CreatedDate >= 2026-02-01T00:00:00Z') || q.includes('CreatedDate >= 2026-04-01T00:00:00Z')) {
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
    const manifests = await Promise.all(result.manifests.map((m) => sink.readManifest(ORG_ID, m.seq)));
    const recorded = manifests.flatMap((m) => m!.degradations);
    expect(recorded).toHaveLength(2);
    expect(recorded.map((d) => d.window?.from)).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
    expect(manifests.filter((m) => m!.degradations.length > 0)).toHaveLength(2);
    expect(result.sources[0]!.status).toBe('partial');
    expect(result.sources[0]!.achieved).toHaveLength(3);
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
    const manifest = (await sink.readManifest(ORG_ID, result.manifest.seq))!;
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
    // It failed the first of the backfill's 26 rounds, and was given none of the rest.
    expect(result.sinks[1]).toMatchObject({ id: 'git', written: false, error: 'round 1 of 26 (seq 1): disk full' });
    expect(result.manifests).toHaveLength(26);
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

    // The gap is cut at the 7-day round boundary from its start (23 February), then the
    // incremental window comes in a round of its own; the empty rounds between are dropped.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain('CreatedDate >= 2026-02-16T10:00:00Z');
    expect(seen[0]).toContain('CreatedDate < 2026-02-23T10:00:00Z');
    expect(seen[1]).toContain('CreatedDate < 2026-03-01T00:00:00Z');
    expect(seen[2]).toContain('CreatedDate >= 2026-08-15T08:45:00Z');

    expect(second.manifests).toHaveLength(3);
    const entries = await Promise.all(
      second.manifests.map(async (m) => (await sink.readManifest(ORG_ID, m.seq))!.sources[0]!),
    );
    for (const e of entries) expect(e.status).toBe('complete');
    expect(entries.map((e) => e.window)).toEqual([
      { from: '2026-02-16T10:00:00.000Z', to: '2026-02-23T10:00:00.000Z' },
      { from: '2026-02-23T10:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
      { from: '2026-08-15T08:45:00.000Z', to: '2026-08-15T10:00:00.000Z' },
    ]);
    // The run did not query March to August: the result's spanning window must not be read as
    // coverage, and `achieved` says exactly what was.
    expect(second.sources[0]!.status).toBe('complete');
    expect(second.sources[0]!.window).toEqual({ from: '2026-02-16T10:00:00.000Z', to: '2026-08-15T10:00:00.000Z' });
    expect(second.sources[0]!.achieved).toEqual([
      { from: '2026-02-16T10:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
      { from: '2026-08-15T08:45:00.000Z', to: '2026-08-15T10:00:00.000Z' },
    ]);
    expect(second.sources[0]!.queried).toEqual(second.sources[0]!.achieved);
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
    const entries = await Promise.all(
      result.manifests.map(async (m) => (await sink.readManifest(ORG_ID, m.seq))!.sources[0]!),
    );
    expect(s.status).toBe('partial');
    expect(s.queried).toEqual([{ from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }]);
    expect(s.achieved.length).toBeGreaterThan(0);
    expect(s.achieved).not.toEqual(s.queried);
    // What the manifests record as covered, round by round, merged.
    expect(s.achieved).toEqual(mergeWindows(entries.flatMap((e) => e.achieved ?? [e.window])));
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
    // Refreshed after the last of the backfill's 26 rounds.
    expect(cache.seq).toBe(26);
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
    // The gap, cut at its 7-day round boundary, then the incremental window.
    expect(seen).toHaveLength(3);
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

describe('planRounds', () => {
  const at = (iso: string) => Date.parse(iso);
  const len = (w: { from: string; to: string }) => at(w.to) - at(w.from);
  const TO = '2026-08-15T09:00:00.000Z';
  const FROM20 = '2026-07-26T09:00:00.000Z';

  it('splits a 20-day event window into 3 contiguous rounds of at most 7 days', () => {
    const rounds = planRounds([{ source: 'login-history', kind: 'event', windows: [{ from: FROM20, to: TO }] }]);
    expect(ROUND_MS).toBe(7 * 86_400_000);
    expect(rounds).toHaveLength(3);
    const pieces = rounds.flatMap((r) => r.flatMap((e) => e.windows));
    expect(pieces[0]!.from).toBe(FROM20);
    expect(pieces.at(-1)!.to).toBe(TO);
    for (let i = 1; i < pieces.length; i += 1) expect(pieces[i]!.from).toBe(pieces[i - 1]!.to);
    for (const p of pieces) expect(len(p)).toBeLessThanOrEqual(ROUND_MS);
    expect(pieces.map((p) => p.from)).toEqual([FROM20, '2026-08-02T09:00:00.000Z', '2026-08-09T09:00:00.000Z']);
  });

  it('puts a short window ending at the same instant only in the last round, and snapshots last', () => {
    const rounds = planRounds([
      { source: 'limits', kind: 'snapshot', windows: [{ from: '2026-08-15T09:00:00.000Z', to: '2026-08-15T10:00:00.000Z' }] },
      { source: 'login-history', kind: 'event', windows: [{ from: FROM20, to: TO }] },
      { source: 'audit-trail', kind: 'event', windows: [{ from: '2026-08-14T09:00:00.000Z', to: TO }] },
    ]);
    expect(rounds).toHaveLength(3);
    expect(rounds[0]!.map((e) => e.source)).toEqual(['login-history']);
    expect(rounds[1]!.map((e) => e.source)).toEqual(['login-history']);
    expect(rounds[2]!.map((e) => e.source).sort()).toEqual(['audit-trail', 'limits', 'login-history']);
    expect(rounds[2]!.find((e) => e.source === 'audit-trail')!.windows).toEqual([
      { from: '2026-08-14T09:00:00.000Z', to: TO },
    ]);
  });

  it('makes one round holding the snapshot sources when there are no event windows', () => {
    const hour = { from: '2026-08-15T09:00:00.000Z', to: '2026-08-15T10:00:00.000Z' };
    expect(planRounds([{ source: 'limits', kind: 'snapshot', windows: [hour] }])).toEqual([
      [{ source: 'limits', windows: [hour] }],
    ]);
  });

  it('drops rounds with no pieces between two far-apart windows', () => {
    const rounds = planRounds([
      {
        source: 'audit-trail',
        kind: 'event',
        windows: [
          { from: '2026-02-16T10:00:00.000Z', to: '2026-02-18T00:00:00.000Z' },
          { from: '2026-08-15T08:45:00.000Z', to: '2026-08-15T10:00:00.000Z' },
        ],
      },
    ]);
    expect(rounds).toHaveLength(2);
  });
});

describe('runCollect in 7-day rounds', () => {
  let root: string;
  let sink: LocalSink;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-rounds-'));
    sink = new LocalSink(root);
    await sink.init();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const NOW = new Date('2026-08-15T09:00:00.000Z');
  const SINCE20 = '2026-07-26T09:00:00.000Z';
  const ROUND2 = '2026-08-02T09:00:00Z';

  const apiErr = (errorCode: string, message = 'boom') =>
    Object.assign(new Error(message), { errorCode, statusCode: 400, name: 'ApiError' });

  /** Invented values only. */
  const loginRow = (id: string, loginTime: string): Record<string, unknown> => ({
    Id: id,
    UserId: '0055j00000AaBbCcAAG',
    LoginTime: loginTime,
    LoginType: 'Application',
    LoginSubType: null,
    Status: 'Success',
    Application: 'Browser',
    Browser: 'Firefox 140',
    Platform: 'Linux',
    SourceIp: '203.0.113.10',
    CountryIso: 'NZ',
    LoginGeoId: null,
    LoginUrl: 'acme.my.salesforce.com',
    NetworkId: null,
    ApiType: null,
    ApiVersion: null,
    ClientVersion: null,
    AuthenticationServiceId: null,
    CipherSuite: null,
    TlsProtocol: 'TLS 1.3',
    OptionsIsGet: false,
    OptionsIsPost: true,
    ForwardedForIp: null,
    AuthMethodReference: null,
    AuthContextClassRef: null,
  });

  /** The `from` of a SOQL query's window, as the query spells it. */
  const fromOf = (q: string) => /(?:LoginTime|CreatedDate) >= (\S+)/.exec(q)?.[1];

  const args = (over: Record<string, unknown> = {}) => ({
    orgId: ORG_ID,
    sources: ['login-history' as const],
    sinks: [sink] as Sink[],
    soql: fakeSoql(async () => []),
    now: NOW,
    since: SINCE20,
    ...over,
  });

  /** A sink that delegates to `inner`, logging and optionally failing putBatch. */
  const wrap = (inner: LocalSink, log: string[], failOn?: (seq: number) => boolean, id = inner.id): Sink => {
    const proxy = Object.create(inner) as Sink & { id: string };
    Object.defineProperty(proxy, 'id', { value: id });
    proxy.putBatch = async (batch) => {
      log.push(`put ${batch.manifest.seq}`);
      if (failOn?.(batch.manifest.seq)) throw new Error('disk full');
      return inner.putBatch(batch);
    };
    return proxy;
  };

  it('writes one manifest per round on a 20-day backfill, chained from genesis', async () => {
    const result = await runCollect(args());
    expect(result.manifests).toHaveLength(3);
    expect(result.manifests.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(result.manifests[0]!.prev).toBe(GENESIS_PREV);
    expect(result.manifests[1]!.prev).toBe(result.manifests[0]!.hash);
    expect(result.manifests[2]!.prev).toBe(result.manifests[1]!.hash);
    expect(result.manifest).toEqual(result.manifests[2]);
    for (const m of result.manifests) {
      expect(manifestHash((await sink.readManifest(ORG_ID, m.seq))!)).toBe(m.hash);
    }
    expect((await sink.head(ORG_ID))!.seq).toBe(3);
  });

  it('writes a round before it collects the next one', async () => {
    const log: string[] = [];
    const soql = fakeSoql(async (q) => {
      log.push(`query ${fromOf(q)}`);
      return [];
    });
    await runCollect(args({ soql, sinks: [wrap(sink, log)] }));
    expect(log.indexOf('put 1')).toBeGreaterThan(-1);
    expect(log.indexOf(`query ${ROUND2}`)).toBeGreaterThan(log.indexOf('put 1'));
    expect(log.indexOf('put 2')).toBeGreaterThan(log.indexOf(`query ${ROUND2}`));
  });

  it('writes exactly one manifest on a 1-day incremental run', async () => {
    const first = await runCollect(args({ since: undefined }));
    expect(first.manifests).toHaveLength(26);
    const result = await runCollect(args({ since: undefined, now: new Date('2026-08-16T09:00:00.000Z') }));
    expect(result.manifests).toHaveLength(1);
    expect(result.manifest.seq).toBe(27);
  });

  it('spreads a 180-day login-history backfill over 26 rounds, with audit-trail only in the last', async () => {
    // The archive already covers audit-trail to an hour ago, and has no login-history.
    const anHourAgo = '2026-08-15T08:00:00.000Z';
    await sink.putBatch(
      buildBatch({
        orgId: ORG_ID,
        runId: '01K3QF8H2N0000000000000001',
        createdAt: anHourAgo,
        collectedAt: anHourAgo,
        prevManifestHash: GENESIS_PREV,
        seq: 1,
        outcomes: [
          {
            source: 'audit-trail',
            status: 'complete',
            window: { from: '2026-02-16T08:00:00.000Z', to: anHourAgo },
            achieved: [{ from: '2026-02-16T08:00:00.000Z', to: anHourAgo }],
            records: [],
          },
        ],
        degradations: [],
      }),
    );

    const result = await runCollect(
      args({ since: undefined, sources: ['audit-trail' as const, 'login-history' as const] }),
    );

    expect(result.manifests).toHaveLength(26);
    expect(result.manifests[0]!.seq).toBe(2);
    const manifests = await Promise.all(result.manifests.map((m) => sink.readManifest(ORG_ID, m.seq)));
    manifests.slice(0, -1).forEach((m) => expect(m!.sources.map((s) => s.source)).toEqual(['login-history']));
    expect(manifests.at(-1)!.sources.map((s) => s.source)).toEqual(['audit-trail', 'login-history']);
    const login = manifests.map((m) => m!.sources.find((s) => s.source === 'login-history')!.window);
    expect(login[0]!.from).toBe('2026-02-16T09:00:00.000Z');
    expect(login.at(-1)!.to).toBe(NOW.toISOString());
    for (let i = 1; i < login.length; i += 1) expect(login[i]!.from).toBe(login[i - 1]!.to);
  });

  it('keeps the rounds it committed when the canonical sink fails partway, and resumes after them', async () => {
    const log: string[] = [];
    const err = await runCollect(
      args({ since: undefined, sinks: [wrap(sink, log, (seq) => seq === 3)] }),
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/No canonical sink completed this run/);
    expect((await sink.head(ORG_ID))!.seq).toBe(2);
    expect(log).toEqual(['put 1', 'put 2', 'put 3']);

    const round2 = (await sink.readManifest(ORG_ID, 2))!.sources[0]!.window;
    const seen: string[] = [];
    const resumed = await runCollect(
      args({
        since: undefined,
        soql: fakeSoql(async (q) => {
          seen.push(q);
          return [];
        }),
      }),
    );
    const overlap = new Date(Date.parse(round2.to) - 15 * 60_000).toISOString();
    expect(resumed.sources[0]!.queried).toEqual([{ from: overlap, to: NOW.toISOString() }]);
    expect(resumed.manifests[0]!.seq).toBe(3);
    expect(resumed.manifests[0]!.prev).toBe(manifestHash((await sink.readManifest(ORG_ID, 2))!));
  });

  it('writes an id returned in two adjacent rounds once', async () => {
    const soql = fakeSoql(async (q) => {
      const from = fromOf(q);
      if (from === '2026-08-01T00:00:00Z' || from === ROUND2) {
        return [loginRow('0Ya5j00000LhIsDUPAAA', '2026-08-02T09:00:00.000+0000')];
      }
      return [];
    });
    const result = await runCollect(args({ soql }));
    expect(result.sources[0]!.recordsFetched).toBe(2);
    expect(result.sources[0]!.recordsWritten).toBe(1);
    expect(result.sources[0]!.recordsDeduped).toBe(1);

    // On a dry run nothing is on disk for round 2's knownSourceIds to find: only the ids this
    // run carried across rounds can dedupe it.
    const dryRoot = await mkdtemp(join(tmpdir(), 'sf-evidence-dry-'));
    try {
      const dry = await runCollect(args({ soql, dryRun: true, sinks: [new LocalSink(dryRoot)] }));
      expect(dry.sources[0]!.recordsFetched).toBe(2);
      expect(dry.sources[0]!.recordsWritten).toBe(1);
      expect(dry.sources[0]!.recordsDeduped).toBe(1);
    } finally {
      await rm(dryRoot, { recursive: true, force: true });
    }
  });

  it('dry-runs a 20-day backfill as 3 chained manifests and writes nothing', async () => {
    const log: string[] = [];
    const result = await runCollect(args({ dryRun: true, sinks: [wrap(sink, log)] }));
    expect(log).toEqual([]);
    expect(result.manifests.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(result.manifests[0]!.prev).toBe(GENESIS_PREV);
    expect(result.manifests[1]!.prev).toBe(result.manifests[0]!.hash);
    expect(result.manifests[2]!.prev).toBe(result.manifests[1]!.hash);
    await expect(sink.head(ORG_ID)).resolves.toBeNull();
  });

  it('records an unreadable LoginHistory as degraded in every round, never as covered', async () => {
    const soql = fakeSoql(async (q) => {
      if (q.includes('FROM LoginHistory')) throw apiErr('INSUFFICIENT_ACCESS', 'no access');
      return [ROW];
    });
    const result = await runCollect(
      args({ soql, sources: ['audit-trail' as const, 'login-history' as const] }),
    );

    expect(result.manifests).toHaveLength(3);
    for (const m of result.manifests) {
      const manifest = (await sink.readManifest(ORG_ID, m.seq))!;
      expect(manifest.sources.find((s) => s.source === 'login-history')!.status).toBe('degraded');
    }
    const audit = result.sources.find((s) => s.source === 'audit-trail')!;
    const login = result.sources.find((s) => s.source === 'login-history')!;
    expect(audit.recordsWritten).toBe(1);
    expect(login.status).toBe('degraded');
    expect(result.degraded).toBe(true);

    const summaries = await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });
    expect(summaries.find((s) => s.source === 'login-history')?.coverage ?? []).toEqual([]);
    expect(summaries.find((s) => s.source === 'audit-trail')!.coverage).toEqual([
      { from: '2026-07-26T09:00:00.000Z', to: NOW.toISOString() },
    ]);
  });

  it('records a LoginHistory denied with the real jsforce error shape as degraded, and still commits audit-trail', async () => {
    const soql = fakeSoql(async (q) => {
      if (q.includes('FROM LoginHistory')) {
        throw sfApiError('INSUFFICIENT_ACCESS', 'Insufficient privileges to access LoginHistory');
      }
      return [ROW];
    });
    const result = await runCollect(
      args({ soql, sources: ['audit-trail' as const, 'login-history' as const] }),
    );

    expect(result.manifests.length).toBeGreaterThan(0);
    for (const m of result.manifests) {
      const manifest = (await sink.readManifest(ORG_ID, m.seq))!;
      const entry = manifest.sources.find((s) => s.source === 'login-history');
      if (entry) {
        expect(entry.status).toBe('degraded');
        expect(entry.achieved).toEqual([]);
      }
    }
    const audit = result.sources.find((s) => s.source === 'audit-trail')!;
    const login = result.sources.find((s) => s.source === 'login-history')!;
    expect(audit.status).toBe('complete');
    expect(audit.recordsWritten).toBe(1);
    expect(login.status).toBe('degraded');
    expect(login.degradations[0]).toMatchObject({ code: 'INSUFFICIENT_ACCESS' });
    expect(login.degradations[0]!.remediation).toContain('MonitorLoginHistory');
    // The exit-4 path: collect exits DEGRADED exactly when result.degraded is true.
    expect(result.degraded).toBe(true);
    expect((await sink.head(ORG_ID))!.seq).toBe(result.manifest.seq);

    const summaries = await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });
    expect(summaries.find((s) => s.source === 'login-history')?.coverage ?? []).toEqual([]);
    expect(summaries.find((s) => s.source === 'audit-trail')!.coverage).toEqual([
      { from: SINCE20, to: NOW.toISOString() },
    ]);
  });

  it('issues the rejected versioned-field query once per run and records the downgrade in every round', async () => {
    const widths: number[] = [];
    const soql = fakeSoql(async (q) => {
      const width = q.slice('SELECT '.length, q.indexOf(' FROM ')).split(', ').length;
      widths.push(width);
      if (width === 25) throw apiErr('INVALID_FIELD', "No such column 'AuthContextClassRef'");
      return [];
    });
    const result = await runCollect(args({ soql }));

    expect(widths.filter((w) => w === 25)).toHaveLength(1);
    expect(widths.filter((w) => w === 22).length).toBeGreaterThan(1);
    expect(result.manifests).toHaveLength(3);
    for (const m of result.manifests) {
      const manifest = (await sink.readManifest(ORG_ID, m.seq))!;
      const d = manifest.degradations.find((x) => x.code === 'INVALID_FIELD');
      expect(d?.fieldsDropped).toEqual(['ForwardedForIp', 'AuthMethodReference', 'AuthContextClassRef']);
    }
    expect(result.sources[0]!.status).toBe('complete');
  });

  it('reports partial for a source whose rounds were partial, degraded and complete', async () => {
    const soql = fakeSoql(async (q) => {
      const from = fromOf(q);
      // Round 1's second slice (August), and round 2's only slice.
      if (from === '2026-08-01T00:00:00Z' || from === ROUND2) throw apiErr('INSUFFICIENT_ACCESS');
      return [];
    });
    const result = await runCollect(args({ soql }));
    const statuses = await Promise.all(
      result.manifests.map(async (m) => (await sink.readManifest(ORG_ID, m.seq))!.sources[0]!.status),
    );
    expect(statuses).toEqual(['partial', 'degraded', 'complete']);
    expect(result.sources[0]!.status).toBe('partial');
  });

  it('gives each round its own record file, so two rounds in one month both verify', async () => {
    let n = 0;
    const soql = fakeSoql(async (q) => {
      const from = fromOf(q)!;
      n += 1;
      // One row inside each queried window, so rounds 2 and 3 both write August.
      const at = new Date(Date.parse(from.replace('Z', '.000Z')) + 60_000).toISOString();
      return [loginRow(`0Ya5j00000LhIs${String(n).padStart(2, '0')}AAA`, at.replace('Z', '+0000'))];
    });
    const result = await runCollect(args({ soql }));

    const files = result.sources[0]!.files;
    expect(new Set(files).size).toBe(files.length);
    expect(files.filter((f) => f.includes('month=08')).length).toBeGreaterThanOrEqual(3);
    // Round 1's file name is unchanged; later rounds carry a suffix.
    const first = (await sink.readManifest(ORG_ID, 1))!.sources[0]!.files.map((f) => f.path);
    for (const f of first) expect(f).not.toMatch(/-r\d\d\.ndjson$/);
    const third = (await sink.readManifest(ORG_ID, 3))!.sources[0]!.files.map((f) => f.path);
    for (const f of third) expect(f).toMatch(/-r03\.ndjson$/);

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });
    expect(report.breaks).toEqual([]);
    expect(report.chain.state).toBe('verified');
    expect(report.manifestsChecked).toBe(3);
  });

  it('treats a sink that returns written: false like one that threw, and reports no stale commit', async () => {
    const root2 = await mkdtemp(join(tmpdir(), 'sf-evidence-rounds3-'));
    try {
      const other = new LocalSink(root2);
      await other.init();
      const log: string[] = [];
      const quiet = Object.create(other) as Sink & { id: string };
      Object.defineProperty(quiet, 'id', { value: 'git' });
      quiet.putBatch = async (batch) => {
        log.push(`put ${batch.manifest.seq}`);
        if (batch.manifest.seq === 2) return { written: false, manifestSeq: 2, manifestHash: '' };
        const out = await other.putBatch(batch);
        return { ...out, commit: `c${batch.manifest.seq}` };
      };
      const result = await runCollect(args({ sinks: [sink, quiet] }));

      expect(log).toEqual(['put 1', 'put 2']);
      expect(result.sinks[1]!.written).toBe(false);
      expect(result.sinks[1]!.error).toBe(
        'round 2 of 3 (seq 2): the sink reported the batch was not written; earlier rounds were written to this sink',
      );
      // Round 1 was committed, but the sink did not take the run: no commit reads as its anchor.
      expect(result.sinks[1]!.commit).toBeUndefined();
      expect(result.degraded).toBe(true);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  it('drops a sink that failed a round from the later rounds, and reports it not written', async () => {
    const root2 = await mkdtemp(join(tmpdir(), 'sf-evidence-rounds2-'));
    try {
      const other = new LocalSink(root2);
      await other.init();
      const log: string[] = [];
      const result = await runCollect(
        args({ sinks: [sink, wrap(other, log, (seq) => seq === 2, 'git')] }),
      );

      expect(log).toEqual(['put 1', 'put 2']);
      expect((await other.head(ORG_ID))!.seq).toBe(1);
      expect((await sink.head(ORG_ID))!.seq).toBe(3);
      expect(result.sinks[0]).toMatchObject({ id: 'local', written: true });
      expect(result.sinks[1]!.written).toBe(false);
      expect(result.sinks[1]!.error).toMatch(/round 2 of 3 \(seq 2\): disk full/);
      expect(result.degraded).toBe(true);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });
});
