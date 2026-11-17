import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, Parser } from '@oclif/core';
import EvidenceCollect from '../../../src/commands/evidence/collect.js';
import { API_VERSION } from '@cclabsnz/sf-evidence-engine';
import { ORG_ID } from '@cclabsnz/sf-evidence-engine/testing';
import { resolveSink, resolveSinks, DEFAULT_ARCHIVE } from '../../../src/lib/flags.js';
import { LocalSink } from '@cclabsnz/sf-evidence-engine';
import { GitSink } from '@cclabsnz/sf-evidence-engine';
import { EXIT } from '@cclabsnz/sf-evidence-engine';
import { exitCodeFor } from '../../../src/lib/flags.js';

describe('resolveSink', () => {
  it('defaults the archive to ./sf-evidence-archive, so Tier 0 needs no configuration', () => {
    expect(DEFAULT_ARCHIVE).toBe('./sf-evidence-archive');
  });

  it('builds a LocalSink for id "local"', () => {
    expect(resolveSink('local', '/tmp/x')).toBeInstanceOf(LocalSink);
  });

  it('builds a GitSink for id "git"', () => {
    expect(resolveSink('git', '/tmp/x')).toBeInstanceOf(GitSink);
  });

  it('rejects a sink that is not implemented yet, naming what is', () => {
    expect(() => resolveSink('s3', '/tmp/x')).toThrow(/not available.*local, git/is);
  });

  it('passes signing options through to the git sink, so they are reachable from a command', () => {
    // GitSinkOptions used to be unreachable: resolveSink constructed `new GitSink(root)`
    // with no options, so neither `sign` nor `requireSigned` could be enabled by any user
    // while the anchor statement claimed the signing key was part of the guarantee.
    const sink = resolveSink('git', '/tmp/x', { sign: true, requireSigned: true });
    expect(sink).toBeInstanceOf(GitSink);
  });
});

describe('resolveSinks', () => {
  it('rejects two canonical sinks that resolve to the same archive root', () => {
    // `--sink local,git` against one root used to be accepted, write records, and then throw
    // "Manifest sequence 1 already exists" — a concurrency message for a configuration
    // error, raised after a partial write.
    expect(() => resolveSinks(['local', 'git'], '/tmp/one-archive')).toThrow(
      /same archive root/i,
    );
  });

  it('names both sinks and explains why git is not a second copy', () => {
    expect(() => resolveSinks(['local', 'git'], '/tmp/one-archive')).toThrow(
      /'local' and 'git'[\s\S]*not a second copy/i,
    );
  });

  it('rejects the same root spelled two different ways', () => {
    expect(() => resolveSinks(['local', 'local'], './x')).toThrow(/same archive root/i);
  });

  it('accepts a single sink', () => {
    expect(resolveSinks(['git'], '/tmp/one-archive')).toHaveLength(1);
  });

  it('trims whitespace from a comma-separated list', () => {
    expect(resolveSinks([' local '], '/tmp/x')[0]).toBeInstanceOf(LocalSink);
  });
});

describe('exitCodeFor', () => {
  it('is OK when nothing degraded, regardless of --fail-on-degraded', () => {
    expect(exitCodeFor({ degraded: false }, false)).toBe(EXIT.OK);
    expect(exitCodeFor({ degraded: false }, true)).toBe(EXIT.OK);
  });

  it('is DEGRADED when any source had reduced coverage and --fail-on-degraded is off', () => {
    // The code is what makes a silent gap surface in CI on the day it starts.
    expect(exitCodeFor({ degraded: true }, false)).toBe(EXIT.DEGRADED);
  });

  it('is ERROR when any source had reduced coverage and --fail-on-degraded is on', () => {
    // Strict CI wants a 1, not a 4, so it can treat this the same as any other failure.
    expect(exitCodeFor({ degraded: true }, true)).toBe(EXIT.ERROR);
  });
});

describe('collect command', () => {
  let config: Config;
  let root: string;
  let logged: string[];
  let warned: string[];
  let requested: Array<string | undefined>;
  let requests: string[];
  let queryVersions: string[];

  beforeAll(async () => {
    config = await Config.load({ root: process.cwd(), userPlugins: false, devPlugins: false });
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-collect-'));
    logged = [];
    warned = [];
    requested = [];
    requests = [];
    queryVersions = [];
    delete process.exitCode;
  });
  afterEach(async () => {
    delete process.exitCode;
    await rm(root, { recursive: true, force: true });
  });

  /**
   * A Connection whose default API version is not the engine's, as a real org's is: an
   * unpinned connection would send every request to v40.0 here, and the assertions below
   * would see it.
   */
  function fakeOrg(remaining = 4_000_000) {
    return {
      getConnection: (version?: string) => {
        requested.push(version);
        const v = version ?? '40.0';
        return {
          instanceUrl: 'https://example.my.salesforce.com',
          getApiVersion: () => v,
          query: async () => {
            queryVersions.push(v);
            return {
              totalSize: 1,
              done: true,
              records: [
                { Id: ORG_ID, Name: 'Acme', OrganizationType: 'Enterprise Edition', InstanceName: 'AP1', IsSandbox: false },
              ],
            };
          },
          autoFetchQuery: async () => {
            queryVersions.push(v);
            return { records: [] };
          },
          request: async (url: string) => {
            requests.push(url);
            return { DailyApiRequests: { Max: 5_000_000, Remaining: remaining } };
          },
        };
      },
    };
  }

  async function run(overrides: Record<string, unknown> = {}, org = fakeOrg()) {
    const cmd = new EvidenceCollect([], config);
    (cmd as unknown as { log: (m?: string) => void }).log = (m = '') => void logged.push(m);
    (cmd as unknown as { warn: (m: string) => string }).warn = (m: string) => {
      warned.push(m);
      return m;
    };
    (cmd as unknown as { parse: () => Promise<unknown> }).parse = async () => ({
      flags: {
        'target-org': org,
        source: 'audit-trail',
        sink: 'local',
        archive: root,
        'dry-run': false,
        'fail-on-degraded': false,
        sign: false,
        ...overrides,
      },
    });
    return cmd.run();
  }

  it('pins the connection to the engine API version, so every SOQL and REST call uses it', async () => {
    await run({ source: 'limits' });
    expect(requested).toEqual([API_VERSION]);
    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) expect(url).toContain(`/services/data/v${API_VERSION}/`);
    expect(queryVersions.length).toBeGreaterThan(0);
    for (const v of queryVersions) expect(v).toBe(API_VERSION);
  });

  it('--source limits collects one sample', async () => {
    const result = await run({ source: 'limits' });
    const s = result.sources[0]!;
    expect(result.sources).toHaveLength(1);
    expect(s.source).toBe('limits');
    expect(s.status).toBe('complete');
    expect(s.recordsWritten).toBe(1);
    expect(requests).toEqual([`/services/data/v${API_VERSION}/limits/`]);
  });

  it('prints when a snapshot source was sampled, not a covered range', async () => {
    const result = await run({ source: 'limits' });
    const out = logged.join('\n');
    expect(out).toContain(`sampled at ${result.sources[0]!.sampledAt}`);
    expect(result.sources[0]!.sampledAt).toBeDefined();
    expect(out).not.toMatch(/covered|queried/);
  });

  it('says a deduplicated sample was not stored', async () => {
    await run({ source: 'limits' });
    logged.length = 0;
    await run({ source: 'limits' });
    expect(logged.join('\n')).toMatch(/sampled at \S+ \(duplicate of this hour's stored sample, not stored\)/);
  });

  it('--backfill forces the full window on an archive with coverage', async () => {
    const first = await run();
    const second = await run();
    const forced = await run({ backfill: true });
    const day = 86_400_000;
    const span = (r: typeof first) => Date.parse(r.sources[0]!.queried[0]!.to) - Date.parse(r.sources[0]!.queried[0]!.from);

    expect(span(first)).toBeGreaterThan(170 * day);
    expect(span(second)).toBeLessThan(day);
    expect(span(forced)).toBeGreaterThan(170 * day);
  });

  it('--since accepts a duration', async () => {
    const result = await run({ since: 'P30D' });
    const from = Date.parse(result.sources[0]!.queried[0]!.from);
    expect(Date.now() - from).toBeGreaterThan(30 * 86_400_000 - 60_000);
    expect(Date.now() - from).toBeLessThan(30 * 86_400_000 + 60_000);
  });

  it('rejects an ambiguous --since as a usage error (exit 2) before querying the org', async () => {
    const err = await run({ since: 'P1M' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/--since/);
    expect((err as { oclif?: { exit?: number } }).oclif?.exit).toBe(2);
    expect(queryVersions).toEqual([]);
  });

  it('passes --api-floor to the engine: a long collection under the floor is refused with its detail and remediation', async () => {
    const result = await run({ 'api-floor': 1_000_000 }, fakeOrg(90_000));
    const s = result.sources[0]!;
    expect(s.degradations[0]!.code).toBe('API_BUDGET_FLOOR');
    expect(s.recordsWritten).toBe(0);
    const text = warned.join('\n');
    expect(text).toContain('API_BUDGET_FLOOR');
    expect(text).toContain('DailyApiRequests.Remaining is 90000');
    expect(text).toContain('--api-floor');
    expect(process.exitCode).toBe(4);
  });

  it('says so when a guarded source ran without its API budget being checked', async () => {
    const org = fakeOrg();
    const conn = org.getConnection;
    org.getConnection = (v?: string) => {
      const c = conn(v);
      c.request = async () => {
        throw new Error('boom');
      };
      return c;
    };
    const result = await run({}, org);
    expect(result.sources[0]!.apiBudgetChecked).toBe(false);
    expect(warned.join('\n')).toMatch(/audit-trail: API budget was not checked/);
  });

  it('names the actual reason when /limits/ has no usable DailyApiRequests', async () => {
    const org = fakeOrg();
    const conn = org.getConnection;
    org.getConnection = (v?: string) => {
      const c = conn(v);
      c.request = async () => ({}) as never;
      return c;
    };
    await run({}, org);
    expect(warned.join('\n')).toMatch(/API budget was not checked.*DailyApiRequests/);
    expect(warned.join('\n')).not.toMatch(/could not be read/);
  });

  it('puts achieved in the result, and prints covered ranges apart from queried ones', async () => {
    const result = await run({ source: 'audit-trail' });
    expect(Array.isArray(result.sources[0]!.achieved)).toBe(true);
    expect(result.sources[0]!.achieved).toHaveLength(1);
    expect(logged.join('\n')).toMatch(/queried {2}.*\n\s+covered {2}/);
  });

  it('says covered nothing for a refused source, rather than leaving the queried window to imply coverage', async () => {
    const result = await run({ 'api-floor': 1_000_000 }, fakeOrg(90_000));
    expect(result.sources[0]!.achieved).toEqual([]);
    expect(logged.join('\n')).toContain('covered  nothing');
  });

  it('prints nothing about the budget when it was checked', async () => {
    await run();
    expect([...logged, ...warned].join('\n')).not.toMatch(/not checked/i);
  });

  it('describes every kind of org read, not SOQL alone', () => {
    expect(EvidenceCollect.description).not.toMatch(/SOQL SELECT only/);
    expect(EvidenceCollect.description).toMatch(/REST GET/);
    expect(EvidenceCollect.description).toMatch(/\/limits\//);
  });

  /** fakeOrg, plus a transport whose responses carry the org's clock in a Date header. */
  function orgWithClock(orgNow: Date) {
    const org = fakeOrg();
    const conn = org.getConnection;
    org.getConnection = (v?: string) => {
      const c = conn(v) as ReturnType<typeof conn> & { _transport?: unknown };
      const base = c.request;
      c._transport = { httpRequest: async () => ({ headers: { date: orgNow.toUTCString() } }) };
      c.request = (async (req: unknown, opts?: { transport?: { httpRequest(r: unknown): Promise<unknown> } }) => {
        if (opts?.transport) return opts.transport.httpRequest(req);
        return base(req as string);
      }) as typeof c.request;
      return c;
    };
    return org;
  }

  it('ends the window at the org clock when this machine runs ahead of it', async () => {
    const orgNow = new Date(Math.floor((Date.now() - 10 * 60_000) / 1000) * 1000);
    const result = await run({}, orgWithClock(orgNow));
    expect(result.clock).toBe('org');
    expect(result.sources[0]!.queried.at(-1)!.to).toBe(orgNow.toISOString());
  });

  it('records clock local, and warns, when the org clock cannot be read', async () => {
    const result = await run();
    expect(result.clock).toBe('local');
    expect(warned.join('\n')).toMatch(/this machine's clock, because the org clock was not available/);
  });

  it.each([
    [{ until: '2026-08-01T00:00:00' }, /--until/],
    [{ until: 'P1M' }, /--until/],
    [{ since: '2999-01-01' }, /--since .*later than now/],
    [{ until: '2999-01-01' }, /--until .*later than now/],
  ])('rejects %j as a usage error (exit 2) before querying the org', async (flags, message) => {
    const err = await run(flags).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(message);
    expect((err as { oclif?: { exit?: number } }).oclif?.exit).toBe(2);
    expect(queryVersions).toEqual([]);
  });

  describe('--api-floor', () => {
    const parse = (v: string) =>
      Parser.parse([`--api-floor=${v}`], { flags: { 'api-floor': EvidenceCollect.flags['api-floor'] } });

    it('accepts 0 and a positive integer', async () => {
      expect((await parse('0')).flags['api-floor']).toBe(0);
      expect((await parse('7000')).flags['api-floor']).toBe(7000);
    });

    it('rejects a negative value and a non-integer', async () => {
      await expect(parse('-1')).rejects.toThrow();
      await expect(parse('1.5')).rejects.toThrow();
      await expect(parse('abc')).rejects.toThrow();
    });
  });
});
