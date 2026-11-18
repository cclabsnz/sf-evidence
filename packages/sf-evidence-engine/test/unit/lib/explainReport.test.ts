// The pure content of `explain`. The command wrapper that renders it is exercised in
// test/unit/commands/commands.test.ts.
import { buildExplanation } from '../../../src/lib/explainReport.js';
import { COLLECTORS } from '../../../src/collectors/registry.js';
import { LocalSink } from '../../../src/sinks/local.js';
import { GitSink } from '../../../src/sinks/git.js';
import { foreignGitSink } from '../../fixtures/foreignGitSink.js';

describe('buildExplanation', () => {
  it('states the no-push assertion for a GitSink from another installed copy of the engine', () => {
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [foreignGitSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    expect(e.assertions.map((x) => x.claim)).toContain('No git push is performed.');
  });

  const explanation = () =>
    buildExplanation({
      sources: ['audit-trail'],
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });

  it('lists every query each configured collector will issue', () => {
    const e = explanation();
    const collectorQueries = e.queries.filter((q) => q.scope !== 'plugin');
    expect(collectorQueries).toHaveLength(1);
    expect(collectorQueries[0]!.object).toBe('SetupAuditTrail');
    expect(collectorQueries[0]!.soql).toContain('DelegateUser');
  });

  it('lists the org-id lookup that no collector owns, marked as plugin-level', () => {
    // `collect` issues this before any collector runs. A reviewer who audits with `explain`
    // and then watches the org's API log must not find a query this list omitted.
    const plugin = explanation().queries.filter((q) => q.scope === 'plugin');
    expect(plugin).toHaveLength(4);
    expect(plugin[0]!.soql).toBe('SELECT Id FROM Organization LIMIT 1');
    expect(plugin[0]!.object).toBe('Organization');
  });

  it('discloses the org clock read, issued by collect on every run and by doctor with --target-org', () => {
    const clock = explanation().queries.find((q) => q.soql === 'GET /services/data/');
    expect(clock?.scope).toBe('plugin');
    expect(clock?.object).not.toMatch(/doctor .*only/i);
    expect(clock?.note).toMatch(/collect/);
    expect(clock?.note).toMatch(/--target-org/);
  });

  it('lists the API budget read collect issues for an event source, with when it is issued', () => {
    const budget = explanation().queries.filter(
      (q) => q.scope === 'plugin' && q.soql === 'GET /services/data/v64.0/limits/',
    );
    expect(budget).toHaveLength(1);
    expect(budget[0]!.permission).toMatch(/View Setup and Configuration/);
    expect(budget[0]!.note).toMatch(/7 days/);
    expect(budget[0]!.note).toMatch(/DailyApiRequests/);
  });

  it('does not list the API budget read when no event source is configured', () => {
    const e = buildExplanation({
      sources: ['limits'],
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    expect(e.queries.filter((q) => q.scope === 'plugin' && q.soql.endsWith('/limits/'))).toEqual([]);
  });

  it('tells the reader to re-derive with pnpm, not npm', () => {
    const text = explanation().assertions.map((a) => a.mechanism).join('\n');
    expect(text).toContain('pnpm test');
    expect(text).not.toMatch(/(^|[^p])npm test/);
  });

  it('lists the limits REST read', () => {
    const e = buildExplanation({
      sources: ['limits'],
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    const q = e.queries.find((x) => x.object === 'limits');
    expect(q).toBeDefined();
    expect(q!.soql).toBe('GET /services/data/v64.0/limits/');
    expect(q!.scope).toBe('collector');
    expect(q!.permission).toMatch(/View Setup and Configuration/);
    expect(e.destinations[0]!.purpose).toMatch(/REST GET/);
  });

  it('names the permission each query requires', () => {
    for (const q of explanation().queries) {
      expect(q.permission.length).toBeGreaterThan(0);
    }
    expect(
      explanation().queries.find((q) => q.object === 'SetupAuditTrail')!.permission,
    ).toMatch(/View Setup and Configuration/i);
  });

  it('covers every registered collector, so none can query unannounced', () => {
    const e = buildExplanation({
      sources: Object.keys(COLLECTORS) as Array<'audit-trail' | 'limits'>,
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    expect(e.queries.length).toBeGreaterThanOrEqual(Object.keys(COLLECTORS).length);
  });

  it('builds a usable filesystem path for the git sink, not one containing prose', () => {
    // `describe().destination` used to carry a parenthetical for GitSink, so `explain --sink
    // git` printed `/tmp/archive (git repository, local commits only)/org_id=<org>/...` —
    // an invalid path, in the artifact a security reviewer reads instead of the source.
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [new GitSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    const paths = e.writes.filter((w) => w.includes('org_id=<org>'));
    expect(paths.length).toBeGreaterThan(0);
    for (const w of paths) {
      expect(w).toMatch(/^\/tmp\/archive\/org_id=<org>\//);
      expect(w).not.toContain('(');
    }
    // The prose is still shown — as its own line, not spliced into a path.
    expect(e.writes.some((w) => w.includes('git repository, local commits only'))).toBe(true);
  });

  it('lists exactly one network destination for a Tier 0 configuration', () => {
    // The whole commercial position rests on this list being short and checkable.
    const e = explanation();
    expect(e.destinations).toHaveLength(1);
    expect(e.destinations[0]!.host).toBe('example.my.salesforce.com');
    expect(e.destinations[0]!.credentialSource).toMatch(/sf CLI/i);
  });

  it('lists the archive paths it will write', () => {
    const e = explanation();
    expect(e.writes.some((w) => w.includes('/tmp/archive'))).toBe(true);
    expect(e.writes.some((w) => w.includes('_chain'))).toBe(true);
  });

  it('states the write ordering invariant', () => {
    expect(explanation().writes.join('\n')).toMatch(/records.*manifest.*head/is);
  });

  it('carries the negative assertions with the mechanism that backs each', () => {
    const a = explanation().assertions;
    expect(a.some((x) => /no DML/i.test(x.claim) && /invariant test/i.test(x.mechanism))).toBe(true);
    expect(a.some((x) => /telemetry/i.test(x.claim))).toBe(true);
    expect(a.some((x) => /infrastructure/i.test(x.claim))).toBe(true);
  });

  it('explain states the query plugin\'s sandbox and its limit', () => {
    const claim = explanation().assertions.find((x) => /sf evidence query/i.test(x.claim));
    expect(claim).toBeDefined();
    expect(claim!.claim).toBe(
      'sf evidence query (separate plugin) contacts no network destination and writes no files.',
    );
    const m = claim!.mechanism;
    expect(m).toMatch(/in-process DuckDB/);
    expect(m).toMatch(/native code/i);
    expect(m).toMatch(/static egress scan/i);
    expect(m).toMatch(/autoinstall and autoload/i);
    expect(m).toMatch(/chain-covered record files/i);
    expect(m).toMatch(/spilling is disabled/i);
    expect(m).toMatch(/configuration is locked/i);
    expect(m).toMatch(/single SELECT/i);
    expect(m).toContain('packages/sf-evidence-query/test/unit/duckdb/sandbox.test.ts');
    expect(m).toContain('INSTALL and LOAD');
    expect(m).toContain('allowed_paths');
    expect(m).toContain('enable_external_access');
    expect(m).toContain('write_log');
    expect(m).toContain('setseed');
    expect(m).toContain('neither is a source-scan guarantee');
    expect(m).toContain('packages/sf-evidence-query/test/unit/invariants/invariants.test.ts');
    expect(m).not.toMatch(/engine's own enforcement, exercised/);
    // The unreachable-by-lock query is never offered as evidence.
    expect(m).not.toMatch(/returns 0/);
  });

  it('discloses a git sink destination as local-only with no push', () => {
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [new GitSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    expect(e.destinations.every((d) => !/github|gitlab/i.test(d.host))).toBe(true);
  });

  it('does not crash on the command default placeholder instance URL', () => {
    // The default `--instance-url` shown by the command itself, 'https://<your-org>.my.
    // salesforce.com', is not a legal URL (`<`/`>`) — this is the value explain runs with
    // when invoked with no flags at all, which is the documented common case (no org
    // connection required). It must degrade to printing the raw string, not throw.
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://<your-org>.my.salesforce.com',
    });
    expect(e.destinations[0]!.host).toContain('your-org');
    // The command renders `${protocol}://${host}`; the fallback must not carry its own
    // scheme too, or the rendered line reads `https://https://<your-org>...`.
    expect(e.destinations[0]!.host).not.toMatch(/^https?:\/\//);
  });

  it('does not overclaim what the static egress guard checks', () => {
    // The guard cannot see subprocess execution (GitSink shells out to `git`), so an
    // assertion claiming the network-destination list is enforced by static analysis alone
    // would be false. The wording must own that gap rather than paper over it.
    const a = explanation().assertions;
    const netClaim = a.find((x) => /network destination/i.test(x.claim));
    expect(netClaim).toBeDefined();
    expect(netClaim!.mechanism).toMatch(/subprocess/i);
  });

  it('attributes the org destination to construction, not to iterating collectors', () => {
    // describeDestinations() never touches args.sources or any collector's describeQueries()
    // — the org entry is a static object keyed only on instanceUrl. Claiming it is "generated
    // by iterating the collectors" would hand a reviewer a guarantee the code doesn't provide
    // (a future collector reaching a different host would NOT surface here). The true, and
    // still strong, guarantee is that the SoqlClient and the RestClient are both built in
    // wire.ts from the same single Connection, so every request goes to that Connection's
    // instance URL regardless of how many collectors are configured.
    const netClaim = explanation().assertions.find((x) => /network destination/i.test(x.claim));
    expect(netClaim).toBeDefined();
    expect(netClaim!.mechanism).toMatch(/singular by construction/i);
    expect(netClaim!.mechanism).toMatch(/SoqlClient/);
    expect(netClaim!.mechanism).toMatch(/RestClient/);
    // The old wording said "the same single SoqlClient", which is false once a RestClient
    // exists: there are two clients, sharing one Connection.
    expect(netClaim!.mechanism).not.toMatch(/same single SoqlClient/i);
    expect(netClaim!.mechanism).toMatch(/same Connection/i);
    expect(netClaim!.mechanism).not.toMatch(/collector[a-z']*\s+describeQueries/i);
  });

  it('distinguishes the org guarantee (construction) from the sink guarantee (iteration)', () => {
    const netClaim = explanation().assertions.find((x) => /network destination/i.test(x.claim));
    expect(netClaim).toBeDefined();
    // Both mechanisms must be named, and named as different in kind, so a reviewer can tell
    // which guarantee they are relying on for which entry in the destination list.
    expect(netClaim!.mechanism).toMatch(/singular by construction/i);
    expect(netClaim!.mechanism).toMatch(/genuinely are generated by iterating/i);
  });

  it('enumerates GitSink\'s subcommands completely and accurately', () => {
    // GitSink actually shells out to five distinct git subcommands: rev-parse, add, commit,
    // remote, log (verified against src/sinks/git.ts). An incomplete enumeration is still
    // documentation a reviewer relies on, even where the omission has no security impact.
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [new GitSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    const pushClaim = e.assertions.find((x) => /no git push/i.test(x.claim));
    expect(pushClaim).toBeDefined();
    for (const subcommand of ['rev-parse', 'add', 'commit', 'remote', 'log']) {
      expect(pushClaim!.mechanism).toContain(subcommand);
    }
    expect(pushClaim!.mechanism).toMatch(/never.*invokes.*`git push`/i);
  });
});

describe('org destination wording', () => {
  it('says SOQL and REST both go to the one org, not SOQL only', () => {
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    expect(e.destinations[0]!.purpose).toMatch(/SOQL/);
    expect(e.destinations[0]!.purpose).toMatch(/REST/);
  });
});
