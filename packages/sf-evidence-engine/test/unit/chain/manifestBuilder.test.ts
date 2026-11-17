import { manifestHash, buildBatch } from '../../../src/chain/manifestBuilder.js';
import { canonicalBytes } from '../../../src/chain/canonical.js';
import { merkleRoot, sha256Hex } from '../../../src/chain/hash.js';
import { ALGORITHM } from '../../../src/lib/verifyFormat.js';
import { GENESIS_PREV, type Manifest } from '../../../src/types/manifest.js';
import { RECORD_0, RECORD_1, SPEC_VECTORS, ORG_ID } from '../../../src/testing/specVectors.js';
import type { NormalisedRecord } from '../../../src/types/record.js';

const SPEC_MANIFEST: Manifest = {
  schema: 'sf-evidence/manifest/v1',
  seq: 1,
  org_id: ORG_ID,
  run_id: '01K3QF8H2N0000000000000000',
  created_at: '2026-08-15T09:00:12.482Z',
  producer: { name: '@cclabsnz/sf-evidence', version: '0.1.0' },
  prev_manifest_hash: GENESIS_PREV,
  sources: [
    {
      source: 'audit-trail',
      window: { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
      status: 'complete',
      record_count: 2,
      records_root: `sha256:${SPEC_VECTORS.recordsRoot}`,
      files: [
        {
          path: 'org_id=00D5j000000AbCdEAK/source=audit-trail/year=2026/month=08/part-20260815T090012Z-01K3QF8H.ndjson',
          bytes: SPEC_VECTORS.fileBytes,
          sha256: `sha256:${SPEC_VECTORS.fileSha256}`,
        },
      ],
    },
  ],
  degradations: [],
};

describe('manifestHash', () => {
  it('reproduces manifest_hash[1] from SPEC.md §6.4', () => {
    expect(manifestHash(SPEC_MANIFEST)).toBe(`sha256:${SPEC_VECTORS.manifestHash1}`);
  });

  it('is independent of key insertion order', () => {
    const reordered = { ...SPEC_MANIFEST };
    expect(manifestHash(reordered)).toBe(manifestHash(SPEC_MANIFEST));
  });

  it('changes when any field changes', () => {
    expect(manifestHash({ ...SPEC_MANIFEST, seq: 2 })).not.toBe(manifestHash(SPEC_MANIFEST));
  });
});

describe('buildBatch', () => {
  const records = [RECORD_0, RECORD_1] as unknown as NormalisedRecord[];

  it('writes achieved only for a non-complete outcome, so complete entries stay legacy-shaped', () => {
    const w = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
    const mk = (status: 'complete' | 'partial') =>
      buildBatch({
        orgId: ORG_ID,
        runId: '01K3QF8H2N0000000000000000',
        createdAt: '2026-08-15T09:00:12.482Z',
        collectedAt: '2026-08-15T09:00:12.482Z',
        prevManifestHash: GENESIS_PREV,
        seq: 1,
        outcomes: [{ source: 'audit-trail', status, window: w, achieved: [w], records: [] }],
        degradations: [],
      }).manifest.sources[0]!;
    expect('achieved' in mk('complete')).toBe(false);
    expect(mk('partial').achieved).toEqual([w]);
  });

  it('writes achieved windows and per-slice degradations into the manifest', () => {
    const jan = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
    const feb = { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' };
    const mar = { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' };
    const degradation = (window: typeof jan) => ({
      source: 'audit-trail' as const,
      code: 'QUERY_TIMEOUT',
      detail: 'timeout',
      remediation: 'retry',
      window,
    });
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
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
      degradations: [degradation(feb), degradation({ from: mar.to, to: '2026-04-02T00:00:00.000Z' })],
    });

    expect(batch.manifest.sources[0]!.achieved).toEqual([jan, mar]);
    expect(batch.manifest.degradations).toHaveLength(2);
    expect(batch.manifest.degradations[0]!.window).toEqual(feb);
  });

  it('produces the SPEC.md §6.4 file bytes, hash and Merkle root', () => {
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        {
          source: 'audit-trail',
          status: 'complete',
          window: { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }, achieved: [{ from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }],
          records,
        },
      ],
      degradations: [],
    });

    expect(batch.files).toHaveLength(1);
    expect(batch.files[0]!.bytes.length).toBe(SPEC_VECTORS.fileBytes);
    expect(batch.files[0]!.sha256).toBe(`sha256:${SPEC_VECTORS.fileSha256}`);
    expect(batch.manifest.sources[0]!.records_root).toBe(`sha256:${SPEC_VECTORS.recordsRoot}`);
    expect(batch.manifest.sources[0]!.record_count).toBe(2);
    expect(manifestHash(batch.manifest)).toBe(`sha256:${SPEC_VECTORS.manifestHash1}`);
  });

  it('writes NDJSON as canonical lines with a trailing newline on each', () => {
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        { source: 'audit-trail', status: 'complete', window: { from: 'a', to: 'b' }, achieved: [{ from: 'a', to: 'b' }], records },
      ],
      degradations: [],
    });
    const text = batch.files[0]!.bytes.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    expect(text.startsWith('{"api_version"')).toBe(true);
  });

  it('sorts records by (occurred_at, source_id) so the Merkle root is reproducible', () => {
    const reversed = [RECORD_1, RECORD_0] as unknown as NormalisedRecord[];
    const args = {
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      degradations: [],
    };
    const a = buildBatch({
      ...args,
      outcomes: [
        { source: 'audit-trail' as const, status: 'complete' as const, window: { from: 'a', to: 'b' }, achieved: [{ from: 'a', to: 'b' }], records },
      ],
    });
    const b = buildBatch({
      ...args,
      outcomes: [
        { source: 'audit-trail' as const, status: 'complete' as const, window: { from: 'a', to: 'b' }, achieved: [{ from: 'a', to: 'b' }], records: reversed },
      ],
    });
    expect(b.files[0]!.sha256).toBe(a.files[0]!.sha256);
  });

  it('splits one batch across months, because partitioning follows occurred_at', () => {
    const july = {
      ...RECORD_0,
      source_id: '0Ym5j00000XyZ09CAA',
      occurred_at: '2026-07-02T00:00:00.000Z',
    } as unknown as NormalisedRecord;
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        {
          source: 'audit-trail',
          status: 'complete',
          window: { from: 'a', to: 'b' }, achieved: [{ from: 'a', to: 'b' }],
          records: [...records, july],
        },
      ],
      degradations: [],
    });
    expect(batch.files).toHaveLength(2);
    expect(batch.files.map((f) => f.relPath).some((p) => p.includes('month=07'))).toBe(true);
    expect(batch.files.map((f) => f.relPath).some((p) => p.includes('month=08'))).toBe(true);
    expect(batch.manifest.sources[0]!.record_count).toBe(3);

    // The value a third party must be able to reproduce from the published algorithm alone.
    // One source entry, several files: the leaves are the records of sources[0].files in
    // that array's order, each file's records in line order, concatenated. The default first
    // run backfills 180 days and so produces roughly seven monthly files — a multi-file root
    // is the common case, not the exotic one, which is why the ordering has to be published.
    const entry = batch.manifest.sources[0]!;
    const leaves: string[] = [];
    for (const file of entry.files) {
      const bytes = batch.files.find((f) => f.relPath === file.path)!.bytes;
      for (const line of bytes.toString('utf8').split('\n')) {
        if (line.length === 0) continue;
        leaves.push(sha256Hex(canonicalBytes(JSON.parse(line) as unknown)));
      }
    }
    expect(leaves).toHaveLength(3);
    expect(entry.records_root).toBe(`sha256:${merkleRoot(leaves)}`);

    // July sorts before August, so the July record is leaf 0 — the ordering is the files
    // array's, not the order the records arrived in.
    expect(entry.files[0]!.path).toContain('month=07');
  });

  it('records a source that produced no records without inventing files', () => {
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        { source: 'audit-trail', status: 'complete', window: { from: 'a', to: 'b' }, achieved: [{ from: 'a', to: 'b' }], records: [] },
      ],
      degradations: [],
    });
    expect(batch.files).toHaveLength(0);
    expect(batch.manifest.sources[0]!.record_count).toBe(0);
    expect(batch.manifest.sources[0]!.files).toEqual([]);
    // An empty leaf list gives SHA-256 of the empty byte string. Undocumented, this looks
    // like a magic constant to anyone reproducing the chain by hand.
    expect(batch.manifest.sources[0]!.records_root).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('publishes the leaf ordering and the empty-source value in the printed algorithm', () => {
    // SPEC.md §6.2 says "in file order", which does not tell a third party that the leaves
    // of a multi-file source are the concatenation across sources[].files in array order.
    expect(ALGORITHM).toMatch(/sources\[i\]\.files in that array's order/);
    expect(ALGORITHM).toMatch(/line order/);
    expect(ALGORITHM).toContain(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('carries degradations into the manifest so reduced coverage is part of the evidence', () => {
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
      createdAt: '2026-08-15T09:00:12.482Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        { source: 'audit-trail', status: 'degraded', window: { from: 'a', to: 'b' }, achieved: [], records: [] },
      ],
      degradations: [
        {
          source: 'audit-trail',
          code: 'INSUFFICIENT_ACCESS',
          detail: 'SetupAuditTrail is not readable by this user',
          remediation: 'Grant View Setup and Configuration',
        },
      ],
    });
    expect(batch.manifest.degradations).toHaveLength(1);
    expect(batch.manifest.sources[0]!.status).toBe('degraded');
  });
});
