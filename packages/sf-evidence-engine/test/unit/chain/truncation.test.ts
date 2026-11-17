import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSink } from '../../../src/sinks/local.js';
import { buildBatch } from '../../../src/chain/manifestBuilder.js';
import { verifyChain } from '../../../src/chain/verifier.js';
import { verifyExitCode } from '../../../src/lib/verifyFormat.js';
import { EXIT } from '../../../src/lib/exit.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import { RECORD_0, RECORD_1, ORG_ID } from '../../../src/testing/specVectors.js';
import type { NormalisedRecord } from '../../../src/types/record.js';

/**
 * Tail truncation — deleting the newest manifests and their record files.
 *
 * This is the attack the chain alone cannot see. Every link binds a manifest to its
 * *predecessor*, so removing manifests from the end leaves a shorter chain in which every
 * remaining link still verifies. `head.json` is the only artifact that names the newest
 * sequence, which is why `verify` must compare it against what it walked rather than fetch
 * it only to decorate the report.
 *
 * The archive here has three manifests. An adversary who wants the last month gone deletes
 * seq 3 and its record file; a careful one also fixes head.json, which is what the second
 * test covers.
 */
const records = [RECORD_0, RECORD_1] as unknown as NormalisedRecord[];

function batch(seq: number, prev: string) {
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
        records,
      },
    ],
    degradations: [],
  });
}

describe('verifyChain — tail truncation', () => {
  let root: string;
  let sink: LocalSink;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-trunc-'));
    sink = new LocalSink(root);
    await sink.init();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function threeManifests(): Promise<void> {
    let prev = GENESIS_PREV;
    for (let seq = 1; seq <= 3; seq += 1) {
      const out = await sink.putBatch(batch(seq, prev));
      prev = out.manifestHash;
    }
  }

  async function deleteNewest(seq: number): Promise<void> {
    const m = (await sink.readManifest(ORG_ID, seq))!;
    for (const file of m.sources.flatMap((s) => s.files)) {
      await rm(join(root, ...file.path.split('/')), { force: true });
    }
    await rm(join(root, `org_id=${ORG_ID}/_chain/${String(seq).padStart(8, '0')}.manifest.json`));
  }

  it('detects the newest manifest being deleted, even though every remaining link verifies', async () => {
    await threeManifests();
    await deleteNewest(3);

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });

    // The surviving 1→2 chain is internally perfect. Only head.json knows seq 3 existed.
    expect(report.manifestsChecked).toBe(2);
    expect(report.breaks.some((b) => b.kind === 'head-mismatch')).toBe(true);
    expect(report.chain.valid).toBe(false);
    expect(report.chain.headCheck).toBe('mismatch');
  });

  it('detects the two newest manifests being deleted', async () => {
    await threeManifests();
    await deleteNewest(3);
    await deleteNewest(2);

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });

    expect(report.manifestsChecked).toBe(1);
    expect(report.chain.valid).toBe(false);
    expect(report.breaks.some((b) => b.kind === 'head-mismatch')).toBe(true);
  });

  it('stops claiming truncation is detected when head.json is absent', async () => {
    // Deleting head.json as well removes the only evidence of the newest sequence. The run
    // cannot detect the truncation, so it must not keep printing that it would have.
    await threeManifests();
    await deleteNewest(3);
    await rm(join(root, `org_id=${ORG_ID}/_chain/head.json`));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });

    expect(report.chain.headCheck).toBe('absent');
    expect(report.breaks).toEqual([]);
    expect(report.anchor.proves).not.toMatch(/truncation, or reordering/i);
    expect(report.anchor.proves).toMatch(/truncation of the newest manifests is NOT detected/i);

    // And it must not return green on the channel CI reads. This is the adversary-optimal
    // form of the attack: delete the tail manifests *and* head.json, and every surviving
    // link still verifies. Not a break — nothing on disk proves the deleted manifests ever
    // existed — but not "success, full coverage" either.
    expect(verifyExitCode(report)).toBe(EXIT.DEGRADED);
  });

  it('exits 4 when head.json alone is removed from an otherwise untouched chain', async () => {
    // The interrupted-run case, without any truncation: LocalSink writes head.json last on
    // every batch, so its absence over a non-empty chain is anomalous by construction.
    await threeManifests();
    await rm(join(root, `org_id=${ORG_ID}/_chain/head.json`));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });

    expect(report.manifestsChecked).toBe(3);
    expect(report.chain.valid).toBe(true);
    expect(report.breaks).toEqual([]);
    expect(report.chain.headCheck).toBe('absent');
    expect(verifyExitCode(report)).toBe(EXIT.DEGRADED);
  });

  it('still exits 0 for a fully clean chain with head.json in place', async () => {
    // The regression guard for the fix above: a genuinely clean archive must stay green.
    await threeManifests();

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });

    expect(report.chain.headCheck).toBe('matched');
    expect(report.breaks).toEqual([]);
    expect(verifyExitCode(report)).toBe(EXIT.OK);
  });

  it('claims truncation detection only when head.json was actually compared', async () => {
    await threeManifests();
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });

    expect(report.chain.headCheck).toBe('matched');
    expect(report.anchor.proves).toMatch(/truncation/i);
    expect(report.anchor.proves).not.toMatch(/NOT detected/);
  });

  it('does not check head.json against a --to-bounded subrange, and says so', async () => {
    await threeManifests();
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', to: 2 });

    expect(report.manifestsChecked).toBe(2);
    expect(report.chain.headCheck).toBe('not-checked');
    expect(report.breaks).toEqual([]);
    expect(report.chain.valid).toBe(true);
    expect(report.anchor.proves).toMatch(/NOT detected/);
  });
});
