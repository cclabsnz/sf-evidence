import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import {
  API_VERSION,
  COLLECTORS,
  EXIT,
  collectionClock,
  resolveCollectBounds,
  runCollect,
  type CollectResult,
} from '@cclabsnz/sf-evidence-engine';
import { buildClients } from '../../lib/wire.js';
import { readOrgClock } from '../../lib/orgClock.js';
import { resolveOrgId } from '@cclabsnz/sf-evidence-engine';
import { DEFAULT_ARCHIVE, resolveSinks } from '@cclabsnz/sf-evidence-engine';
import { exitCodeFor } from '../../lib/flags.js';
import { setExitCode } from '@cclabsnz/sf-evidence-engine';
import type { SourceId } from '@cclabsnz/sf-evidence-engine';

export default class EvidenceCollect extends SfCommand<CollectResult> {
  public static readonly summary =
    'Extract Salesforce audit data to a hash-chained archive you own';

  public static readonly description = `Pulls Setup Audit Trail from the target org, normalises it, and appends it to a
tamper-evident, hash-chained NDJSON archive on disk or in a git repository.

Read-only: SOQL SELECT and REST GET only, no DML, no metadata deploys. Besides the
collectors' own reads it issues GET /services/data/ on every run to read the org's clock, and
GET /limits/ when a first run, --backfill or gap repair spans more than 7 days, to check
the daily API budget.
\`sf evidence explain\` lists every one. The only network destination is the org you are
authenticated to.

Salesforce deletes Setup Audit Trail entries after 180 days. The first run backfills the
full available window; every run after that is idempotent and adds only what is new.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --target-org prod --sink git',
    '<%= config.bin %> <%= command.id %> --dry-run',
  ];

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    source: Flags.string({
      summary: 'Sources to collect (comma-separated).',
      default: 'audit-trail,login-history',
      helpValue: 'audit-trail|login-history|limits',
    }),
    sink: Flags.string({
      summary: 'Sinks to write to (comma-separated).',
      default: 'local',
      helpValue: 'local|git',
    }),
    archive: Flags.string({
      summary: 'Archive root directory.',
      default: DEFAULT_ARCHIVE,
    }),
    since: Flags.string({
      summary:
        'Collect from this ISO date or datetime (with a zone), or this long ago as a duration in days or hours (P30D, PT12H). Defaults to the watermark, else the full window.',
    }),
    until: Flags.string({
      summary:
        'Collect up to this ISO date or datetime (with a zone), or up to this long ago as a duration in days or hours (P1D, PT12H). Defaults to now.',
    }),
    backfill: Flags.boolean({
      summary:
        'Re-collect the whole retention window even where the archive already covers it. Records already archived are deduplicated, not duplicated.',
      default: false,
    }),
    'api-floor': Flags.integer({
      summary:
        'Refuse a collection spanning more than 7 days when fewer than this many daily API requests remain. Defaults to the larger of 5000 and 10% of the org\'s daily limit.',
      min: 0,
    }),
    'dry-run': Flags.boolean({
      summary: 'Query the org and compute everything, but write nothing.',
      default: false,
    }),
    'fail-on-degraded': Flags.boolean({
      summary: 'Exit 1 instead of 4 when coverage was reduced, for strict CI.',
      default: false,
    }),
    sign: Flags.boolean({
      summary:
        'git sink: sign each manifest commit (git commit -S) with your own key. We never generate or hold one.',
      default: false,
    }),
  };

  public async run(): Promise<CollectResult> {
    const { flags } = await this.parse(EvidenceCollect);

    // Resolved before anything else, so a bad --since or --until is a usage error and not a
    // failure halfway through a run. Throws on anything it will not interpret, and on a bound
    // later than now.
    let bounds: ReturnType<typeof resolveCollectBounds> = { since: undefined, until: undefined };
    try {
      bounds = resolveCollectBounds({ since: flags.since, until: flags.until }, new Date());
    } catch (err) {
      this.error((err as Error).message, { exit: EXIT.USAGE });
    }

    // Sinks first, and before any query: two canonical sinks on one archive root, or an
    // archive root that does not exist, are configuration errors this should refuse on
    // rather than discover halfway through a write.
    const sinks = resolveSinks(flags.sink.split(','), flags.archive, { sign: flags.sign });
    for (const sink of sinks) await sink.init();

    // Pinned to the engine's API version: records and `explain` claim it, and an org's own
    // default version would otherwise decide which version every SOQL and REST call uses.
    const conn = flags['target-org'].getConnection(API_VERSION);
    const { soql, rest } = buildClients(conn);
    // Through the SoqlClient, not the raw Connection: `explain` lists this query, and a
    // query that bypassed the client would be one `explain` could not have listed.
    const orgId = await resolveOrgId(soql);
    // Windows end at the earlier of this machine's clock and the org's (SPEC.md §10.8), read
    // with the same Date-header request doctor uses. Never throws: an unreadable org clock
    // falls back to the local clock, and the result says so.
    const clock = await collectionClock(new Date(), () => readOrgClock(conn));

    const result = await runCollect({
      orgId,
      sources: flags.source.split(',').map((s) => s.trim()) as SourceId[],
      sinks,
      soql,
      rest,
      instanceUrl: conn.instanceUrl,
      now: clock.now,
      clock: clock.clock,
      clockNote: clock.clockNote,
      since: bounds.since,
      until: bounds.until,
      backfill: flags.backfill,
      apiFloor: flags['api-floor'],
      dryRun: flags['dry-run'],
    });

    this.report(result);

    // Non-throwing, so --json keeps `result`: the degradation detail this exit code exists
    // to flag lives inside the payload SfCommand.exit() would have thrown away.
    setExitCode(exitCodeFor(result, flags['fail-on-degraded']));
    return result;
  }

  private report(result: CollectResult): void {
    if (result.dryRun) this.log('DRY RUN — nothing was written.\n');
    if (result.clock === 'local') {
      // A warning, so --json runs see it too: a local clock ahead of the org claims coverage the
      // org had not reached, and the next run's overlap does not re-query it.
      this.warn(
        "Windows end at this machine's clock, because the org clock was not available" +
          `${result.clockNote ? ` (${result.clockNote})` : ''}. If this clock runs ahead of the org, ` +
          'org events in the last minutes of the window may never be collected; run `sf evidence doctor --target-org` to check skew.',
      );
    }

    for (const s of result.sources) {
      this.log(`${s.source}  ${s.status}`);
      // Queried and achieved are different claims. Printing only the span would claim the ranges
      // between gap-repair windows were collected, and printing the queried windows alone would
      // claim a partial source covered what it asked for.
      if (s.sampledAt !== undefined) {
        // A snapshot is one reading at one instant; its hour bucket is a dedupe key, not coverage.
        const duplicate = s.recordsWritten === 0 && s.recordsDeduped > 0;
        this.log(
          `  sampled at ${s.sampledAt}` +
            (duplicate ? " (duplicate of this hour's stored sample, not stored)" : ''),
        );
      } else if (COLLECTORS[s.source]?.kind === 'snapshot') {
        this.log('  sampled  nothing');
      } else {
        for (const w of s.queried) this.log(`  queried  ${w.from} → ${w.to}`);
        for (const w of s.achieved) this.log(`  covered  ${w.from} → ${w.to}`);
        if (s.achieved.length === 0) this.log('  covered  nothing');
      }
      this.log(`  written  ${s.recordsWritten}   deduped ${s.recordsDeduped}`);
      for (const d of s.degradations) {
        // C7: a source we could not read is reported loudly, not as an empty success. The
        // remediation travels inside the same warn() call so it survives --json (this.log
        // is suppressed there) and stays on the same stream as the warning it belongs to.
        const slice = d.window ? ` [${d.window.from} → ${d.window.to}]` : '';
        this.warn(`${s.source}: ${d.code}${slice} — ${d.detail} → ${d.remediation}`);
      }
      if (s.apiBudgetChecked === false) {
        // Also a warning, so --json runs still see it. Silence here would read as "within budget".
        this.warn(
          `${s.source}: API budget was not checked, so this long collection ran without its guard` +
            `${s.apiBudgetNote ? ` (${s.apiBudgetNote})` : ''}.`,
        );
      }
    }

    if (!result.dryRun) {
      // A long collection is committed in 7-day rounds, one manifest each; the hash is the
      // last one's, the head this run leaves.
      const { manifests } = result;
      this.log(
        manifests.length === 1
          ? `\nmanifest seq ${result.manifest.seq}  ${result.manifest.hash}`
          : `\nmanifests #${manifests[0]!.seq}–#${result.manifest.seq} (${manifests.length})  ${result.manifest.hash}`,
      );
      for (const sink of result.sinks) {
        if (!sink.written) {
          this.warn(
            `${sink.id}: NOT written — ${sink.error ?? 'unknown error'}. That sink's chain ` +
              'stays at its previous head; re-run once the cause is fixed.',
          );
          continue;
        }
        this.log(`  ${sink.id}: written${sink.commit ? ` (commit ${sink.commit})` : ''}`);
        if (sink.error) {
          // Written, but not finished. Says what landed and what did not, rather than
          // picking one of the two and implying the other.
          this.warn(`${sink.id}: ${sink.error}`);
        }
        if (sink.pushPending) {
          this.warn(`${sink.id}: commit is local only. Push it yourself when ready.`);
        }
      }
    }

    if (result.dryRun && result.metadata.prepared.length > 0) {
      this.log(`would write metadata: ${result.metadata.prepared.join(', ')}`);
    }
    if (result.metadata.error) {
      this.warn(result.metadata.error);
    }

    if (result.orphansFound.length > 0) {
      this.warn(
        `${result.orphansFound.length} orphan record file(s) found from an interrupted run. ` +
          'They are reported, not adopted: their records are not in this run\'s manifest and ' +
          'are not part of the chain.',
      );
    }
  }
}
