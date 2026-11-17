import { getCollector } from '../collectors/registry.js';
import { isGitSink } from '../sinks/git.js';
import { API_BUDGET_QUERY, ORG_CLOCK_QUERY, ORG_ID_QUERY, ORG_INFO_QUERY } from '../salesforce.js';
import type { QueryDescription } from '../types/collector.js';
import type { SourceId } from '../types/record.js';
import type { Sink } from '../types/sink.js';

/**
 * Pure logic for `sf evidence explain`, kept out of `commands/evidence/explain.ts` so the
 * content of the report is testable without constructing an oclif command.
 *
 * (Historically this split was forced: importing `@salesforce/sf-plugins-core` under this
 * repo's Jest+swc+vm-modules harness threw `Cannot access 'supportsColor' before
 * initialization` from chalk 5. That is fixed by a `moduleNameMapper` chalk stub in
 * `jest.config.ts`, and `test/unit/commands/commands.test.ts` now imports and drives all
 * four command modules. The split stays because it is the better structure, not because the
 * harness demands it. Same for `statusFormat.ts`, `verifyFormat.ts` and `runCollect.ts`.)
 *
 * `explain` is the command a security reviewer runs instead of reading the source. The query
 * list is generated from the configured collectors' `describeQueries()`; the sink-side
 * entries in `writes` and `destinations` are generated from each configured sink's
 * `describe()`. The org entry in `destinations` is a different kind of guarantee — it is not
 * produced by iterating anything, it is singular by construction: the `SoqlClient` and the
 * `RestClient` are both built in wire.ts from the same single `Connection` (see the
 * "No network destination" assertion in
 * `describeAssertions` below for the full argument). Every negative assertion names the
 * mechanism that actually backs it, worded no stronger than what that mechanism checks.
 */

export interface Destination {
  host: string;
  protocol: string;
  purpose: string;
  credentialSource: string;
}

export interface Assertion {
  claim: string;
  mechanism: string;
}

export interface Explanation {
  queries: QueryDescription[];
  writes: string[];
  destinations: Destination[];
  assertions: Assertion[];
}

export interface ExplainArgs {
  sources: SourceId[];
  sinks: Sink[];
  instanceUrl: string;
}

export function buildExplanation(args: ExplainArgs): Explanation {
  return {
    queries: describeQueries(args.sources),
    writes: describeWrites(args.sinks),
    destinations: describeDestinations(args),
    assertions: describeAssertions(args.sinks),
  };
}

/**
 * Every query the plugin issues, collector-owned or not.
 *
 * The collector entries iterate the configured collectors, so a collector left out of
 * `sources` cannot appear here. `ORG_ID_QUERY` and `ORG_INFO_QUERY` are prepended unconditionally because they are
 * not owned by any collector: `collect` issues the first before any collector runs, to
 * resolve the archive's partition key, and the second to describe the org in `org.json`. Omitting it made `explain` an incomplete list in the
 * one artifact whose entire value is that it is complete. The org clock read and the API
 * budget read follow for the same reason; each carries a note on when it is issued.
 */
function describeQueries(sources: SourceId[]): QueryDescription[] {
  // The budget guard applies only to event sources, so it is listed exactly when one is configured.
  const anyEvent = sources.some((s) => getCollector(s).kind === 'event');
  return [
    { ...ORG_ID_QUERY },
    { ...ORG_INFO_QUERY },
    { ...ORG_CLOCK_QUERY },
    ...(anyEvent ? [{ ...API_BUDGET_QUERY }] : []),
    ...sources.flatMap((s) =>
      getCollector(s).describeQueries().map((q) => ({ scope: 'collector' as const, ...q })),
    ),
  ];
}

/** Every archive path a configured sink will write, plus the ordering invariant (SPEC.md §7.3). */
function describeWrites(sinks: Sink[]): string[] {
  const writes: string[] = [];
  for (const sink of sinks) {
    const d = sink.describe();
    // `location` and never `note`: this value is concatenated with archive sub-paths, so a
    // field carrying prose would print a path no filesystem could name.
    writes.push(`${d.location}/org_id=<org>/source=<source>/year=<yyyy>/month=<mm>/part-*.ndjson`);
    writes.push(`${d.location}/org_id=<org>/_chain/<seq>.manifest.json`);
    writes.push(`${d.location}/org_id=<org>/_chain/head.json`);
    writes.push(`${d.location}/archive.json`);
    writes.push(`${d.location}/org_id=<org>/org.json`);
    if (d.note) writes.push(`  (${d.id} sink: ${d.note})`);
  }
  writes.push(
    'Write order is fixed: all records first, then the manifest, then the head pointer. ' +
      'An interruption can leave orphan record files; it can never leave a manifest ' +
      'referencing a file that does not exist.',
  );
  return writes;
}

/**
 * The org itself, always, plus any configured sink whose `credentialSource` does not start
 * with `none` — that prefix is how `LocalSink` ("none (local filesystem)") and `GitSink`
 * ("none (no push is performed)") both say "this destination is not a network egress point",
 * which is why a Tier 0 configuration (local sink only) yields exactly one destination.
 *
 * The org entry covers both the SOQL and the REST traffic: wire.ts builds the `SoqlClient`
 * and the `RestClient` from the same `Connection`, so both reach the same instance URL.
 */
function describeDestinations(args: ExplainArgs): Destination[] {
  const destinations: Destination[] = [
    {
      host: hostOf(args.instanceUrl),
      protocol: 'https',
      purpose: 'SOQL SELECT and REST GET against the org you authenticated to. Read-only.',
      credentialSource: 'sf CLI session (never read, copied or stored by this plugin)',
    },
  ];

  for (const sink of args.sinks) {
    const d = sink.describe();
    if (d.credentialSource.startsWith('none')) continue;
    destinations.push({
      host: d.location,
      protocol: 'sink-specific',
      purpose: 'Archive write.',
      credentialSource: d.credentialSource,
    });
  }

  return destinations;
}

/**
 * The command's `--instance-url` default is a human placeholder
 * (`https://<your-org>.my.salesforce.com`) meant to show the *shape* of the destination when
 * `explain` is run with no org context at all — which is the common case, since this command
 * is documented to need no org connection. `<` and `>` are not legal URL characters, so
 * `new URL()` throws on that placeholder. Falling back to the raw string on a parse failure
 * means the no-org-connection default still prints something informative instead of crashing
 * the one command whose entire point is to run safely before anything else does.
 *
 * The fallback strips a leading `scheme://`, if present, before returning: the caller
 * renders this value as `${protocol}://${host}`, and returning the placeholder verbatim
 * (already carrying its own `https://`) would print `https://https://<your-org>...`.
 */
function hostOf(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return instanceUrl.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//, '');
  }
}

/**
 * Negative assertions, each naming the mechanism that backs it rather than only the claim.
 *
 * Two of these need care: the static egress guard (`test/unit/invariants/invariants.test.ts`,
 * `NETWORK_EGRESS_RULES`) scans for HTTP client imports, `node:http`/`https`, telemetry
 * hostnames and WebSockets in `src/` — but it does not and cannot scan subprocess execution.
 * `GitSink` shells out to the locally installed `git` binary (`execFile`, never a shell), so
 * a `git push` would not be caught by that guard even though `GitSink` never calls one today.
 * The wording below says exactly that, rather than claiming the guard is exhaustive.
 */
function describeAssertions(sinks: Sink[]): Assertion[] {
  const assertions: Assertion[] = [
    {
      claim: 'No DML. This plugin never writes to your org.',
      mechanism:
        'A static invariant test (test/unit/invariants/invariants.test.ts, rule set ORG_WRITE_RULES) ' +
        'scans src/ for org-mutating calls and fails the build on any match. Run `pnpm test` on the ' +
        'source to re-derive it yourself.',
    },
    {
      claim: 'No telemetry, analytics or usage reporting.',
      mechanism:
        'Absent from the source tree, not merely disabled or opt-out. The same invariant suite\'s ' +
        'static egress scan (NETWORK_EGRESS_RULES) matches known telemetry hostnames, HTTP client ' +
        'imports and node:http/https usage anywhere in src/, and fails the build if any appear.',
    },
    {
      claim:
        'No network destination beyond the org and the sink(s) listed above under NETWORK DESTINATIONS.',
      mechanism:
        'These two entries are backed by different mechanisms and should not be read as the same ' +
        'kind of guarantee. The org entry is singular by construction, not by iteration: every ' +
        'collector receives a SoqlClient and a RestClient, both constructed in wire.ts (buildClients) ' +
        'from the same Connection, and the Organization lookups no collector owns (listed first ' +
        'under QUERIES) go through that SoqlClient rather than around it. The org clock read ' +
        '(GET /services/data/) is issued on that same Connection directly, because the clients do ' +
        'not surface the response Date header — ' +
        'so every SOQL and REST request goes to that Connection\'s instance URL, and there is ' +
        'structurally one org destination no matter how many collectors ' +
        'are registered; this list does not iterate collectors to produce it. The two clients ' +
        'are separate objects sharing one Connection, not one client. That is backed by the ' +
        'egress guard\'s filesUsingFetch check, which separately asserts that no source file makes a ' +
        'direct call to the global fetch API, so a collector could not quietly open its own channel ' +
        'even if it tried. The sink ' +
        'entries, by contrast, genuinely are generated by iterating each configured sink\'s describe() ' +
        '— a registered sink cannot omit itself from this list. Neither guarantee extends to ' +
        'subprocess execution, which the static egress guard does not scan: a sink that shells out to ' +
        'a network-capable binary would not be caught by it. GitSink does shell out, to the locally ' +
        'installed `git` binary, but only ever runs rev-parse, add, commit, remote and log — never ' +
        'push; that is a source-reading fact, not something the guard enforces.',
    },
    {
      claim: 'No infrastructure is created.',
      mechanism:
        'Every sink verifies its target exists and refuses to create it (LocalSink.init, GitSink.init), ' +
        'printing the command for you to run yourself instead.',
    },
  ];

  if (sinks.some(isGitSink)) {
    assertions.push({
      claim: 'No git push is performed.',
      mechanism:
        'GitSink issues only local git subcommands — rev-parse, add, commit, remote, log. It never ' +
        'invokes `git push`; a batch is committed locally and reported as a pending push, and pushing ' +
        'is left entirely to you. This is a source-reading fact about GitSink, not something the ' +
        'static egress guard checks, since that guard does not see subprocess execution.',
    });
  }

  return assertions;
}
