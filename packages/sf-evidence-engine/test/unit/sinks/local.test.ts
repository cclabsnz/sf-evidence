import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSink } from '../../../src/sinks/local.js';
import { buildBatch, manifestHash } from '../../../src/chain/manifestBuilder.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import { sha256Hex } from '../../../src/chain/hash.js';
import { RECORD_0, RECORD_1, ORG_ID, SPEC_VECTORS } from '../../../src/testing/specVectors.js';
import type { NormalisedRecord } from '../../../src/types/record.js';
import type { Manifest } from '../../../src/types/manifest.js';
import type { PutOutcome } from '../../../src/types/sink.js';

const records = [RECORD_0, RECORD_1] as unknown as NormalisedRecord[];

function batch(seq: number, prev: string) {
  return buildBatch({
    orgId: ORG_ID,
    runId: '01K3QF8H2N0000000000000000',
    createdAt: '2026-08-15T09:00:12.482Z',
    collectedAt: `2026-08-15T09:0${seq}:12.482Z`,
    prevManifestHash: prev,
    seq,
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
}

describe('LocalSink', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('declares itself canonical, readable and queryable with no anchors', () => {
    const sink = new LocalSink(root);
    expect(sink.capabilities.canonical).toBe(true);
    expect(sink.capabilities.readable).toBe(true);
    expect(sink.capabilities.anchors).toEqual([]);
  });

  it('init succeeds when the root exists', async () => {
    await expect(new LocalSink(root).init()).resolves.toBeUndefined();
  });

  it('init refuses to create a missing root, and says how to create it', async () => {
    // C5: never provision infrastructure — including a directory the user did not name.
    const missing = join(root, 'does-not-exist');
    await expect(new LocalSink(missing).init()).rejects.toThrow(/does not exist.*mkdir/is);
    await expect(readdir(missing)).rejects.toThrow();
  });

  it('head returns null for an org with no chain yet', async () => {
    await expect(new LocalSink(root).head(ORG_ID)).resolves.toBeNull();
  });

  it('writes record files, the manifest and head, and reports the sequence', async () => {
    const sink = new LocalSink(root);
    await sink.init();
    const out = await sink.putBatch(batch(1, GENESIS_PREV));

    expect(out.written).toBe(true);
    expect(out.manifestSeq).toBe(1);
    expect(out.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // head must agree with what putBatch reported — pointer and chain cannot diverge.
    // (SPEC.md §6.4's manifest hash is asserted in manifestBuilder.test.ts, where the batch
    // is built with the spec's exact collected_at. This helper varies collected_at per
    // sequence so filenames differ, which necessarily changes the manifest hash.)
    const head = await sink.head(ORG_ID);
    expect(head).toEqual({
      seq: 1,
      manifest_hash: out.manifestHash,
      updated_at: expect.any(String),
    });
  });

  it('writes the record file at the Hive path with the exact spec bytes', async () => {
    const sink = new LocalSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));

    const rel =
      'org_id=00D5j000000AbCdEAK/source=audit-trail/year=2026/month=08/part-20260815T090112Z-01K3QF8H.ndjson';
    const content = await readFile(join(root, rel));
    expect(content.length).toBe(SPEC_VECTORS.fileBytes);
    expect(sha256Hex(content)).toBe(SPEC_VECTORS.fileSha256);
  });

  it('round-trips a manifest', async () => {
    const sink = new LocalSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    const m = await sink.readManifest(ORG_ID, 1);
    expect(m?.seq).toBe(1);
    expect(m?.prev_manifest_hash).toBe(GENESIS_PREV);
  });

  it('lists manifest sequences in ascending order', async () => {
    const sink = new LocalSink(root);
    await sink.init();
    const first = await sink.putBatch(batch(1, GENESIS_PREV));
    await sink.putBatch(batch(2, first.manifestHash));
    await expect(sink.listManifests(ORG_ID)).resolves.toEqual([1, 2]);
  });

  it('refuses to overwrite an existing manifest sequence', async () => {
    // Two concurrent runs must not both claim seq N.
    const sink = new LocalSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    await expect(sink.putBatch(batch(1, GENESIS_PREV))).rejects.toThrow(/already exists/i);
  });

  it('lets exactly one of two concurrent putBatch calls for the same seq win, and leaves head consistent with the manifest on disk', async () => {
    // The up-front exists() check in putBatch is only a fast path — it cannot close the
    // check-then-write gap between two racing callers on its own. The real guard is the
    // exclusive, link()-based manifest publish. Give the two racers genuinely different
    // manifest content (different prevManifestHash) so a silent-overwrite bug would be
    // detectable as head.json disagreeing with what actually landed on disk.
    const sink = new LocalSink(root);
    await sink.init();

    const otherPrev = `sha256:${'1'.repeat(64)}`;
    const results = await Promise.allSettled([
      sink.putBatch(batch(1, GENESIS_PREV)),
      sink.putBatch(batch(1, otherPrev)),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<PutOutcome> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as Error).message).toMatch(/already exists/i);

    const winnerHash = fulfilled[0]!.value.manifestHash;
    const head = await sink.head(ORG_ID);
    expect(head?.manifest_hash).toBe(winnerHash);

    const onDisk = await sink.readManifest(ORG_ID, 1);
    expect(onDisk).not.toBeNull();
    expect(manifestHash(onDisk as Manifest)).toBe(winnerHash);
  });

  it('leaves orphan records but no manifest when the manifest write fails (invariant S1)', async () => {
    // Behavioural rather than order-spying: the invariant only matters because of what an
    // interruption leaves behind. A crash between the records and the manifest must leave
    // record files with no manifest — never a manifest pointing at files that do not exist.
    class FailAtManifest extends LocalSink {
      protected override async writeArtifactExclusive(
        relPath: string,
        bytes: Buffer,
      ): Promise<void> {
        if (relPath.includes('.manifest.json')) throw new Error('simulated interruption');
        return super.writeArtifactExclusive(relPath, bytes);
      }
    }

    const sink = new FailAtManifest(root);
    await sink.init();
    await expect(sink.putBatch(batch(1, GENESIS_PREV))).rejects.toThrow(/simulated interruption/);

    // No manifest, no head — but the record file landed and is detectable as an orphan.
    await expect(sink.listManifests(ORG_ID)).resolves.toEqual([]);
    await expect(sink.head(ORG_ID)).resolves.toBeNull();
    const orphans = await new LocalSink(root).listOrphans(ORG_ID);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.relPath).toMatch(/\.ndjson$/);
  });

  it('writes head only after the manifest, so head never points at a missing manifest', async () => {
    class FailAtHead extends LocalSink {
      protected override async writeArtifact(relPath: string, bytes: Buffer): Promise<void> {
        if (relPath.includes('head.json')) throw new Error('simulated interruption');
        return super.writeArtifact(relPath, bytes);
      }
    }

    const sink = new FailAtHead(root);
    await sink.init();
    await expect(sink.putBatch(batch(1, GENESIS_PREV))).rejects.toThrow(/simulated interruption/);

    // The manifest is durable; only the pointer is missing, and the chain is walkable without it.
    await expect(sink.listManifests(ORG_ID)).resolves.toEqual([1]);
    await expect(sink.head(ORG_ID)).resolves.toBeNull();
  });

  it('reports an unreferenced record file as an orphan', async () => {
    const sink = new LocalSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));

    const dir = join(root, 'org_id=00D5j000000AbCdEAK/source=audit-trail/year=2026/month=08');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'part-20260901T000000Z-ZZZZZZZZ.ndjson'), 'orphan\n');

    const orphans = await sink.listOrphans(ORG_ID);
    expect(orphans.map((o) => o.relPath)).toEqual([
      'org_id=00D5j000000AbCdEAK/source=audit-trail/year=2026/month=08/part-20260901T000000Z-ZZZZZZZZ.ndjson',
    ]);
  });

  it('reports no orphans when every file is referenced', async () => {
    const sink = new LocalSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    await expect(sink.listOrphans(ORG_ID)).resolves.toEqual([]);
  });

  it('describes its destination without disclosing a credential', () => {
    const d = new LocalSink(root).describe();
    expect(d.id).toBe('local');
    expect(d.location).toBe(root);
    expect(d.credentialSource).toBe('none (local filesystem)');
  });
  it('returns null for a state file that does not exist', async () => {
    await expect(new LocalSink(root).readState(ORG_ID, 'coverage.json')).resolves.toBeNull();
  });

  it('writes a state file under the org _state directory and reads it back', async () => {
    const sink = new LocalSink(root);
    await sink.writeState(ORG_ID, 'coverage.json', '{"version":1}');
    await expect(sink.readState(ORG_ID, 'coverage.json')).resolves.toBe('{"version":1}');
    await expect(readFile(join(root, `org_id=${ORG_ID}`, '_state', 'coverage.json'), 'utf8')).resolves.toBe(
      '{"version":1}',
    );
    // Atomic write: no temp file is left beside it.
    await expect(readdir(join(root, `org_id=${ORG_ID}`, '_state'))).resolves.toEqual(['coverage.json']);
  });

  it.each(['../escape.json', 'a/b.json', '', '.hidden', '..'])(
    'refuses the state name %j, which could leave the _state directory',
    async (name) => {
      const sink = new LocalSink(root);
      await expect(sink.writeState(ORG_ID, name, '{}')).rejects.toThrow(/state file name/i);
      await expect(sink.readState(ORG_ID, name)).rejects.toThrow(/state file name/i);
    },
  );

  it('does not report a state file as an orphan', async () => {
    const sink = new LocalSink(root);
    await sink.putBatch(batch(1, GENESIS_PREV));
    await sink.writeState(ORG_ID, 'coverage.ndjson', '{}');
    await expect(sink.listOrphans(ORG_ID)).resolves.toEqual([]);
  });
});
