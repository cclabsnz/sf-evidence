import { jest } from '@jest/globals';
import { EXIT } from '../../../src/lib/exit.js';
import { sfApiError } from '../../fixtures/httpApiError.js';
import {
  doctorExitCode,
  formatChecks,
  runChecks,
  type Check,
  type DoctorEnv,
} from '../../../src/lib/doctor.js';
import type { Sink } from '../../../src/types/sink.js';

const NA = 'not applicable in this release';

function fakeSink(over: Partial<Sink> & { id?: string } = {}): Sink {
  return {
    id: 'local',
    init: async () => undefined,
    describe: () => ({ location: '/archive' }),
    head: async () => null,
    ...over,
  } as unknown as Sink;
}

function env(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    nodeVersion: 'v22.4.0',
    versions: { plugin: '0.1.0', engine: '0.1.0' },
    sink: fakeSink(),
    which: async () => '/usr/bin/tool',
    gitConfig: async () => 'KEYID',
    ...over,
  };
}

const find = (checks: Check[], needle: string): Check => {
  const c = checks.find((x) => x.name.toLowerCase().includes(needle));
  if (!c) throw new Error(`no check named like '${needle}': ${checks.map((x) => x.name).join(', ')}`);
  return c;
};

describe('doctor', () => {
  it('fails on Node 20', async () => {
    const checks = await runChecks(env({ nodeVersion: 'v20.11.1' }));
    const node = find(checks, 'node');
    expect(node.level).toBe('fail');
    expect(node.remediation).toMatch(/22/);
    expect(find(await runChecks(env({ nodeVersion: '22.0.0' })), 'node').level).toBe('ok');
  });

  it('no extra checks reports query engine not installed, unchecked', async () => {
    for (const extraChecks of [undefined, async () => []]) {
      const checks = await runChecks(env({ extraChecks }));
      const q = find(checks, 'query engine');
      expect(q).toEqual({
        name: 'Query engine',
        level: 'ok',
        detail: 'not installed (sf plugins install @cclabsnz/sf-evidence-query)',
        checked: false,
      });
      expect(doctorExitCode(checks)).toBe(EXIT.OK);
    }
  });

  it('extra checks replace the placeholder', async () => {
    const extra: Check = { name: 'Query engine', level: 'ok', detail: 'DuckDB v1.5.6 (in-process, sandboxed)', checked: true };
    const checks = await runChecks(env({ extraChecks: async () => [extra] }));
    expect(checks.filter((c) => c.name === 'Query engine')).toEqual([extra]);
    expect(checks.some((c) => /not installed/.test(c.detail))).toBe(false);
  });

  it('no longer looks for duckdb on PATH', async () => {
    const which = jest.fn(async () => '/usr/bin/tool');
    const checks = await runChecks(env({ which }));
    expect(which).not.toHaveBeenCalledWith('duckdb');
    expect(checks.some((c) => /on PATH/.test(c.name))).toBe(false);
  });

  it('lists not-applicable checks rather than omitting them', async () => {
    const checks = await runChecks(env());
    for (const needle of ['cloud credentials', 'licence', 'config file']) {
      const c = find(checks, needle);
      expect(c.level).toBe('ok');
      expect(c.detail).toBe(NA);
      expect(c.checked).toBe(false);
    }
  });

  it('exit is 1 on any fail, 4 on any warn, 0 otherwise', async () => {
    const ok: Check = { name: 'a', level: 'ok', detail: '', checked: true };
    const warn: Check = { name: 'b', level: 'warn', detail: '', checked: true };
    const fail: Check = { name: 'c', level: 'fail', detail: '', checked: true };
    expect(doctorExitCode([ok])).toBe(EXIT.OK);
    expect(doctorExitCode([ok, warn])).toBe(EXIT.DEGRADED);
    expect(doctorExitCode([ok, warn, fail])).toBe(EXIT.ERROR);
    expect(doctorExitCode(await runChecks(env()))).toBe(EXIT.OK);
  });

  it('fails the archive check with the sink error, and still runs the other checks', async () => {
    const sink = fakeSink({ init: async () => { throw new Error('Archive root does not exist: /x'); } });
    const checks = await runChecks(env({ sink }));
    expect(find(checks, 'archive').level).toBe('fail');
    expect(find(checks, 'archive').detail).toMatch(/does not exist/);
    expect(find(checks, 'node').level).toBe('ok');
  });

  it('reads the chain head only when an org id is given, and says so when it did not', async () => {
    const head = jest.fn(async () => ({ seq: 3, manifest_hash: 'sha256:x', updated_at: 't' }));
    const without = await runChecks(env({ sink: fakeSink({ head }) }));
    expect(head).not.toHaveBeenCalled();
    expect(find(without, 'chain head').detail).toMatch(/not checked/i);
    expect(find(without, 'chain head').checked).toBe(false);

    const withOrg = await runChecks(env({ sink: fakeSink({ head }), orgId: '00Dx' }));
    expect(head).toHaveBeenCalledWith('00Dx');
    expect(find(withOrg, 'chain head').detail).toMatch(/seq 3/);
  });

  it('fails the chain head on a parse error or a malformed head', async () => {
    const bad = await runChecks(
      env({ orgId: '00Dx', sink: fakeSink({ head: async () => { throw new SyntaxError('Unexpected token'); } }) }),
    );
    expect(find(bad, 'chain head').level).toBe('fail');
    const shape = await runChecks(
      env({ orgId: '00Dx', sink: fakeSink({ head: async () => ({ nope: 1 }) as never }) }),
    );
    expect(find(shape, 'chain head').level).toBe('fail');
  });

  it('checks git only for a git sink, and warns when git or a signing key is missing', async () => {
    expect(await runChecks(env())).not.toContainEqual(expect.objectContaining({ name: expect.stringMatching(/git/i) }));

    const gitSink = fakeSink({ id: 'git' as never });
    const ok = await runChecks(env({ sink: gitSink }));
    expect(find(ok, 'git signing').level).toBe('ok');

    const noKey = await runChecks(env({ sink: gitSink, gitConfig: async () => null }));
    expect(find(noKey, 'git signing').level).toBe('warn');

    const noGit = await runChecks(env({ sink: gitSink, which: async (c) => (c === 'git' ? null : '/x') }));
    expect(find(noGit, 'git present').level).toBe('warn');
  });

  it('checks clock skew only with an org clock, warning above 5 minutes', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const skewed = await runChecks(env({ now: () => now, orgNow: async () => new Date(now.getTime() + 6 * 60_000) }));
    expect(find(skewed, 'clock').level).toBe('warn');
    // Skew affects collection (SPEC.md §10.8): it is a warning to act on, not advisory.
    expect(find(skewed, 'clock').detail).not.toMatch(/advisory/i);
    expect(find(skewed, 'clock').remediation).toMatch(/collect/);
    const fine = await runChecks(env({ now: () => now, orgNow: async () => new Date(now.getTime() - 4 * 60_000) }));
    expect(find(fine, 'clock').level).toBe('ok');
    const none = await runChecks(env());
    expect(find(none, 'clock').detail).toMatch(/not checked/i);
    expect(find(none, 'clock').checked).toBe(false);
    expect(find(fine, 'clock').checked).toBe(true);
    const broken = await runChecks(env({ orgNow: async () => { throw new Error('boom'); } }));
    expect(find(broken, 'clock').level).toBe('warn');
    expect(find(broken, 'clock').checked).toBe(false);
  });

  it('warns, rather than aborting, when package versions cannot be read', async () => {
    const checks = await runChecks(env({ versions: { error: 'ENOENT: no such file' } }));
    const v = find(checks, 'versions');
    expect(v.level).toBe('warn');
    expect(v.detail).toMatch(/ENOENT/);
    expect(find(checks, 'node').level).toBe('ok');
  });

  it('reports the signing key as not checked, never "not set", when git could not look', async () => {
    const gitSink = fakeSink({ id: 'git' as never });

    const archiveBad = fakeSink({ id: 'git' as never, init: async () => { throw new Error('nope'); } });
    const gitConfig = jest.fn(async () => null);
    const a = find(await runChecks(env({ sink: archiveBad, gitConfig })), 'git signing');
    expect(a.checked).toBe(false);
    expect(a.detail).not.toMatch(/is not set/);
    expect(gitConfig).not.toHaveBeenCalled();

    const b = find(
      await runChecks(env({ sink: gitSink, gitConfig: async () => { throw new Error('exit 128'); } })),
      'git signing',
    );
    expect(b.checked).toBe(false);
    expect(b.detail).toMatch(/not checked/);

    const c = find(await runChecks(env({ sink: gitSink, gitConfig: async () => null })), 'git signing');
    expect(c.checked).toBe(true);
    expect(c.detail).toMatch(/not set/);
  });

  it('marks rows that looked at something as checked', async () => {
    const checks = await runChecks(env());
    expect(find(checks, 'node').checked).toBe(true);
    expect(find(checks, 'archive').checked).toBe(true);
  });

  it('renders one line per check, skipped rows as skipped, remediation beneath', async () => {
    const lines = formatChecks([
      { name: 'DuckDB', level: 'warn', detail: 'not on PATH', remediation: 'install it', checked: true },
      { name: 'Node', level: 'ok', detail: 'v22', checked: true },
      { name: 'Licence', level: 'ok', detail: 'not applicable in this release', checked: false },
    ]);
    expect(lines).toEqual([
      'warn    DuckDB: not on PATH',
      '        fix: install it',
      'ok      Node: v22',
      'skipped Licence: not applicable in this release',
    ]);
  });

  describe('Login History access', () => {
    const apiError = (errorCode: string) => Object.assign(new Error(`${errorCode}: nope`), { errorCode, statusCode: 400, name: 'ApiError' });

    it('is not checked without a probe', async () => {
      const c = find(await runChecks(env()), 'login history');
      expect(c).toMatchObject({
        name: 'Login History access',
        level: 'ok',
        checked: false,
        detail: 'not checked: pass --target-org to test access',
      });
    });

    it('is ok and checked when the probe resolves', async () => {
      const c = find(await runChecks(env({ probeLoginHistory: async () => undefined })), 'login history');
      expect(c.level).toBe('ok');
      expect(c.checked).toBe(true);
    });

    it.each(['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INVALID_TYPE'])(
      'warns and names the permission on %s',
      async (code) => {
        const checks = await runChecks(env({ probeLoginHistory: async () => Promise.reject(apiError(code)) }));
        const c = find(checks, 'login history');
        expect(c.level).toBe('warn');
        expect(c.checked).toBe(true);
        expect(`${c.detail} ${c.remediation ?? ''}`).toContain('Monitor Login History');
        expect(`${c.detail} ${c.remediation ?? ''}`).toContain('MonitorLoginHistory');
        expect(doctorExitCode(checks)).toBe(EXIT.DEGRADED);
      },
    );

    it.each(['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INVALID_TYPE'])(
      'names the permission on a real-shape %s (no statusCode)',
      async (code) => {
        const checks = await runChecks(env({ probeLoginHistory: async () => Promise.reject(sfApiError(code)) }));
        const c = find(checks, 'login history');
        expect(c.level).toBe('warn');
        expect(c.detail).toContain(`(${code})`);
        expect(c.detail).toContain('MonitorLoginHistory');
      },
    );

    it('warns with the message on any other failure', async () => {
      const c = find(
        await runChecks(env({ probeLoginHistory: async () => Promise.reject(new Error('socket hang up')) })),
        'login history',
      );
      expect(c.level).toBe('warn');
      expect(c.detail).toContain('socket hang up');
    });

    it('sits right after the clock check', async () => {
      const names = (await runChecks(env())).map((x) => x.name);
      expect(names.indexOf('Login History access')).toBe(names.indexOf('Clock skew against the org') + 1);
    });
  });
});
