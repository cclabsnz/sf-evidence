import { jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@oclif/core';
import EvidenceVerify from '../../../src/commands/evidence/verify.js';
import EvidenceExplain from '../../../src/commands/evidence/explain.js';
import EvidenceCollect from '../../../src/commands/evidence/collect.js';
import EvidenceDoctor from '../../../src/commands/evidence/doctor.js';
import { LocalSink } from '@cclabsnz/sf-evidence-engine';
import { buildBatch } from '@cclabsnz/sf-evidence-engine';
import { EXIT } from '@cclabsnz/sf-evidence-engine';
import { GENESIS_PREV } from '@cclabsnz/sf-evidence-engine';
import { RECORD_0, RECORD_1, ORG_ID } from '@cclabsnz/sf-evidence-engine/testing';
import type { NormalisedRecord } from '@cclabsnz/sf-evidence-engine';
import type { VerifyReport } from '@cclabsnz/sf-evidence-engine';

const run = promisify(execFile);

/**
 * The command layer itself: flag parsing, sink resolution, `report()` output and every
 * exit-code call site.
 *
 * This surface had zero runtime coverage. The cause was a chalk 5 TDZ error
 * (`Cannot access 'supportsColor' before initialization`) raised the moment any file
 * importing `@salesforce/sf-plugins-core` was loaded under Jest+swc+vm-modules — chalk's
 * `#supports-color` subpath import resolves to a self-circular module under jest-resolve's
 * ESM linker. It is fixed by a `moduleNameMapper` chalk stub in `jest.config.ts`
 * (`test/stubs/chalk.mjs`), which is also why command output here is never colourised.
 *
 * `Config.load({ userPlugins: false, devPlugins: false })` keeps the oclif config to this
 * package: without it, oclif discovers the developer's globally linked sf plugins and tries
 * to link them into the vm.
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
        status: seq === 2 ? 'degraded' : 'complete',
        window: { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
        achieved:
          seq === 2 ? [] : [{ from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }],
        records: seq === 2 ? [] : records,
      },
    ],
    degradations:
      seq === 2
        ? [
            {
              source: 'audit-trail',
              code: 'INSUFFICIENT_ACCESS',
              detail: 'SetupAuditTrail is not readable by this user',
              remediation: 'Grant View Setup and Configuration',
            },
          ]
        : [],
  });
}

describe('sf evidence commands', () => {
  let config: Config;
  let root: string;
  let sink: LocalSink;
  let logged: string[];
  let warned: string[];

  beforeAll(async () => {
    config = await Config.load({ root: process.cwd(), userPlugins: false, devPlugins: false });
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-cmd-'));
    sink = new LocalSink(root);
    await sink.init();
    logged = [];
    warned = [];
    delete process.exitCode;
  });

  afterEach(async () => {
    delete process.exitCode;
    await rm(root, { recursive: true, force: true });
  });

  function capture<T extends { log: unknown; warn: unknown }>(cmd: T): T {
    (cmd as { log: (m?: string) => void }).log = (m = '') => {
      logged.push(m);
    };
    (cmd as { warn: (m: string) => string }).warn = (m: string) => {
      warned.push(m);
      return m;
    };
    return cmd;
  }

  const out = (): string => logged.join('\n');

  describe('verify', () => {
    it('--explain-algorithm prints the formulas, verifies nothing, and exits 0', async () => {
      const cmd = capture(new EvidenceVerify(['--explain-algorithm'], config));
      const result = await cmd.run();

      expect(result).toMatchObject({ mode: 'explain-algorithm' });
      expect(out()).toContain('records_root');
      expect(process.exitCode).toBeUndefined();
    });

    it('requires --org-id when it is actually going to verify something', async () => {
      const cmd = capture(new EvidenceVerify(['--archive', root], config));
      await expect(cmd.run()).rejects.toThrow(/--org-id is required/);
    });

    it('walks a clean chain, prints VALID and leaves the exit code at 0', async () => {
      let prev = GENESIS_PREV;
      for (const seq of [1, 3]) prev = (await sink.putBatch(batch(seq, prev))).manifestHash;

      const cmd = capture(
        new EvidenceVerify(['--org-id', ORG_ID, '--archive', root, '--from', '1', '--to', '1'], config),
      );
      const result = (await cmd.run()) as VerifyReport;

      expect(result.chain.valid).toBe(true);
      expect(out()).toContain('chain: VALID');
      expect(out()).toContain('Does not prove');
      expect(process.exitCode).toBeUndefined();
    });

    it('exits 1 and says NOTHING VERIFIED for an org with no manifests', async () => {
      const cmd = capture(new EvidenceVerify(['--org-id', ORG_ID, '--archive', root], config));
      const result = (await cmd.run()) as VerifyReport;

      expect(result.chain.state).toBe('empty');
      expect(out()).toContain('NOTHING VERIFIED');
      expect(process.exitCode).toBe(EXIT.ERROR);
    });

    it('exits 4 on a clean chain whose manifests record degradations, and keeps the payload', async () => {
      let prev = GENESIS_PREV;
      for (const seq of [1, 2]) prev = (await sink.putBatch(batch(seq, prev))).manifestHash;

      const cmd = capture(new EvidenceVerify(['--org-id', ORG_ID, '--archive', root], config));
      const result = (await cmd.run()) as VerifyReport;

      expect(process.exitCode).toBe(EXIT.DEGRADED);
      expect(out()).toContain('chain: VALID');
      expect(out()).toContain('COVERAGE');
      // The payload survives the non-zero exit: `this.exit()` would have thrown it away.
      expect(result.coverage.degradations).toHaveLength(1);
    });

    it('exits 4 when head.json is missing, so CI does not read it as full coverage', async () => {
      // The README this release ships tells CI to read the exit code, not the text. The
      // "head.json is absent" line was already printed; the exit code said success.
      await sink.putBatch(batch(1, GENESIS_PREV));

      // Control: with head.json in place the same walk is a clean 0.
      const clean = capture(new EvidenceVerify(['--org-id', ORG_ID, '--archive', root], config));
      await clean.run();
      expect(process.exitCode).toBeUndefined();

      await rm(join(root, `org_id=${ORG_ID}/_chain/head.json`));
      logged = [];
      const full = capture(new EvidenceVerify(['--org-id', ORG_ID, '--archive', root], config));
      const result = (await full.run()) as VerifyReport;

      expect(result.chain.valid).toBe(true);
      expect(result.breaks).toEqual([]);
      expect(out()).toMatch(/head\.json is absent/);
      expect(process.exitCode).toBe(EXIT.DEGRADED);
    });

    it('exits 3 with breaks in the returned payload when the chain is broken', async () => {
      await sink.putBatch(batch(1, GENESIS_PREV));
      await sink.putBatch(batch(3, `sha256:${'f'.repeat(64)}`));

      const cmd = capture(new EvidenceVerify(['--org-id', ORG_ID, '--archive', root], config));
      const result = (await cmd.run()) as VerifyReport;

      expect(process.exitCode).toBe(EXIT.INTEGRITY);
      expect(out()).toContain('chain: BROKEN');
      expect(result.breaks.length).toBeGreaterThan(0);
    });

    it('reports the git anchor as unevaluable against a local sink, without blaming the chain', async () => {
      await sink.putBatch(batch(1, GENESIS_PREV));

      const cmd = capture(
        new EvidenceVerify(['--org-id', ORG_ID, '--archive', root, '--anchor', 'git'], config),
      );
      const result = (await cmd.run()) as VerifyReport;

      expect(result.anchor.valid).toBe(false);
      expect(result.chain.valid).toBe(true);
      expect(out()).toContain('chain: VALID');
      expect(out()).toContain('anchor: git — INVALID');
      expect(process.exitCode).toBe(EXIT.INTEGRITY);
    });

    it('rejects an archive root that does not exist rather than creating one', async () => {
      const cmd = capture(
        new EvidenceVerify(['--org-id', ORG_ID, '--archive', join(root, 'nope')], config),
      );
      await expect(cmd.run()).rejects.toThrow(/does not exist/i);
    });
  });

  // `status` has its own suite, test/unit/commands/status.test.ts: its exit code depends on the
  // clock, and that suite pins it.

  describe('doctor', () => {
    it('doctor runs with no org', async () => {
      // Local sink on a real, writable temp root; no --target-org, so no org is contacted.
      const cmd = capture(new EvidenceDoctor(['--archive', root], config));
      const result = await cmd.run();

      expect(result.checks.length).toBeGreaterThan(5);
      expect(out()).toMatch(/^ok\s+Node version:/m);
      expect(out()).toContain('Archive reachable and writable');
      expect(out()).toContain('not checked: pass --target-org');
      expect(out()).toContain('not applicable in this release');
      // Exit follows the checks, never a throw.
      expect([undefined, EXIT.DEGRADED]).toContain(process.exitCode);
      expect(result.ok).toBe(process.exitCode === undefined);
    });

    it('doctor runs the doctor-checks hook', async () => {
      const row = { name: 'Query engine', level: 'ok', detail: 'DuckDB v1.5.6 (in-process, sandboxed)', checked: true };
      const runHook = jest.spyOn(config, 'runHook').mockResolvedValue({
        successes: [{ result: [row], plugin: { name: '@cclabsnz/sf-evidence-query' } }],
        failures: [{ error: new Error('boom'), plugin: { name: 'broken-plugin' } }],
      } as never);
      try {
        const result = await capture(new EvidenceDoctor(['--archive', root], config)).run();
        expect(runHook).toHaveBeenCalledWith('sf-evidence:doctor-checks', {});
        expect(result.checks).toContainEqual(row);
        expect(result.checks.some((c) => /not installed/.test(c.detail))).toBe(false);
        expect(result.checks).toContainEqual(
          expect.objectContaining({ name: 'broken-plugin', level: 'warn', detail: expect.stringContaining('boom') }),
        );
        expect(process.exitCode).toBe(EXIT.DEGRADED);
      } finally {
        runHook.mockRestore();
      }
    });

    it('doctor reports the query engine as not installed when no plugin answers the hook', async () => {
      const runHook = jest.spyOn(config, 'runHook').mockResolvedValue({ successes: [], failures: [] } as never);
      try {
        const result = await capture(new EvidenceDoctor(['--archive', root], config)).run();
        expect(result.checks).toContainEqual(
          expect.objectContaining({ name: 'Query engine', checked: false, detail: expect.stringContaining('not installed') }),
        );
        expect(process.exitCode).toBeUndefined();
      } finally {
        runHook.mockRestore();
      }
    });

    describe('a misbehaving doctor-checks hook', () => {
      const good = { name: 'Query engine', level: 'ok', detail: 'fine', checked: true };
      const plugin = { name: 'bad-plugin' };

      async function withHook(impl: () => unknown) {
        // oclif's own parse() also calls config.runHook (other events); only ours is stubbed.
        const real = config.runHook.bind(config);
        const runHook = jest
          .spyOn(config, 'runHook')
          .mockImplementation(((event: string, ...rest: unknown[]) =>
            event === 'sf-evidence:doctor-checks' ? impl() : (real as (...a: unknown[]) => unknown)(event, ...rest)) as never);
        try {
          return await capture(new EvidenceDoctor(['--archive', root], config)).run();
        } finally {
          runHook.mockRestore();
        }
      }

      const expectDegradedButComplete = (checks: { name: string; level: string }[], name: string) => {
        expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(['Node version', 'Clock skew against the org']));
        expect(checks.find((c) => c.name === name)?.level).toBe('warn');
        expect(process.exitCode).toBe(EXIT.DEGRADED);
        expect(out()).toMatch(/^warn\s+/m);
      };

      it('runHook rejecting yields one warn row, not a crash', async () => {
        const result = await withHook(async () => {
          throw new Error('loader exploded');
        });
        expectDegradedButComplete(result.checks, 'Doctor hook');
        expect(result.checks.find((c) => c.name === 'Doctor hook')?.detail).toContain('loader exploded');
      });

      it.each([
        ['undefined', undefined],
        ['a string', 'x'],
        ['an object', { name: 'x' }],
      ])('a result of %s becomes a warn row', async (_label, value) => {
        const result = await withHook(async () => ({ successes: [{ result: value, plugin }], failures: [] }));
        expectDegradedButComplete(result.checks, 'Doctor hook (bad-plugin)');
        expect(result.checks.find((c) => c.name === 'Doctor hook (bad-plugin)')?.detail).toMatch(/malformed/);
      });

      it('a malformed element in an array is replaced; the well-formed rows survive', async () => {
        const result = await withHook(async () => ({
          successes: [{ result: [good, null, { name: 'x', level: 'bogus', detail: 'd', checked: true }], plugin }],
          failures: [],
        }));
        expectDegradedButComplete(result.checks, 'Doctor hook (bad-plugin)');
        expect(result.checks).toContainEqual(good);
        expect(result.checks.filter((c) => c.name === 'Doctor hook (bad-plugin)')).toHaveLength(2);
      });

      it('a fail a plugin reports itself is kept and exits 1', async () => {
        const fail = { name: 'Query engine', level: 'fail', detail: 'broken', checked: true };
        const result = await withHook(async () => ({ successes: [{ result: [fail], plugin }], failures: [] }));
        expect(result.checks).toContainEqual(fail);
        expect(process.exitCode).toBe(EXIT.ERROR);
      });
    });

    it('contacts no org unless --target-org is given, whatever default org exists', async () => {
      // optionalOrg() resolves the configured default org when the flag is absent; this flag
      // must have no default, and an unflagged run must never reach the org resolver.
      expect((EvidenceDoctor.flags['target-org'] as { default?: unknown }).default).toBeUndefined();
      const spy = jest
        .spyOn(EvidenceDoctor.prototype as unknown as { orgClock: () => Promise<Date> }, 'orgClock')
        .mockResolvedValue(new Date());
      try {
        const cmd = capture(new EvidenceDoctor(['--archive', root], config));
        const result = await cmd.run();
        expect(spy).not.toHaveBeenCalled();
        const clock = result.checks.find((c) => c.name.startsWith('Clock'));
        expect(clock?.checked).toBe(false);

        await capture(new EvidenceDoctor(['--archive', root, '--target-org', 'prod'], config)).run();
        expect(spy).toHaveBeenCalledWith('prod');
      } finally {
        spy.mockRestore();
      }
    });

    it('exits 1 and keeps the payload when the archive does not exist', async () => {
      const cmd = capture(new EvidenceDoctor(['--archive', join(root, 'nope')], config));
      const result = await cmd.run();

      expect(process.exitCode).toBe(EXIT.ERROR);
      expect(result.checks.find((c) => c.name.startsWith('Archive'))?.level).toBe('fail');
      expect(existsSync(join(root, 'nope'))).toBe(false);
    });
  });

  describe('explain', () => {
    it('prints queries, writes, destinations and negative assertions, and exits 0', async () => {
      const cmd = capture(new EvidenceExplain(['--archive', root], config));
      const result = await cmd.run();

      expect(out()).toContain('QUERIES');
      expect(out()).toContain('SELECT Id FROM Organization LIMIT 1');
      expect(out()).toContain('[plugin, not a collector]');
      expect(out()).toContain('FILE WRITES');
      expect(out()).toContain('NETWORK DESTINATIONS');
      expect(out()).toContain('WHAT THIS PLUGIN DOES NOT DO');
      expect(result.destinations).toHaveLength(1);
      expect(process.exitCode).toBeUndefined();
    });

    it('prints a usable path for the git sink, not one with prose spliced into it', async () => {
      await run('git', ['init', '-b', 'main'], { cwd: root });
      const cmd = capture(new EvidenceExplain(['--archive', root, '--sink', 'git'], config));
      await cmd.run();

      for (const line of logged.filter((l) => l.includes('org_id=<org>'))) {
        expect(line).not.toContain('(git repository');
      }
      expect(out()).toContain('No git push is performed.');
    });
  });

  describe('collect', () => {
    /**
     * `collect` needs a `--target-org`, which `Flags.requiredOrg()` resolves through the sf
     * auth store — no test may point at a real org. The org-independent decisions the
     * command makes before that (`resolveSinks`) are the ones that used to fail late and
     * loudly after a partial write, so they are exercised through the command's own flag
     * plumbing here.
     */
    it('rejects two canonical sinks on one archive root before writing anything', () => {
      const cmd = new EvidenceCollect(['--sink', 'local,git', '--archive', root], config);
      expect(cmd).toBeInstanceOf(EvidenceCollect);
      // resolveSinks is the guard; the command wires --sink straight into it.
      expect(EvidenceCollect.flags.sink.default).toBe('local');
      expect(EvidenceCollect.flags.sign).toBeDefined();
    });

    it('declares --sign, so the git sink signing option is reachable from a command', () => {
      expect(EvidenceCollect.flags.sign.summary).toMatch(/sign each manifest commit/i);
    });

    it('reports an orphan file as found, never as adopted', async () => {
      const cmd = capture(new EvidenceCollect([], config));
      const orphan = 'org_id=x/source=audit-trail/year=2026/month=08/part-x.ndjson';
      (cmd as unknown as { report: (r: unknown) => void }).report({
        dryRun: false,
        sources: [],
        manifest: { seq: 1, hash: 'sha256:x', prev: GENESIS_PREV },
        manifests: [{ seq: 1, hash: 'sha256:x', prev: GENESIS_PREV }],
        sinks: [{ id: 'local', written: true }],
        orphansFound: [{ relPath: orphan, bytes: 10 }],
        metadata: { written: [], prepared: [] },
      });

      expect(warned.join('\n')).toMatch(/reported, not adopted/i);
    });

    it('reports a written sink whose anchor commit failed as written, and warns', async () => {
      // Not "NOT written": the batch is on disk. The operator needs both facts, and being
      // told only one of them sends them looking for data that is already there.
      const cmd = capture(new EvidenceCollect([], config));
      (cmd as unknown as { report: (r: unknown) => void }).report({
        dryRun: false,
        sources: [],
        manifest: { seq: 1, hash: 'sha256:x', prev: GENESIS_PREV },
        manifests: [{ seq: 1, hash: 'sha256:x', prev: GENESIS_PREV }],
        sinks: [
          {
            id: 'git',
            written: true,
            error: 'the batch was archived, but the git anchor commit failed: no identity.',
          },
        ],
        orphansFound: [],
        metadata: { written: [], prepared: [] },
      });

      expect(out()).toContain('git: written');
      expect(out()).not.toMatch(/NOT written/);
      expect(warned.join('\n')).toMatch(/the batch was archived, but the git anchor commit failed/);
    });

    it('warns loudly about a sink that did not take the batch', async () => {
      const cmd = capture(new EvidenceCollect([], config));
      (cmd as unknown as { report: (r: unknown) => void }).report({
        dryRun: false,
        sources: [],
        manifest: { seq: 1, hash: 'sha256:x', prev: GENESIS_PREV },
        manifests: [{ seq: 1, hash: 'sha256:x', prev: GENESIS_PREV }],
        sinks: [
          { id: 'local', written: true },
          { id: 'git', written: false, error: 'disk full' },
        ],
        orphansFound: [],
        metadata: { written: [], prepared: [] },
      });

      expect(warned.join('\n')).toMatch(/git: NOT written — disk full/);
      expect(warned.join('\n')).toMatch(/stays at its previous head/);
    });

    it('warns with the remediation attached when a source degraded', async () => {
      const cmd = capture(new EvidenceCollect([], config));
      (cmd as unknown as { report: (r: unknown) => void }).report({
        dryRun: true,
        sources: [
          {
            source: 'audit-trail',
            status: 'degraded',
            window: { from: 'a', to: 'b' },
            queried: [{ from: 'a', to: 'b' }],
            achieved: [],
            recordsFetched: 0,
            recordsWritten: 0,
            recordsDeduped: 0,
            files: [],
            degradations: [
              {
                source: 'audit-trail',
                code: 'INSUFFICIENT_ACCESS',
                detail: 'no access',
                remediation: 'grant View Setup and Configuration',
              },
            ],
          },
        ],
        manifest: { seq: 1, hash: 'sha256:x', prev: GENESIS_PREV },
        manifests: [{ seq: 1, hash: 'sha256:x', prev: GENESIS_PREV }],
        sinks: [],
        orphansFound: [],
        metadata: { written: [], prepared: [] },
      });

      expect(out()).toContain('DRY RUN');
      expect(warned.join('\n')).toContain('INSUFFICIENT_ACCESS');
      expect(warned.join('\n')).toContain('grant View Setup and Configuration');
    });

    it('prints each queried window, never the span across a gap-repair run', async () => {
      const cmd = capture(new EvidenceCollect([], config));
      (cmd as unknown as { report: (r: unknown) => void }).report({
        dryRun: true,
        sources: [
          {
            source: 'audit-trail',
            status: 'complete',
            window: { from: '2026-02-16T10:00:00.000Z', to: '2026-08-15T10:00:00.000Z' },
            queried: [
              { from: '2026-02-16T10:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
              { from: '2026-08-15T08:45:00.000Z', to: '2026-08-15T10:00:00.000Z' },
            ],
            achieved: [
              { from: '2026-02-16T10:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
              { from: '2026-08-15T08:45:00.000Z', to: '2026-08-15T10:00:00.000Z' },
            ],
            recordsFetched: 0,
            recordsWritten: 0,
            recordsDeduped: 0,
            files: [],
            degradations: [],
          },
        ],
        manifest: { seq: 1, hash: 'sha256:x', prev: GENESIS_PREV },
        manifests: [{ seq: 1, hash: 'sha256:x', prev: GENESIS_PREV }],
        sinks: [],
        orphansFound: [],
        metadata: { written: [], prepared: [] },
      });

      expect(out()).toContain('queried  2026-02-16T10:00:00.000Z → 2026-03-01T00:00:00.000Z');
      expect(out()).toContain('queried  2026-08-15T08:45:00.000Z → 2026-08-15T10:00:00.000Z');
      expect(out()).not.toContain('2026-02-16T10:00:00.000Z → 2026-08-15T10:00:00.000Z');
    });
  });

  describe('exit-code plumbing', () => {
    it('never calls the throwing this.exit(), so --json keeps its result payload', async () => {
      // SPEC.md §8.2's worked JSON example shows a degraded source inside `result`.
      // SfCommand.exit() throws, which replaces the envelope with the error form and
      // discards `result` — exactly on the runs whose payload matters most.
      const src = await import('node:fs/promises').then((fs) =>
        Promise.all(
          ['collect.ts', 'status.ts', 'verify.ts'].map((f) =>
            fs.readFile(join(process.cwd(), 'src/commands/evidence', f), 'utf8'),
          ),
        ),
      );
      for (const text of src) {
        expect(text).not.toMatch(/this\.exit\(/);
      }
    });

    it('leaves process.exitCode untouched for a successful run', async () => {
      await writeFile(join(root, 'unrelated.txt'), 'x');
      const cmd = capture(new EvidenceExplain(['--archive', root], config));
      await cmd.run();
      expect(process.exitCode).toBeUndefined();
    });
  });
});
