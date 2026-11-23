// `sf evidence status` as a command: flag parsing, the rows it builds from the archive, the
// JSON result and the exit code CI reads. Rendering is covered line by line in the engine's
// test/unit/lib/statusFormat.test.ts.
import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, Parser } from '@oclif/core';
import EvidenceStatus, { type StatusResult } from '../../../src/commands/evidence/status.js';
import { LocalSink, buildBatch, EXIT, GENESIS_PREV } from '@cclabsnz/sf-evidence-engine';
import { ORG_ID } from '@cclabsnz/sf-evidence-engine/testing';
import type { SourceId, SourceStatus, TimeWindow } from '@cclabsnz/sf-evidence-engine';

const NOW = '2026-08-15T09:00:00.000Z';
/** now − 180d: the oldest instant Salesforce still holds. */
const RETENTION_START = '2026-02-16T09:00:00.000Z';

interface Entry {
  source: SourceId;
  achieved: TimeWindow[];
  status?: SourceStatus;
}

describe('sf evidence status', () => {
  let config: Config;
  let root: string;
  let sink: LocalSink;
  let logged: string[];
  let prev: string;
  let seq: number;

  beforeAll(async () => {
    config = await Config.load({ root: process.cwd(), userPlugins: false, devPlugins: false });
  });

  beforeEach(async () => {
    // Only Date is faked: status reads the clock, and the fs promises it awaits must still run.
    jest.useFakeTimers({
      now: new Date(NOW),
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
        'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
        'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-status-'));
    sink = new LocalSink(root);
    await sink.init();
    logged = [];
    prev = GENESIS_PREV;
    seq = 0;
    delete process.exitCode;
  });

  afterEach(async () => {
    jest.useRealTimers();
    delete process.exitCode;
    await rm(root, { recursive: true, force: true });
  });

  /** One manifest holding these entries, chained onto the last. */
  async function archive(...entries: Entry[]): Promise<void> {
    seq += 1;
    // A run cannot cover time after it ran, and the reader clips each entry at created_at, so a
    // run that covered up to an instant is dated no earlier than it.
    const spaced = new Date(Date.parse(NOW) - (10 - seq) * 60_000).toISOString();
    const created = entries
      .flatMap((e) => e.achieved.map((w) => w.to))
      .reduce((a, b) => (b > a ? b : a), spaced);
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: `01K3QF8H2N00000000000000${String(seq).padStart(2, '0')}`,
      createdAt: created,
      collectedAt: created,
      prevManifestHash: prev,
      seq,
      outcomes: entries.map((e) => ({
        source: e.source,
        status: e.status ?? 'complete',
        window: {
          from: e.achieved[0]?.from ?? RETENTION_START,
          to: e.achieved.at(-1)?.to ?? NOW,
        },
        achieved: e.achieved,
        // A snapshot entry stores its sample; an event entry here stores nothing.
        records:
          e.source === 'limits'
            ? [
                {
                  schema: 'sf-evidence/limits/v1',
                  org_id: ORG_ID,
                  source: 'limits',
                  source_id: `limits:${ORG_ID}:${created.slice(0, 13)}`,
                  occurred_at: `${created.slice(0, 13)}:00:00.000Z`,
                  collected_at: created,
                  api_version: '67.0',
                  payload: { sampled_at: created, limits: {} },
                } as never,
              ]
            : [],
      })),
      degradations: [],
    });
    prev = (await sink.putBatch(batch)).manifestHash;
  }

  async function status(...flags: string[]): Promise<StatusResult> {
    const cmd = new EvidenceStatus(['--org-id', ORG_ID, '--archive', root, ...flags], config);
    (cmd as unknown as { log: (m?: string) => void }).log = (m = '') => {
      logged.push(m);
    };
    return cmd.run();
  }

  const out = (): string => logged.join('\n');

  it('exits 3 on at-risk coverage without --strict', async () => {
    // Last covered 2026-03-03T17:00Z: destroyed 2026-08-30T17:00Z, 15d 8h away, inside the
    // 18-day threshold. No gap, only pending time, and still exit 3: the loss is permanent.
    await archive({
      source: 'audit-trail',
      achieved: [{ from: RETENTION_START, to: '2026-03-03T17:00:00.000Z' }],
    });

    const result = await status();

    expect(process.exitCode).toBe(EXIT.INTEGRITY);
    expect(result.atRisk).toBe(true);
    expect(result.sources[0]!.gaps).toEqual([]);
    expect(out()).toMatch(/AT RISK/);
    expect(out()).toContain('→ the 2026-03-03 window is destroyed on 2026-08-30. Collect now.');
  });

  it('exits 4 on a gap that is not at risk', async () => {
    await archive({
      source: 'audit-trail',
      achieved: [
        { from: RETENTION_START, to: '2026-06-01T00:00:00.000Z' },
        { from: '2026-07-01T00:00:00.000Z', to: NOW },
      ],
    });

    const result = await status();

    expect(process.exitCode).toBe(EXIT.DEGRADED);
    expect(result.atRisk).toBe(false);
    expect(out()).toMatch(/GAP\s+2026-06-01 → 2026-07-01\s+\(30d\)/);
  });

  it('exits 3 on the same gap with --strict', async () => {
    await archive({
      source: 'audit-trail',
      achieved: [
        { from: RETENTION_START, to: '2026-06-01T00:00:00.000Z' },
        { from: '2026-07-01T00:00:00.000Z', to: NOW },
      ],
    });

    await status('--strict');

    expect(process.exitCode).toBe(EXIT.INTEGRITY);
  });

  it('exits 0 with only pending coverage', async () => {
    // Five days since the last run: pending, not a gap (R5), and far from destruction.
    await archive({
      source: 'audit-trail',
      achieved: [{ from: RETENTION_START, to: '2026-08-10T09:00:00.000Z' }],
    });

    const result = await status();

    expect(process.exitCode).toBeUndefined();
    expect(result.sources[0]!.pending).toEqual({ from: '2026-08-10T09:00:00.000Z', to: NOW });
    expect(out()).toMatch(/pending\s+2026-08-10 09:00Z → 2026-08-15 09:00Z\s+\(5d not yet collected\)/);
    expect(out()).not.toMatch(/GAP/);
  });

  it('--json carries gaps, headroom and destroyedAfter', async () => {
    await archive({
      source: 'audit-trail',
      achieved: [
        { from: RETENTION_START, to: '2026-06-01T00:00:00.000Z' },
        { from: '2026-07-01T00:00:00.000Z', to: NOW },
      ],
    });

    const result = await status('--json');

    expect(result).not.toHaveProperty('gapDetection');
    expect(result).toEqual({
      orgId: ORG_ID,
      atRisk: false,
      sources: [
        {
          source: 'audit-trail',
          kind: 'event',
          lastRun: NOW,
          lastSuccess: NOW,
          recordCount: 0,
          coverage: [
            { from: RETENTION_START, to: '2026-06-01T00:00:00.000Z' },
            { from: '2026-07-01T00:00:00.000Z', to: NOW },
          ],
          gaps: [{ from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z', days: 30 }],
          pending: null,
          lost: [],
          retentionWindowDays: 180,
          // The gap's start, 2026-06-01, is destroyed 180 days later: 2026-11-28T00:00Z.
          headroomSeconds: (Date.parse('2026-11-28T00:00:00.000Z') - Date.parse(NOW)) / 1000,
          atRisk: false,
          destroyedAfter: '2026-11-28T00:00:00.000Z',
          stale: false,
        },
      ],
    });
    expect(process.exitCode).toBe(EXIT.DEGRADED);
  });

  it('--window narrows the evaluation to the last N days', async () => {
    // The hole is in June; a 30-day window starting 2026-07-16 does not reach it.
    await archive({
      source: 'audit-trail',
      achieved: [
        { from: RETENTION_START, to: '2026-06-01T00:00:00.000Z' },
        { from: '2026-07-01T00:00:00.000Z', to: NOW },
      ],
    });

    const result = await status('--window', '30');

    expect(result.sources[0]!.gaps).toEqual([]);
    expect(out()).toMatch(/\(30d window: complete\)/);
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a --window that is not a positive whole number of days', async () => {
    await expect(status('--window', '0')).rejects.toThrow(/--window/);
    await expect(status('--window', 'abc')).rejects.toThrow(/--window/);
  });

  it('--source limits the report to the named sources', async () => {
    await archive(
      { source: 'audit-trail', achieved: [{ from: RETENTION_START, to: '2026-03-03T17:00:00.000Z' }] },
      { source: 'limits', achieved: [{ from: '2026-08-15T08:00:00.000Z', to: NOW }] },
    );

    const result = await status('--source', 'limits');

    expect(result.sources.map((s) => s.source)).toEqual(['limits']);
    expect(out()).not.toMatch(/audit-trail/);
    // The at-risk audit-trail source is out of scope, so it does not drive the exit.
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a named source with nothing archived as nothing collected yet, never omits it', async () => {
    await archive({ source: 'limits', achieved: [{ from: '2026-08-15T08:00:00.000Z', to: NOW }] });

    const result = await status('--source', 'audit-trail');

    expect(result.sources.map((s) => s.source)).toEqual(['audit-trail']);
    expect(out()).toMatch(/nothing collected yet/);
    // Nothing collected for an event source: Salesforce is deleting the oldest of it now.
    expect(process.exitCode).toBe(EXIT.INTEGRITY);
  });

  it('measures headroom for a source with nothing collected from now − retention, even under a short --window', async () => {
    // Salesforce is deleting the oldest uncollected data now. A 30-day window must not turn
    // that into 150 days of headroom.
    await archive({ source: 'audit-trail', achieved: [], status: 'degraded' });

    const result = await status('--window', '30');

    expect(result.sources[0]).toMatchObject({ headroomSeconds: 0, atRisk: true, destroyedAfter: NOW });
    expect(result.atRisk).toBe(true);
    expect(out()).toMatch(/nothing collected yet/);
    expect(process.exitCode).toBe(EXIT.INTEGRITY);
  });

  it('never exits 0 for an event source with no coverage inside a short --window', async () => {
    // Collected until 60 days ago: 120 days of headroom, no gap, but the window holds nothing.
    await archive({ source: 'audit-trail', achieved: [{ from: RETENTION_START, to: '2026-06-16T09:00:00.000Z' }] });

    const result = await status('--window', '30');

    expect(result.sources[0]!.atRisk).toBe(false);
    expect(out()).toMatch(/NONE inside the evaluated window/);
    expect(process.exitCode).toBe(EXIT.DEGRADED);
  });

  it('reports the span before the first coverage as lost under a --window longer than retention', async () => {
    await archive({ source: 'audit-trail', achieved: [{ from: RETENTION_START, to: NOW }] });

    const result = await status('--window', '365');

    expect(result.sources[0]!.lost).toEqual([{ from: '2025-08-15T09:00:00.000Z', to: RETENTION_START }]);
    expect(out()).toMatch(/lost\s+2025-08-15 09:00Z → 2026-02-16 09:00Z/);
    expect(out()).not.toMatch(/complete/);
  });

  it('rejects a --source this release does not know', async () => {
    await expect(status('--source', 'audit-trial')).rejects.toThrow(/audit-trial/);
  });

  it('lists an archived source with no registered collector as not assessed, and exits 4', async () => {
    // Every SourceId has a collector since login-history was registered, so this stands in
    // for a source an older or newer release archived that this one has no collector for.
    const unregistered = 'retired-source' as SourceId;
    await archive(
      { source: 'audit-trail', achieved: [{ from: RETENTION_START, to: NOW }] },
      { source: unregistered, achieved: [{ from: RETENTION_START, to: '2026-03-03T17:00:00.000Z' }] },
    );

    const result = await status();

    const entry = result.sources.find((s) => s.source === unregistered)!;
    expect(entry).toMatchObject({
      kind: null,
      gaps: null,
      pending: null,
      lost: null,
      retentionWindowDays: null,
      headroomSeconds: null,
      destroyedAfter: null,
      // Nothing computed a verdict for it, so none is claimed.
      atRisk: null,
      stale: null,
    });
    expect(out()).toMatch(/not assessed: no collector for this source/);
    // Exit 0 means "full coverage"; nothing established that for this source.
    expect(process.exitCode).toBe(EXIT.DEGRADED);
  });

  it('marks a snapshot source with no sample in 26 hours stale, and exits 4', async () => {
    await archive({
      source: 'limits',
      achieved: [{ from: '2026-08-13T00:00:00.000Z', to: '2026-08-14T01:00:00.000Z' }],
    });
    // The manifest's created_at is minutes before NOW; move the clock on so the last
    // successful sample is 27 hours old.
    jest.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));

    const result = await status();

    expect(result.sources[0]).toMatchObject({ kind: 'snapshot', stale: true, headroomSeconds: null });
    expect(out()).toMatch(/headroom n\/a\s+STALE/);
    expect(result.sources[0]!.coverage).toBeNull();
    expect(process.exitCode).toBe(EXIT.DEGRADED);
  });

  it('says there is no data for the org in the archive, and exits 1 like verify', async () => {
    const result = await status();

    expect(result).toEqual({ orgId: ORG_ID, sources: [], atRisk: false });
    expect(out()).toContain(`No data archived for ${ORG_ID} in ${root}`);
    expect(process.exitCode).toBe(EXIT.ERROR);
  });

  describe('--window', () => {
    const parse = (v: string) =>
      Parser.parse([`--window=${v}`], { flags: { window: EvidenceStatus.flags.window } });

    it('is an integer of at least 1', async () => {
      expect((await parse('30')).flags.window).toBe(30);
      await expect(parse('0')).rejects.toThrow();
      await expect(parse('1.5')).rejects.toThrow();
      await expect(parse('abc')).rejects.toThrow();
    });
  });

  it('no longer describes gap detection as unimplemented', () => {
    expect(EvidenceStatus.description).not.toMatch(/not\b.*\bdetect gaps|Phase 1/i);
  });
});
