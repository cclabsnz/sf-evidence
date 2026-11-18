import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSink } from '../../../src/sinks/local.js';
import { sha256Hex } from '../../../src/chain/hash.js';
import { manifestHash } from '../../../src/chain/manifestBuilder.js';
import { verifyExitCode } from '../../../src/lib/verifyFormat.js';
import { buildBatch } from '../../../src/chain/manifestBuilder.js';
import { verifyChain } from '../../../src/chain/verifier.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import { RECORD_0, RECORD_1, ORG_ID } from '../../../src/testing/specVectors.js';
import type { NormalisedRecord } from '../../../src/types/record.js';
import type { ChainHead, Manifest } from '../../../src/types/manifest.js';
import type {
  OrphanFile,
  PreparedBatch,
  PutOutcome,
  Sink,
  SinkCapabilities,
  SinkDescription,
  SinkId,
} from '../../../src/types/sink.js';

const records = [RECORD_0, RECORD_1] as unknown as NormalisedRecord[];

/**
 * Minimal fake Sink for exercising the missing-manifest / expectedPrev-reset path (Finding 3
 * of the Task 8 review): LocalSink.listManifests only ever lists sequence numbers whose
 * manifest file exists on disk, so it can never produce readManifest(_, seq) === null for a
 * *listed* seq. Only a fake sink can put verifyChain in that state.
 */
class FakeSink implements Sink {
  public readonly id: SinkId = 'local';
  public readonly capabilities: SinkCapabilities = {
    canonical: true,
    readable: true,
    queryable: true,
    supportsObjectLock: false,
    anchors: [],
  };

  public constructor(private readonly manifests: Map<number, Manifest | null>) {}

  public describe(): SinkDescription {
    return { id: this.id, location: 'fake', credentialSource: 'fake', anchors: [] };
  }

  public async init(): Promise<void> {}

  public queryRoot(): string | null {
    return null;
  }

  public async listOrgs(): Promise<string[]> {
    return [];
  }

  public async head(): Promise<ChainHead | null> {
    return null;
  }

  public async readManifest(_orgId: string, seq: number): Promise<Manifest | null> {
    return this.manifests.get(seq) ?? null;
  }

  public async listManifests(): Promise<number[]> {
    return [...this.manifests.keys()].sort((a, b) => a - b);
  }

  public async readFile(_relPath: string): Promise<Buffer> {
    throw new Error('FakeSink.readFile is not used by this test');
  }

  public async listOrphans(): Promise<OrphanFile[]> {
    return [];
  }

  public async putBatch(_batch: PreparedBatch): Promise<PutOutcome> {
    throw new Error('FakeSink.putBatch is not used by this test');
  }

  public async readState(): Promise<string | null> {
    return null;
  }

  public async writeState(): Promise<void> {}
}

function batch(seq: number, prev: string, recs: NormalisedRecord[] = records) {
  return buildBatch({
    orgId: ORG_ID,
    runId: '01K3QF8H2N0000000000000000',
    createdAt: `2026-08-1${seq}T09:00:12.482Z`,
    collectedAt: `2026-08-15T09:0${seq}:12.482Z`,
    prevManifestHash: prev,
    seq,
    outcomes: [
      {
        source: 'audit-trail',
        status: 'complete',
        window: { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }, achieved: [{ from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }],
        records: recs,
      },
    ],
    degradations: [],
  });
}

describe('verifyChain', () => {
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

  it('reports a valid two-link chain', async () => {
    const a = await sink.putBatch(batch(1, GENESIS_PREV));
    await sink.putBatch(batch(2, a.manifestHash));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.chain.valid).toBe(true);
    expect(report.breaks).toEqual([]);
    expect(report.manifestsChecked).toBe(2);
    expect(report.chain.head?.seq).toBe(2);
  });

  it('verifies a chain mixing legacy and new manifests with no breaks', async () => {
    // A legacy manifest has no `achieved`; it is hashed as parsed, so the next link verifies.
    const legacy = batch(1, GENESIS_PREV);
    for (const entry of legacy.manifest.sources) delete entry.achieved;
    const a = await sink.putBatch(legacy);
    await sink.putBatch(batch(2, a.manifestHash));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.breaks).toEqual([]);
    expect(report.chain.valid).toBe(true);
    expect(report.manifestsChecked).toBe(2);
  });

  it('names the anchor mode and carries its does-not-prove statement', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.anchor.mode).toBe('none');
    expect(report.anchor.doesNotProve).toMatch(/rewrite the whole chain/i);
  });

  it('reports an empty archive as NOTHING VERIFIED, never as valid', async () => {
    // A green verification of an archive that holds nothing is the exact shape of a
    // mistyped --org-id or --archive. `status` already handles the same state honestly.
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.manifestsChecked).toBe(0);
    expect(report.chain.state).toBe('empty');
    expect(report.chain.valid).toBe(false);
    expect(report.range).toBeNull();
  });

  it('detects a broken prev_manifest_hash link', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    await sink.putBatch(batch(2, 'sha256:' + 'f'.repeat(64)));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.chain.valid).toBe(false);
    expect(report.breaks[0]).toMatchObject({ seq: 2, kind: 'prev-hash-mismatch' });
  });

  it('requires the genesis manifest to carry the zero prev hash', async () => {
    await sink.putBatch(batch(1, 'sha256:' + 'a'.repeat(64)));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.breaks[0]).toMatchObject({ seq: 1, kind: 'prev-hash-mismatch' });
  });

  it('detects a gap in the sequence', async () => {
    const a = await sink.putBatch(batch(1, GENESIS_PREV));
    await sink.putBatch(batch(3, a.manifestHash));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.breaks.some((b) => b.kind === 'seq-gap')).toBe(true);
  });

  it('detects a deleted record file', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const m = (await sink.readManifest(ORG_ID, 1))!;
    await rm(join(root, ...m.sources[0]!.files[0]!.path.split('/')));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.breaks[0]).toMatchObject({ seq: 1, kind: 'missing-file' });
  });

  it('detects an edited record file by its file hash', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const m = (await sink.readManifest(ORG_ID, 1))!;
    const abs = join(root, ...m.sources[0]!.files[0]!.path.split('/'));
    await writeFile(abs, 'tampered\n');

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.chain.valid).toBe(false);
    expect(report.breaks[0]).toMatchObject({ kind: 'file-hash-mismatch' });
  });

  it('detects the attribution-erasing edit under --deep, even if the file hash were repaired', async () => {
    // Remove DelegateUser from record 0 and rewrite the file so file_sha256 matches again.
    // Only records_root catches this, which is why both hashes exist.
    await sink.putBatch(batch(1, GENESIS_PREV));
    const m = (await sink.readManifest(ORG_ID, 1))!;
    const entry = m.sources[0]!.files[0]!;
    const abs = join(root, ...entry.path.split('/'));

    const tampered = { ...RECORD_0, payload: { ...RECORD_0.payload, DelegateUser: null } };
    const { canonicalBytes } = await import('../../../src/chain/canonical.js');
    const { sha256Hex } = await import('../../../src/chain/hash.js');
    const content = Buffer.concat([
      canonicalBytes(tampered),
      Buffer.from('\n'),
      canonicalBytes(RECORD_1),
      Buffer.from('\n'),
    ]);
    await writeFile(abs, content);

    // Repair the manifest's file entry so only records_root disagrees.
    m.sources[0]!.files[0] = {
      path: entry.path,
      bytes: content.length,
      sha256: `sha256:${sha256Hex(content)}`,
    };
    await writeFile(
      join(root, `org_id=${ORG_ID}/_chain/00000001.manifest.json`),
      JSON.stringify(m, null, 2) + '\n',
    );

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });
    expect(report.breaks.some((b) => b.kind === 'records-root-mismatch')).toBe(true);
  });

  it('counts records under --deep', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });
    expect(report.recordsChecked).toBe(2);
  });

  it('reports orphans informationally without invalidating the chain', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const dir = `org_id=${ORG_ID}/source=audit-trail/year=2026/month=08`;
    await writeFile(join(root, ...dir.split('/'), 'part-20260901T000000Z-ZZZZZZZZ.ndjson'), 'x\n');

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.chain.valid).toBe(true);
    expect(report.orphans).toHaveLength(1);
  });

  it('reports a malformed record line as a break under --deep instead of throwing', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const m = (await sink.readManifest(ORG_ID, 1))!;
    const entry = m.sources[0]!.files[0]!;
    const abs = join(root, ...entry.path.split('/'));
    // Neither line here is valid JSON, so the file's file_sha256 also disagrees (expected —
    // this line does not need to isolate to only malformed-record). The point is that
    // verifyChain resolves with a report instead of the promise rejecting.
    await writeFile(abs, 'not valid json\nalso not valid json\n');

    const reportPromise = verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });
    await expect(reportPromise).resolves.toBeDefined();

    const report = await reportPromise;
    expect(report.chain.valid).toBe(false);
    expect(
      report.breaks.some((b) => b.kind === 'malformed-record' && b.file === entry.path),
    ).toBe(true);
  });

  it('marks a requested anchor invalid when no evaluator is supplied', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'git' });

    expect(report.anchor.mode).toBe('git');
    expect(report.anchor.valid).toBe(false);
    expect(report.breaks.some((b) => b.kind === 'anchor')).toBe(true);
    expect(report.anchor.proves.length).toBeGreaterThan(0);
    expect(report.anchor.doesNotProve.length).toBeGreaterThan(0);
  });

  it('does not assert the manifests were committed when no evaluator could check', async () => {
    // `verify --sink local --anchor git`: the report said "The configured sink cannot
    // evaluate the 'git' anchor." and then, two lines later, "Each manifest was committed
    // at a point in this repository history."
    await sink.putBatch(batch(1, GENESIS_PREV));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'git' });

    expect(report.anchor.proves).not.toMatch(/Each manifest was committed/);
    expect(report.anchor.proves).toMatch(/did not establish it/);
    expect(report.anchor.doesNotProve).toMatch(/unanchored archive/);
  });

  it('does not assert the manifests were committed when the evaluator says they were not', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const evaluateAnchor = async () => ({
      mode: 'git' as const,
      valid: false,
      detail: 'Manifest(s) not committed to git: seq 1.',
      signedCommits: 0,
      unsignedCommits: 0,
      badSignatures: 0,
      remote: true,
    });

    const report = await verifyChain(sink, ORG_ID, { anchor: 'git', evaluateAnchor });

    expect(report.anchor.valid).toBe(false);
    expect(report.anchor.proves).not.toMatch(/Each manifest was committed/);
    expect(report.anchor.proves).toMatch(/did not establish it/);
    // The chain is untouched by an anchor that failed.
    expect(report.chain.valid).toBe(true);
  });

  it('reflects an injected anchor evaluator result and still carries its statements', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const evaluateAnchor = async () =>
      ({ mode: 'git' as const, valid: true, signedCommits: 1, unsignedCommits: 0, badSignatures: 0, remote: true });

    const report = await verifyChain(sink, ORG_ID, { anchor: 'git', evaluateAnchor });

    expect(report.anchor.valid).toBe(true);
    expect(report.anchor.signedCommits).toBe(1);
    expect(report.anchor.unsignedCommits).toBe(0);
    expect(report.breaks.some((b) => b.kind === 'anchor')).toBe(false);
    expect(report.anchor.proves.length).toBeGreaterThan(0);
    expect(report.anchor.doesNotProve.length).toBeGreaterThan(0);
  });

  it('does not count an anchor failure against the chain', async () => {
    // `verify --anchor git` against a LocalSink says nothing whatever about the chain.
    // Reporting `chain: BROKEN` there is a false accusation against intact evidence.
    await sink.putBatch(batch(1, GENESIS_PREV));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'git' });

    expect(report.anchor.valid).toBe(false);
    expect(report.breaks.some((b) => b.kind === 'anchor')).toBe(true);
    expect(report.chain.valid).toBe(true);
    expect(report.chain.state).toBe('verified');
  });

  it('reports a file it could not read as unreadable, not as deleted', async () => {
    // "We could not look" rendered as "it is gone" is the inversion this product exists to
    // prevent. A permission error is not evidence of tampering.
    await sink.putBatch(batch(1, GENESIS_PREV));
    const denying = Object.create(sink) as typeof sink;
    denying.readFile = async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };

    const report = await verifyChain(denying, ORG_ID, { anchor: 'none' });

    expect(report.breaks.some((b) => b.kind === 'unreadable-file')).toBe(true);
    expect(report.breaks.some((b) => b.kind === 'missing-file')).toBe(false);
    expect(report.breaks[0]!.actual).toBe('EACCES');
  });

  it('still reports a genuinely absent file as missing-file', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const m = (await sink.readManifest(ORG_ID, 1))!;
    await rm(join(root, ...m.sources[0]!.files[0]!.path.split('/')));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.breaks.some((b) => b.kind === 'missing-file')).toBe(true);
    expect(report.breaks.some((b) => b.kind === 'unreadable-file')).toBe(false);
  });

  it('reports the range it walked for --from, and flags it as a subrange', async () => {
    let prev = GENESIS_PREV;
    for (let seq = 1; seq <= 4; seq += 1) prev = (await sink.putBatch(batch(seq, prev))).manifestHash;

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', from: 3 });

    expect(report.manifestsChecked).toBe(2);
    expect(report.range).toEqual({ from: 3, to: 4 });
    expect(report.fullChain).toBe(false);
    // The first link of a --from walk is unchecked by construction: no earlier manifest was
    // read, so there is no hash to compare seq 3's prev_manifest_hash against.
    expect(report.breaks).toEqual([]);
  });

  it('reports the range it walked for --to, and does not compare head against it', async () => {
    let prev = GENESIS_PREV;
    for (let seq = 1; seq <= 4; seq += 1) prev = (await sink.putBatch(batch(seq, prev))).manifestHash;

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', to: 2 });

    expect(report.range).toEqual({ from: 1, to: 2 });
    expect(report.fullChain).toBe(false);
    expect(report.chain.headCheck).toBe('not-checked');
  });

  it('marks a walk over every manifest as the full chain', async () => {
    let prev = GENESIS_PREV;
    for (let seq = 1; seq <= 3; seq += 1) prev = (await sink.putBatch(batch(seq, prev))).manifestHash;

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', from: 1 });
    expect(report.fullChain).toBe(true);
    expect(report.range).toEqual({ from: 1, to: 3 });
  });

  it('reports a range that selects no manifest as empty, not as valid', async () => {
    await sink.putBatch(batch(1, GENESIS_PREV));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', from: 40, to: 42 });

    expect(report.manifestsChecked).toBe(0);
    expect(report.chain.state).toBe('empty');
    expect(report.chain.valid).toBe(false);
  });

  it('collects what the manifests record about reduced coverage', async () => {
    const degraded = buildBatch({
      orgId: ORG_ID,
      runId: '01K3QF8H2N0000000000000000',
      createdAt: '2026-08-11T09:00:12.482Z',
      collectedAt: '2026-08-15T09:01:12.482Z',
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes: [
        {
          source: 'audit-trail',
          status: 'degraded',
          window: { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }, achieved: [],
          records: [],
        },
      ],
      degradations: [
        {
          source: 'audit-trail',
          code: 'INSUFFICIENT_ACCESS',
          detail: 'no access',
          remediation: 'grant View Setup and Configuration',
        },
      ],
    });
    await sink.putBatch(degraded);

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });

    expect(report.chain.valid).toBe(true);
    expect(report.coverage.degradedSources).toEqual([
      { seq: 1, source: 'audit-trail', status: 'degraded' },
    ]);
    expect(report.coverage.degradations).toHaveLength(1);
    expect(report.coverage.degradations[0]!.code).toBe('INSUFFICIENT_ACCESS');
  });

  it('resets expectedPrev after a missing manifest, so the next seq is not flagged with a spurious prev-hash-mismatch', async () => {
    // LocalSink.listManifests only ever returns sequence numbers whose manifest file exists
    // on disk, so readManifest returning null for a *listed* seq is unreachable through it.
    // This defensive path needs a fake Sink to exercise at all.
    const m1: Manifest = {
      schema: 'sf-evidence/manifest/v1',
      seq: 1,
      org_id: ORG_ID,
      run_id: 'run-1',
      created_at: '2026-08-11T09:00:12.482Z',
      producer: { name: 'test', version: '0.0.0' },
      prev_manifest_hash: GENESIS_PREV,
      sources: [],
      degradations: [],
    };
    const m3: Manifest = {
      ...m1,
      seq: 3,
      prev_manifest_hash: `sha256:${'b'.repeat(64)}`,
    };
    const fake = new FakeSink(
      new Map<number, Manifest | null>([
        [1, m1],
        [2, null],
        [3, m3],
      ]),
    );

    const report = await verifyChain(fake, ORG_ID, { anchor: 'none' });

    expect(report.breaks).toEqual([{ seq: 2, kind: 'missing-manifest' }]);
  });

  describe('the truncation caveat, across every headCheck state', () => {
    // A distinctive phrase from TRUNCATION_CAVEAT (src/chain/anchorStatements.ts), not the
    // whole sentence — so these survive copy-editing but still check the meaning: whether the
    // report tells the reader that truncation of the newest manifests was not ruled out.
    const CAVEAT_PHRASE = /Truncation of the newest manifests is NOT detected/;

    it('matched: head.json agrees with the walked chain — no caveat', async () => {
      const a = await sink.putBatch(batch(1, GENESIS_PREV));
      await sink.putBatch(batch(2, a.manifestHash));

      const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });

      expect(report.chain.headCheck).toBe('matched');
      expect(report.anchor.proves).not.toMatch(CAVEAT_PHRASE);
    });

    it('mismatch: head.json disagrees with the walked chain — no caveat (regression guard)', async () => {
      // Simulates exactly the real-org scenario the defect was found from: collect twice,
      // then delete the newest manifest to fake an adversary hiding recent activity. The
      // head-mismatch break below IS the tool comparing head.json against the walked chain —
      // printing the caveat in the same report would say the opposite of what just happened.
      const a = await sink.putBatch(batch(1, GENESIS_PREV));
      await sink.putBatch(batch(2, a.manifestHash));
      await rm(join(root, `org_id=${ORG_ID}/_chain/00000002.manifest.json`));

      const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });

      expect(report.chain.headCheck).toBe('mismatch');
      expect(report.breaks.some((b) => b.kind === 'head-mismatch')).toBe(true);
      expect(report.anchor.proves).not.toMatch(CAVEAT_PHRASE);
    });

    it('absent: no head.json at all — caveat present', async () => {
      await sink.putBatch(batch(1, GENESIS_PREV));
      await rm(join(root, `org_id=${ORG_ID}/_chain/head.json`));

      const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });

      expect(report.chain.headCheck).toBe('absent');
      expect(report.anchor.proves).toMatch(CAVEAT_PHRASE);
    });

    it('not-checked: a --to-bounded subrange — caveat present', async () => {
      let prev = GENESIS_PREV;
      for (let seq = 1; seq <= 4; seq += 1) prev = (await sink.putBatch(batch(seq, prev))).manifestHash;

      const report = await verifyChain(sink, ORG_ID, { anchor: 'none', to: 2 });

      expect(report.chain.headCheck).toBe('not-checked');
      expect(report.anchor.proves).toMatch(CAVEAT_PHRASE);
    });
  });
});

describe('verifyChain metadata notes', () => {
  let root: string;
  let sink: LocalSink;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-vmeta-'));
    sink = new LocalSink(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ORG_JSON = `org_id=${ORG_ID}/org.json`;
  const fileFor = (content: string) => {
    const bytes = Buffer.from(content, 'utf8');
    return { relPath: ORG_JSON, bytes, sha256: `sha256:${sha256Hex(bytes)}` };
  };
  const batchWith = (seq: number, prev: string, content: string | null) => {
    const b = buildBatch({
      orgId: ORG_ID, runId: `01K3QF8H0000000000000000${seq}`, createdAt: '2026-08-15T09:00:00.000Z',
      collectedAt: `2026-08-15T09:00:0${seq}.000Z`, prevManifestHash: prev, seq,
      outcomes: [], degradations: [],
    });
    if (content === null) return b;
    const f = fileFor(content);
    return {
      ...b,
      manifest: { ...b.manifest, metadata: [{ path: f.relPath, bytes: f.bytes.length, sha256: f.sha256 }] },
      files: [f],
    };
  };

  it('verify reports an edited org.json as a metadata change, not a break', async () => {
    const b1 = batchWith(1, GENESIS_PREV, '{"name":"Acme"}\n');
    await sink.putBatch(b1);
    await writeFile(join(root, ...ORG_JSON.split('/')), '{"name":"Edited"}\n');

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.breaks).toEqual([]);
    expect(report.chain.valid).toBe(true);
    expect(report.notes).toEqual([
      expect.objectContaining({ kind: 'metadata-changed', seq: 1, file: ORG_JSON }),
    ]);
    expect(verifyExitCode(report)).toBe(0);
  });

  it('verify ignores superseded metadata entries in older manifests', async () => {
    const b1 = batchWith(1, GENESIS_PREV, '{"name":"Acme"}\n');
    await sink.putBatch(b1);
    const b2 = batchWith(2, manifestHash(b1.manifest), '{"name":"Acme Holdings"}\n');
    await sink.putBatch(b2);

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.notes).toEqual([]);
    expect(report.breaks).toEqual([]);
  });

  it('verify reports a deleted org.json as a metadata change, not a break', async () => {
    await sink.putBatch(batchWith(1, GENESIS_PREV, '{"name":"Acme"}\n'));
    await rm(join(root, ...ORG_JSON.split('/')));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.breaks).toEqual([]);
    expect(report.chain.valid).toBe(true);
    expect(report.notes).toEqual([
      expect.objectContaining({ kind: 'metadata-changed', file: ORG_JSON, actual: 'missing' }),
    ]);
    expect(verifyExitCode(report)).toBe(0);
  });

  it('archives with no metadata verify with no notes', async () => {
    await sink.putBatch(batchWith(1, GENESIS_PREV, null));
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.notes).toEqual([]);
  });
});
