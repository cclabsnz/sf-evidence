import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { LocalSink } from '../../../src/sinks/local.js';
import { ArchiveReader, achievedOf } from '../../../src/archive/reader.js';
import { buildBatch, manifestHash } from '../../../src/chain/manifestBuilder.js';
import { canonicalBytes } from '../../../src/chain/canonical.js';
import { sha256Hex } from '../../../src/chain/hash.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import { RECORD_0, RECORD_1, ORG_ID } from '../../../src/testing/specVectors.js';
import type { NormalisedRecord } from '../../../src/types/record.js';
import type { TimeWindow } from '../../../src/types/manifest.js';

const records = [RECORD_0, RECORD_1] as unknown as NormalisedRecord[];
const ALL_OF_2026: TimeWindow = { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' };

describe('ArchiveReader', () => {
  let root: string;
  let sink: LocalSink;
  let seq = 0;
  let prev = GENESIS_PREV;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-'));
    sink = new LocalSink(root);
    await sink.init();
    seq = 0;
    prev = GENESIS_PREV;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(
    status: 'complete' | 'degraded' = 'complete',
    window: TimeWindow = { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
  ) {
    seq += 1;
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: `01K3QF8H2N000000000000000${seq}`,
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: prev,
      seq,
      outcomes: [
        {
          source: 'audit-trail',
          status,
          window,
          achieved: status === 'complete' ? [window] : [],
          records: status === 'complete' ? records : [],
        },
      ],
      degradations: [],
    });
    const out = await sink.putBatch(batch);
    prev = out.manifestHash;
  }

  it('returns an empty id set for an empty archive', async () => {
    await expect(new ArchiveReader(sink).knownSourceIds(ORG_ID, 'audit-trail', ALL_OF_2026)).resolves.toEqual(
      new Set(),
    );
  });

  it('collects every archived source id for dedupe', async () => {
    await seed();
    const ids = await new ArchiveReader(sink).knownSourceIds(ORG_ID, 'audit-trail', ALL_OF_2026);
    expect(ids).toEqual(new Set(['0Ym5j00000XyZ01CAA', '0Ym5j00000XyZ02CAA']));
  });

  it('summarises last run, record count and covered window', async () => {
    await seed();
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary).toMatchObject({
      source: 'audit-trail',
      recordCount: 2,
      lastRun: '2026-08-15T09:00:12.482Z',
      coverage: [{ from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }],
    });
  });

  it('clips each entry at its manifest created_at: no run covers time after it ran', async () => {
    // A legacy entry whose window ran into the future (an unvalidated --until, or a clock
    // ahead of the org). status and the collect planner both read this summary, so clipping
    // here is what makes them agree on where coverage ends.
    await seed('complete', { from: '2026-02-16T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' });
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([{ from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:12.482Z' }]);
  });

  it('drops an entry that lies wholly after its manifest created_at', async () => {
    await seed('complete', { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([]);
  });

  it('excludes a degraded window from covered range, so it is never reported as covered', async () => {
    // C7: "we could not look" must never be recorded as "nothing happened".
    await seed('degraded');
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([]);
    expect(summary!.statuses).toEqual({ complete: 0, partial: 0, degraded: 1, failed: 0 });
  });

  it('counts the achieved sub-ranges of a partial run as coverage', async () => {
    const jan = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
    const mar = { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' };
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000001',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        {
          source: 'audit-trail',
          status: 'partial',
          window: { from: jan.from, to: mar.to },
          achieved: [jan, mar],
          records: [],
        },
      ],
      degradations: [],
    });
    await sink.putBatch(batch);

    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([jan, mar]);
    expect(summary!.lastSuccess).toBeNull();
  });

  it('reads legacy manifests exactly as before', () => {
    const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' };
    const base = { source: 'audit-trail' as const, window, record_count: 0, records_root: 'sha256:x', files: [] };
    expect(achievedOf({ ...base, status: 'complete' })).toEqual([window]);
    expect(achievedOf({ ...base, status: 'partial' })).toEqual([]);
    expect(achievedOf({ ...base, status: 'degraded' })).toEqual([]);
    expect(achievedOf({ ...base, status: 'failed' })).toEqual([]);
  });

  it('takes lastSuccess from the newest complete entry, not the newest run', async () => {
    await seed('complete');
    await seed('degraded');
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.lastSuccess).toBe('2026-08-15T09:00:12.482Z');
  });

  it('lastWritten ignores a complete run that stored no records', async () => {
    await seed('complete');
    seq += 1;
    const window = { from: '2026-08-15T09:00:00.000Z', to: '2026-08-15T10:00:00.000Z' };
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000009',
      createdAt: '2026-08-16T09:00:00.000Z',
      collectedAt: '2026-08-16T09:00:00.000Z',
      prevManifestHash: prev,
      seq,
      outcomes: [{ source: 'audit-trail', status: 'complete', window, achieved: [window], records: [] }],
      degradations: [],
    });
    await sink.putBatch(batch);
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.lastWritten).toBe('2026-08-15T09:00:12.482Z');
    expect(summary!.lastSuccess).toBe('2026-08-16T09:00:00.000Z');
  });

  it('returns no summaries for an org with no manifests', async () => {
    await expect(new ArchiveReader(sink).summarise(ORG_ID)).resolves.toEqual([]);
  });

  it('merges two adjacent complete windows into a single covered entry', async () => {
    await seed('complete', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    await seed('complete', { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([
      { from: '2026-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
    ]);
  });

  it('keeps two non-adjacent complete windows as separate covered entries, so a gap is never reported as covered', async () => {
    // Regression guard for the min/max overstatement bug: Jan and Mar are both complete,
    // but Feb was never run at all, so it must not appear as covered.
    await seed('complete', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    await seed('complete', { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' });
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
    ]);
  });

  it('merges two overlapping complete windows into a single covered entry', async () => {
    await seed('complete', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-15T00:00:00.000Z' });
    await seed('complete', { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([
      { from: '2026-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
    ]);
  });

  it('yields an empty covered list for a source with no complete windows', async () => {
    await seed('degraded');
    await seed('degraded');
    const [summary] = await new ArchiveReader(sink).summarise(ORG_ID);
    expect(summary!.coverage).toEqual([]);
  });
  it('knownSourceIds reads only partitions the window touches', async () => {
    // One batch whose records land in two month partitions: March and August.
    const march = { ...records[0]!, source_id: '0Ym5j00000XyZ03CAA', occurred_at: '2026-03-02T00:00:00.000Z' };
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000001',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        {
          source: 'audit-trail',
          status: 'complete',
          window: { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
          achieved: [{ from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }],
          records: [...records, march],
        },
      ],
      degradations: [],
    });
    await sink.putBatch(batch);

    const readFileSpy = jest.spyOn(sink, 'readFile');
    const ids = await new ArchiveReader(sink).knownSourceIds(ORG_ID, 'audit-trail', {
      from: '2026-08-15T08:45:00.000Z',
      to: '2026-08-15T10:00:00.000Z',
    });

    const paths = readFileSpy.mock.calls.map(([p]) => p);
    expect(paths.some((p) => p.includes('/year=2026/month=08/'))).toBe(true);
    expect(paths.some((p) => p.includes('/month=03/'))).toBe(false);
    expect(ids).toEqual(new Set(['0Ym5j00000XyZ01CAA', '0Ym5j00000XyZ02CAA']));
  });

  it('knownSourceIds reads a partition the window only touches at its first instant', async () => {
    await seed();
    const ids = await new ArchiveReader(sink).knownSourceIds(ORG_ID, 'audit-trail', {
      from: '2026-08-31T23:45:00.000Z',
      to: '2026-09-01T01:00:00.000Z',
    });
    expect(ids).toEqual(new Set(['0Ym5j00000XyZ01CAA', '0Ym5j00000XyZ02CAA']));
  });

  const cachePath = () => join(root, `org_id=${ORG_ID}`, '_state', 'coverage.json');

  it('writes coverage.json with the version, the chain head seq and the summaries', async () => {
    await seed();
    const summaries = await new ArchiveReader(sink).summarise(ORG_ID);
    const cache = JSON.parse(await readFile(cachePath(), 'utf8'));
    expect(cache).toEqual({
      version: 3,
      seq: 1,
      summaries,
      manifest_hash: manifestHash((await sink.readManifest(ORG_ID, 1))!),
      summaries_sha256: `sha256:${sha256Hex(canonicalBytes(summaries))}`,
    });
  });

  it('does not write coverage.json when asked not to persist', async () => {
    await seed();
    await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });
    await expect(readFile(cachePath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds coverage when the cache is garbage', async () => {
    await seed('complete', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    await seed('degraded');
    const fresh = await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });

    await mkdir(join(root, `org_id=${ORG_ID}`, '_state'), { recursive: true });
    await writeFile(cachePath(), '{not json');

    await expect(new ArchiveReader(sink).summarise(ORG_ID)).resolves.toEqual(fresh);
    expect(JSON.parse(await readFile(cachePath(), 'utf8'))).toMatchObject({ version: 3, seq: 2, summaries: fresh });
  });

  it.each([
    ['the wrong version (a version 2 cache was not clipped at created_at)', (s: unknown[]) => ({ version: 2, seq: 1, summaries: s })],
    ['a seq ahead of the chain head', (s: unknown[]) => ({ version: 3, seq: 99, summaries: s })],
    ['a missing summaries list', () => ({ version: 3, seq: 1 })],
  ])('rebuilds coverage when the cache has %s', async (_label, make) => {
    await seed('complete', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    const fresh = await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });
    // Poisoned summaries: if the reader trusted them, the answer would change.
    const poisoned = [{ ...fresh[0], recordCount: 12345, coverage: [] }];
    await sink.writeState(ORG_ID, 'coverage.json', JSON.stringify(make(poisoned)));

    await expect(new ArchiveReader(sink).summarise(ORG_ID)).resolves.toEqual(fresh);
    expect(JSON.parse(await readFile(cachePath(), 'utf8'))).toMatchObject({ version: 3, seq: 1, summaries: fresh });
  });

  it('rebuilds silently when reading the cache throws', async () => {
    await seed();
    const fresh = await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });
    jest.spyOn(sink, 'readState').mockRejectedValue(new Error('EACCES'));
    await expect(new ArchiveReader(sink).summarise(ORG_ID)).resolves.toEqual(fresh);
  });

  it('replays only manifests newer than the cache', async () => {
    await seed('complete', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    await seed('degraded');
    await new ArchiveReader(sink).summarise(ORG_ID);
    await seed('complete', { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });

    const readManifestSpy = jest.spyOn(sink, 'readManifest');
    const incremental = await new ArchiveReader(sink).summarise(ORG_ID);
    // Seq 2 is read once to verify the cache against the chain; only seq 3 is replayed.
    expect(readManifestSpy.mock.calls.map(([, s]) => s)).toEqual([2, 3]);
    readManifestSpy.mockRestore();
    expect(JSON.parse(await readFile(cachePath(), 'utf8')).seq).toBe(3);

    // Same answer as a full rebuild from the manifests.
    await rm(cachePath());
    await expect(new ArchiveReader(sink).summarise(ORG_ID, { persist: false })).resolves.toEqual(incremental);
    expect(incremental[0]!.coverage).toEqual([
      { from: '2026-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
    ]);
  });

  it('reads only the cached seq manifest, to verify it, when the cache is current', async () => {
    await seed();
    await seed();
    await new ArchiveReader(sink).summarise(ORG_ID);
    const readManifestSpy = jest.spyOn(sink, 'readManifest');
    await new ArchiveReader(sink).summarise(ORG_ID);
    expect(readManifestSpy.mock.calls.map(([, s]) => s)).toEqual([2]);
  });

  it('rebuilds a cache whose seq matches but whose chain was replaced', async () => {
    await seed('complete', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    await new ArchiveReader(sink).summarise(ORG_ID);
    const staleCache = await readFile(cachePath(), 'utf8');

    // A different chain of the same length, with the old cache left behind.
    await rm(join(root, `org_id=${ORG_ID}`), { recursive: true });
    seq = 0;
    prev = GENESIS_PREV;
    await seed('degraded');
    const fresh = await new ArchiveReader(sink).summarise(ORG_ID, { persist: false });
    await sink.writeState(ORG_ID, 'coverage.json', staleCache);

    await expect(new ArchiveReader(sink).summarise(ORG_ID)).resolves.toEqual(fresh);
    expect(fresh[0]!.coverage).toEqual([]);
  });

  it('rebuilds a cache whose summaries were altered without changing their shape', async () => {
    await seed();
    const fresh = await new ArchiveReader(sink).summarise(ORG_ID);
    const cache = JSON.parse(await readFile(cachePath(), 'utf8'));
    cache.summaries[0].coverage = [{ from: '2025-01-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }];
    await sink.writeState(ORG_ID, 'coverage.json', JSON.stringify(cache));

    await expect(new ArchiveReader(sink).summarise(ORG_ID)).resolves.toEqual(fresh);
  });
});
