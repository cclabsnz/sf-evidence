import { jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSink } from '@cclabsnz/sf-evidence-engine';
import { runCollect } from '@cclabsnz/sf-evidence-engine';
import { verifyChain } from '@cclabsnz/sf-evidence-engine';
import { formatVerifyReport, verifyExitCode } from '@cclabsnz/sf-evidence-engine';
import { exitCodeFor } from '../../../src/lib/flags.js';
import { EXIT } from '@cclabsnz/sf-evidence-engine';
import { ORG_ID } from '@cclabsnz/sf-evidence-engine/testing';
import type { SoqlClient } from '@cclabsnz/sf-core';
import { Config } from '@oclif/core';
import EvidenceStatus, { type StatusResult } from '../../../src/commands/evidence/status.js';

const run = promisify(execFile);

/**
 * The Phase 0 story end to end, against a mocked org.
 *
 * This never contacts Salesforce. The real-org run in the Phase 0 gate is a human step
 * performed by the maintainer; no automated test may point at a live org.
 *
 * `collect` and `verify` are exercised through the pure pipeline (`runCollect`) and verifier
 * (`verifyChain`) they wrap, because `collect` needs a live org connection to construct.
 * `status` reads only the archive, so the induced-gap test below runs the real command.
 */
/** Sorted, with touching windows joined. */
function mergeWindows(ws: Array<{ from: string; to: string }>): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const w of [...ws].sort((a, b) => (a.from < b.from ? -1 : 1))) {
    const last = out.at(-1);
    if (last && w.from <= last.to) last.to = w.to > last.to ? w.to : last.to;
    else out.push({ ...w });
  }
  return out;
}

function orgWith(rows: number): SoqlClient {
  const records = Array.from({ length: rows }, (_, i) => ({
    Id: `0Ym5j00000XyZ${String(i).padStart(2, '0')}CAA`,
    Action: 'PermSetAssign',
    Section: 'Manage Users',
    Display: `Assigned permission set Admin to user ${i}`,
    CreatedDate: '2026-08-14T02:11:09.000+0000',
    CreatedById: '0055j00000AaBbCcAAG',
    DelegateUser: i === 0 ? 'support.admin@example.govt.nz' : null,
    CreatedByContext: null,
    CreatedByIssuer: null,
    CreatedBy: { Name: 'Jo Taylor', Username: 'jo.taylor@example.govt.nz' },
  }));
  return {
    query: async () => ({ totalSize: 0, done: true, records: [] }),
    queryAll: (async () => records) as SoqlClient['queryAll'],
  } as SoqlClient;
}

describe('end to end: collect → verify → tamper → verify', () => {
  let root: string;
  let sink: GitSink;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-e2e-'));
    await run('git', ['init', '-b', 'main'], { cwd: root });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await run('git', ['config', 'user.name', 'Test'], { cwd: root });
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    sink = new GitSink(root);
    await sink.init();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collects, chains, commits and verifies clean across three runs', async () => {
    let manifests = 0;
    for (let i = 0; i < 3; i += 1) {
      const result = await runCollect({
        orgId: ORG_ID,
        sources: ['audit-trail'],
        sinks: [sink],
        soql: orgWith(5),
        now: new Date(`2026-08-1${5 + i}T09:00:00.000Z`),
      });
      manifests += result.manifests.length;
    }
    // The first run's 180-day backfill is committed in 26 seven-day rounds; each later run is one.
    expect(manifests).toBe(28);

    sink.anchorOrgId = ORG_ID;
    const report = await verifyChain(sink, ORG_ID, {
      anchor: 'git',
      deep: true,
      evaluateAnchor: (seqs) => sink.evaluateAnchor(seqs),
    });

    expect(report.chain.valid).toBe(true);
    expect(report.manifestsChecked).toBe(manifests);
    expect(report.anchor.valid).toBe(true);
    // Second and third runs dedupe to zero new records; five records total.
    expect(report.recordsChecked).toBe(5);
  });

  it('detects an edit that erases Login-As attribution', async () => {
    await runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: orgWith(5),
      now: new Date('2026-08-15T09:00:00.000Z'),
    });

    const manifest = (await sink.readManifest(ORG_ID, 1))!;
    const rel = manifest.sources[0]!.files[0]!.path;
    const abs = join(root, ...rel.split('/'));
    const text = await readFile(abs, 'utf8');
    await writeFile(abs, text.replace('"support.admin@example.govt.nz"', 'null'));

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });
    expect(report.chain.valid).toBe(false);
    expect(report.breaks.some((b) => b.kind === 'file-hash-mismatch')).toBe(true);
  });

  it('records reduced coverage in the archive when permission is missing', async () => {
    const denied = {
      query: async () => ({ totalSize: 0, done: true, records: [] }),
      queryAll: (async () => {
        throw Object.assign(new Error('no access'), {
          errorCode: 'INSUFFICIENT_ACCESS',
          statusCode: 403,
          name: 'ApiError',
        });
      }) as SoqlClient['queryAll'],
    } as SoqlClient;

    const result = await runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: denied,
      now: new Date('2026-08-15T09:00:00.000Z'),
    });

    expect(result.degraded).toBe(true);
    const manifest = (await sink.readManifest(ORG_ID, 1))!;
    expect(manifest.sources[0]!.status).toBe('degraded');
    expect(manifest.degradations[0]!.code).toBe('INSUFFICIENT_ACCESS');

    // The chain over a degraded run is still valid — degradation is recorded, not hidden.
    // But `verify` must not stop there. A week later the auditor runs it, the `collect`
    // warning is long gone from scrollback, and a bare `chain: VALID` / exit 0 would be the
    // only thing they see about a month that was never collected. SPEC.md §8.3 gives that
    // its own exit code (4), and the report has to carry the evidence for it.
    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });
    expect(report.chain.valid).toBe(true);

    // Every 7-day round of the backfill was denied, and each manifest says so.
    expect(report.coverage.degradedSources).toEqual(
      result.manifests.map((m) => ({ seq: m.seq, source: 'audit-trail', status: 'degraded' })),
    );
    expect(report.coverage.degradations[0]).toMatchObject({
      seq: 1,
      code: 'INSUFFICIENT_ACCESS',
    });
    expect(verifyExitCode(report)).toBe(EXIT.DEGRADED);

    const text = formatVerifyReport(report).join('\n');
    expect(text).toContain('COVERAGE');
    expect(text).toContain('INSUFFICIENT_ACCESS');
  });

  it('exits 4 on the collect that degraded, and 4 again on every later verify', async () => {
    // The pairing that makes exit 4 useful: `collect` flags it on the day it happens, and
    // `verify` keeps flagging it for as long as the incomplete data is in the archive.
    const denied = {
      query: async () => ({ totalSize: 0, done: true, records: [] }),
      queryAll: (async () => {
        throw Object.assign(new Error('no access'), {
          errorCode: 'INSUFFICIENT_ACCESS',
          statusCode: 403,
          name: 'ApiError',
        });
      }) as SoqlClient['queryAll'],
    } as SoqlClient;

    const collected = await runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: denied,
      now: new Date('2026-08-15T09:00:00.000Z'),
    });
    expect(exitCodeFor(collected, false)).toBe(EXIT.DEGRADED);

    // A later clean run does not erase the earlier degraded manifest.
    await runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: orgWith(2),
      now: new Date('2026-08-16T09:00:00.000Z'),
    });

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none' });
    expect(report.chain.valid).toBe(true);
    expect(verifyExitCode(report)).toBe(EXIT.DEGRADED);
  });

  it('names the git anchor honestly for a local-only repository of unsigned commits', async () => {
    // This is the only configuration Phase 0 produces by default, and the statement used to
    // assert a force-push past branch protection that no host is watching.
    const collected = await runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: orgWith(2),
      now: new Date('2026-08-15T09:00:00.000Z'),
    });

    sink.anchorOrgId = ORG_ID;
    const report = await verifyChain(sink, ORG_ID, {
      anchor: 'git',
      evaluateAnchor: (seqs) => sink.evaluateAnchor(seqs),
    });

    expect(report.anchor.valid).toBe(true);
    expect(report.anchor.remote).toBe(false);
    expect(report.anchor.signedCommits).toBe(0);
    expect(report.anchor.proves).toMatch(/NO remote configured/);
    expect(report.anchor.proves).toMatch(/only\s+local write access/);
    expect(report.anchor.proves).not.toMatch(/host logs independently/);

    const text = formatVerifyReport(report).join('\n');
    expect(text).toMatch(/remote:\s+NONE/);
    // One commit per manifest, and the backfill wrote one manifest per 7-day round.
    expect(text).toContain(`0 signed, ${collected.manifests.length} unsigned`);
  });

  it('archives the batch and says so when only the git commit fails', async () => {
    // The first-contact failure the README's own --sign recipe walks into: no identity
    // configured, or -S with no usable key. GitSink.putBatch writes through LocalSink
    // first, so by the time `git commit` fails the records, manifest and head are already
    // on disk. Reporting that as an unwritten sink made runCollect announce that nothing
    // was archived over a complete batch.
    type GitFn = (args: string[]) => Promise<string>;
    const real = ((sink as unknown as { git: GitFn }).git as GitFn).bind(sink);
    jest
      .spyOn(sink as unknown as { git: GitFn }, 'git')
      .mockImplementation(async (args: string[]) => {
        if (args[0] === 'commit') {
          throw new Error("*** Please tell me who you are.\n\nfatal: unable to auto-detect email address");
        }
        return real(args);
      });

    const result = await runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: orgWith(3),
      now: new Date('2026-08-15T09:00:00.000Z'),
    });

    // Not a failed write. The sink took the batch; only the anchoring step did not finish.
    expect(result.sinks[0]!.written).toBe(true);
    expect(result.sinks[0]!.commit).toBeUndefined();
    expect(result.sinks[0]!.error).toMatch(/git anchor commit failed/);
    expect(result.sinks[0]!.error).toMatch(/unable to auto-detect email address/);
    expect(result.sinks[0]!.error).not.toMatch(/nothing was archived/i);
    // Reduced completion is still surfaced on the channel CI reads.
    expect(result.degraded).toBe(true);
    expect(exitCodeFor(result, false)).toBe(EXIT.DEGRADED);

    // And the evidence really is on disk, exactly as the message says.
    const manifest = await sink.readManifest(ORG_ID, 1);
    expect(manifest).not.toBeNull();
    expect(manifest!.sources[0]!.record_count).toBe(3);
    await expect(sink.head(ORG_ID)).resolves.toMatchObject({ seq: result.manifest.seq });

    const report = await verifyChain(sink, ORG_ID, { anchor: 'none', deep: true });
    expect(report.chain.valid).toBe(true);
    expect(report.recordsChecked).toBe(3);
  });

  it('does not claim the manifests were committed when the git anchor failed', async () => {
    // The anchor evaluation finds no commit for seq 1 (the commit above never happened),
    // so the report must not print "Each manifest was committed at a point in this
    // repository history" two lines under "Manifest(s) not committed to git: seq 1."
    type GitFn = (args: string[]) => Promise<string>;
    const real = ((sink as unknown as { git: GitFn }).git as GitFn).bind(sink);
    jest
      .spyOn(sink as unknown as { git: GitFn }, 'git')
      .mockImplementation(async (args: string[]) => {
        if (args[0] === 'commit') throw new Error('no identity');
        return real(args);
      });

    await runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: orgWith(2),
      now: new Date('2026-08-15T09:00:00.000Z'),
    });

    sink.anchorOrgId = ORG_ID;
    const report = await verifyChain(sink, ORG_ID, {
      anchor: 'git',
      evaluateAnchor: (seqs) => sink.evaluateAnchor(seqs),
    });

    expect(report.anchor.valid).toBe(false);
    expect(report.anchor.proves).not.toMatch(/Each manifest was committed/);
    expect(report.anchor.proves).toMatch(/did not establish it/);
    expect(report.anchor.doesNotProve).toMatch(/unanchored archive/);

    const text = formatVerifyReport(report).join('\n');
    expect(text).toMatch(/not committed to git/i);
    expect(text).not.toMatch(/Each manifest was committed/);
  });

  describe('the Phase 1 gate: status reports a deliberately induced gap', () => {
    // A first run collects the whole 180-day retention window, 2026-02-02 → 2026-08-01, month by
    // month, with June denied. The only uncovered time inside retention is the denied month.
    // (Headroom is measured over retention whatever --window says, so a run that collected only
    // part of retention would be at risk from its uncollected start, not merely gapped.)
    const NOW = new Date('2026-08-01T00:00:00.000Z');
    const DENIED = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };

    /** One audit-trail row per queried slice, dated inside it; the June slice optionally denied. */
    function orgDenying(denyJune: boolean): SoqlClient {
      let n = 0;
      return {
        query: async () => ({ totalSize: 0, done: true, records: [] }),
        queryAll: (async (soql: string) => {
          const from = /CreatedDate >= (\S+)/.exec(soql)![1]!;
          // Every slice inside June: rounds cut June at 7-day boundaries.
          if (denyJune && from >= '2026-06-01T00:00:00Z' && from < '2026-07-01T00:00:00Z') {
            throw Object.assign(new Error('no access'), {
              errorCode: 'INSUFFICIENT_ACCESS',
              statusCode: 403,
              name: 'ApiError',
            });
          }
          n += 1;
          return [
            {
              Id: `0Ym5j00000XyZ${String(n).padStart(3, '0')}AA`,
              Action: 'PermSetAssign',
              Section: 'Manage Users',
              Display: `row for the slice from ${from}`,
              CreatedDate: from.replace('Z', '.000+0000'),
              CreatedById: '0055j00000AaBbCcAAG',
              DelegateUser: null,
              CreatedByContext: null,
              CreatedByIssuer: null,
              CreatedBy: { Name: 'Jo Taylor', Username: 'jo.taylor@example.govt.nz' },
            },
          ];
        }) as SoqlClient['queryAll'],
      } as SoqlClient;
    }

    async function status(...flags: string[]): Promise<{ result: StatusResult; text: string; exit: number }> {
      const config = await Config.load({ root: process.cwd(), userPlugins: false, devPlugins: false });
      const logged: string[] = [];
      const cmd = new EvidenceStatus(
        ['--org-id', ORG_ID, '--archive', root, '--sink', 'git', ...flags],
        config,
      );
      (cmd as unknown as { log: (m?: string) => void }).log = (m = '') => {
        logged.push(m);
      };
      delete process.exitCode;
      // Only Date is faked: the command reads the clock, and its fs and git awaits must run.
      jest.useFakeTimers({
        now: NOW,
        doNotFake: [
          'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
          'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
          'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
        ],
      });
      try {
        const result = await cmd.run();
        return { result, text: logged.join('\n'), exit: Number(process.exitCode ?? 0) };
      } finally {
        jest.useRealTimers();
        delete process.exitCode;
      }
    }

    it('shows a GAP of exactly the denied window and exits 4, then exits 0 once collect repairs it', async () => {
      const first = await runCollect({
        orgId: ORG_ID,
        sources: ['audit-trail'],
        sinks: [sink],
        soql: orgDenying(true),
        now: NOW,
      });
      expect(first.sources[0]!.status).toBe('partial');
      // One degradation per round that touched June; together they are exactly June.
      const denied = first.sources[0]!.degradations;
      expect(new Set(denied.map((d) => d.code))).toEqual(new Set(['INSUFFICIENT_ACCESS']));
      expect(mergeWindows(denied.map((d) => d.window!))).toEqual([DENIED]);

      const before = await status();
      expect(before.result.sources[0]!.gaps).toEqual([{ ...DENIED, days: 30 }]);
      expect(before.result.sources[0]!.pending).toBeNull();
      expect(before.result.atRisk).toBe(false);
      expect(before.text).toMatch(/^\s+GAP\s+2026-06-01 → 2026-07-01\s+\(30d\)$/m);
      expect(before.text.match(/GAP/g)).toHaveLength(1);
      expect(before.exit).toBe(EXIT.DEGRADED);

      // The permission is granted. A default run re-collects every gap still inside retention (R2).
      const second = await runCollect({
        orgId: ORG_ID,
        sources: ['audit-trail'],
        sinks: [sink],
        soql: orgDenying(false),
        now: NOW,
      });
      expect(second.sources[0]!.status).toBe('complete');
      expect(second.sources[0]!.queried).toContainEqual(DENIED);

      const after = await status();
      expect(after.result.sources[0]!.gaps).toEqual([]);
      expect(after.text).not.toMatch(/GAP/);
      expect(after.exit).toBe(EXIT.OK);
    });
  });
});
