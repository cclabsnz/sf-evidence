import { ArchiveReader } from '../archive/reader.js';
import { DAY_MS, retentionStart as retentionStartOf, uncoveredIntervals } from '../archive/coverage.js';
import { sha256Hex } from '../chain/hash.js';
import { mergeWindows } from '../lib/windows.js';
import { buildBatch, manifestHash, PRODUCER } from '../chain/manifestBuilder.js';
import { ARCHIVE_JSON_PATH, buildMetadataFiles, orgJsonPath } from '../archive/metadata.js';
import { assertValidFloor, checkApiBudget } from './apiBudget.js';
import { getCollector } from '../collectors/registry.js';
import { newRunId } from '../lib/ulid.js';
import { hourWindow, toIsoMs } from '../lib/time.js';
import { API_VERSION, resolveOrgInfo } from '../salesforce.js';
import type { CollectionClockSource } from './collectionClock.js';
import { GENESIS_PREV, type Degradation, type SourceStatus, type TimeWindow } from '../types/manifest.js';
import type { CollectionOutcome } from '../types/collector.js';
import type { SourceId } from '../types/record.js';
import type { OrphanFile, PreparedFile, Sink } from '../types/sink.js';
import type { RestClient, SoqlClient } from '@cclabsnz/sf-core';
import type { SourceBatchInput } from '../chain/manifestBuilder.js';

export interface RunCollectArgs {
  orgId: string;
  sources: SourceId[];
  sinks: Sink[];
  soql: SoqlClient;
  /** The org's instance URL, recorded in org.json. Hosts that have one should pass it. */
  instanceUrl?: string;
  /** Needed by snapshot sources; without it they degrade with `NO_REST_CLIENT`. */
  rest?: RestClient;
  /**
   * Where every window ends, and `collected_at` and `created_at`; never `occurred_at`. A host
   * that can read the org's clock passes `collectionClock(...).now`, the earlier of the local
   * and org clocks (SPEC.md §10.8). Defaults to the local clock.
   */
  now?: Date;
  /** Which clock `now` came from, recorded on the result. Defaults to `local`. */
  clock?: CollectionClockSource;
  /** Why the org clock could not be read, recorded on the result when `clock` is `local`. */
  clockNote?: string;
  since?: string;
  until?: string;
  /** Re-collect the whole retention window even where the archive already covers it. */
  backfill?: boolean;
  dryRun?: boolean;
  /** Overrides the default API budget floor, `max(5000, 10% of DailyApiRequests.Max)`. */
  apiFloor?: number;
}

export interface SourceResult {
  source: SourceId;
  status: SourceStatus;
  /**
   * Spans every planned window, including any the API budget guard refused; it is not itself a
   * claim that the span was queried.
   */
  window: { from: string; to: string };
  /** The windows this run actually queried, sorted. Gap repair can make this more than one. */
  queried: TimeWindow[];
  /**
   * The sub-ranges that were queried successfully; what the manifest records as covered.
   * Empty for a refused or failed source. For a partial source it is less than was planned:
   * less than `queried`, or less than the plan when the API budget guard refused part of it.
   */
  achieved: TimeWindow[];
  /**
   * Snapshot sources only: when the sample was taken, present only if one was. A snapshot is a
   * point reading, so this is the claim to print; `achieved` is its dedupe hour bucket.
   */
  sampledAt?: string;
  recordsFetched: number;
  recordsWritten: number;
  recordsDeduped: number;
  files: string[];
  degradations: Degradation[];
  /**
   * Whether the API budget guard ran. Present only for an event source whose guarded windows
   * total more than 7 days, the only case the guard applies to: the whole plan on a first run,
   * `--since` or `--backfill`, otherwise only the gap-repair windows. `false` means the guard
   * could not run (no REST client, or `/limits/` unreadable) and the collection went ahead
   * unchecked.
   */
  apiBudgetChecked?: boolean;
  /** Why the budget could not be checked; present exactly when `apiBudgetChecked` is false. */
  apiBudgetNote?: string;
}

export interface SinkResult {
  id: string;
  written: boolean;
  commit?: string;
  pushPending?: boolean;
  /**
   * Why this sink did not complete, in the words of whatever failed.
   *
   * Read it together with `written`, because the two combinations mean different things:
   *
   * - `written: false` — the batch never landed on this sink. Its chain stays at its
   *   previous head. SPEC.md §8.2: a sink write failure "aborts *that sink* ... with the
   *   run reported as failed for that sink".
   * - `written: true` with an `error` — the archive files landed, and a later step failed.
   *   Today that is only the git sink's anchoring commit, which runs after the records,
   *   manifest and head are already on disk. The evidence exists and verifies; it is simply
   *   not committed.
   *
   * Collapsing the second case into the first is what made this pipeline announce that
   * nothing was archived over a complete batch.
   */
  error?: string;
}

export interface MetadataResult {
  /** Archive-relative paths this run persisted. Always empty on a dry run. */
  written: string[];
  /** Paths the batch carries: what a real run would write. */
  prepared: string[];
  /**
   * Why archive.json / org.json could not be brought up to date. Evidence collection goes
   * ahead regardless: the metadata describes the archive, it is not part of the evidence.
   */
  error?: string;
}

export interface CollectResult {
  runId: string;
  orgId: string;
  manifest: { seq: number; hash: string; prev: string };
  sources: SourceResult[];
  sinks: SinkResult[];
  /**
   * Record files present in the archive but referenced by no manifest, from an interrupted
   * run (SPEC.md §10.5).
   *
   * Named for what this release does: it finds and reports them. It does NOT adopt them —
   * adoption means deduping their records against this run and including them in the new
   * manifest, and nothing here feeds them to `knownSourceIds` or into the batch. The
   * previous name (`orphansAdopted`) claimed the behaviour SPEC.md §10.5 specifies rather
   * than the behaviour implemented.
   */
  orphansFound: OrphanFile[];
  metadata: MetadataResult;
  dryRun: boolean;
  /**
   * Which clock ended this run's windows. `local` means the org clock was not read, so a local
   * clock running ahead of the org may have claimed coverage the org had not reached.
   */
  clock: CollectionClockSource;
  /** Why the org clock could not be read; present only when the host said so. */
  clockNote?: string;
  /** True when any source is not `complete`, or any sink write failed; drives exit code 4. */
  degraded: boolean;
}

/** An event source collecting more than this much time in one run is checked against the API budget. */
const GUARDED_SPAN_MS = 7 * DAY_MS;

/** How far behind the last covered instant an incremental run starts again. */
const OVERLAP_MS = 15 * 60_000;

export interface PlanWindowsArgs {
  now: Date;
  until?: string;
  since?: string;
  backfill?: boolean;
  retentionDays: number;
  /** What the archive already covers for this source (`SourceSummary.coverage`). */
  coverage: TimeWindow[];
}

/**
 * One source's plan: the windows to query, sorted and merged, and of those the routine
 * incremental window, which the API budget guard never refuses.
 *
 * `incremental` is set only on an incremental run (the source has coverage, and neither
 * `since` nor `backfill` was given) that has something after the last covered instant to
 * collect. Everything else in `windows` is gap repair.
 */
export interface SourcePlan {
  windows: TimeWindow[];
  incremental: TimeWindow | null;
}

/**
 * The windows one run should query for one source, sorted and merged.
 *
 * - An explicit `since` is honoured as given: `[since, until)`.
 * - `backfill`, or a source with no coverage at all, takes the whole retention window
 *   (SPEC.md §10.6).
 * - Otherwise the run is incremental: from 15 minutes before the last covered instant, plus
 *   every gap still inside the retention window, so a range a failed run missed is
 *   re-collected while Salesforce still holds it.
 *
 * `until` is clamped to `now`: a window into the future would be recorded as achieved
 * coverage of time that has not happened yet. No planned window starts before
 * `now − retentionDays` (except an explicit `since`): Salesforce has already deleted that
 * data, and querying it would record as achieved a range that can no longer be collected.
 */
export function planWindows(args: PlanWindowsArgs): TimeWindow[] {
  return planSource(args).windows;
}

/** `planWindows`, also naming the incremental window. */
export function planSource(args: PlanWindowsArgs): SourcePlan {
  const nowIso = toIsoMs(args.now);
  const untilIso = args.until === undefined ? nowIso : toIsoMs(args.until);
  const to = untilIso < nowIso ? untilIso : nowIso;

  if (args.since !== undefined) return { windows: [{ from: toIsoMs(args.since), to }], incremental: null };

  const retentionStart = retentionStartOf(args.now, args.retentionDays);
  const coverage = mergeWindows(args.coverage);
  const lastCoveredTo = coverage.at(-1)?.to;

  if (args.backfill || lastCoveredTo === undefined) {
    return { windows: [{ from: retentionStart < to ? retentionStart : to, to }], incremental: null };
  }

  const overlapFrom = toIsoMs(new Date(Date.parse(lastCoveredTo) - OVERLAP_MS));
  const incrementalFrom = overlapFrom > retentionStart ? overlapFrom : retentionStart;
  const planned = uncoveredIntervals(coverage, retentionStart, lastCoveredTo < to ? lastCoveredTo : to);
  const incremental = incrementalFrom < to ? { from: incrementalFrom, to } : null;
  if (incremental) planned.push(incremental);

  const merged = mergeWindows(planned);
  // Nothing left to query (an `until` the archive already covers). An empty window still
  // produces a manifest entry, so the run is on the record without claiming any coverage.
  return { windows: merged.length > 0 ? merged : [{ from: to, to }], incremental };
}

/**
 * The windows the API budget guard considers, and may refuse.
 *
 * With no incremental window (first run, `since`, `backfill`, or nothing new since the last
 * covered instant) that is the whole plan. Otherwise it is the gap repair only: every planned
 * instant outside the incremental window. The routine incremental run always goes ahead, so a
 * low budget delays repair without stopping the collection that keeps the source current.
 */
function guardedWindows(plan: SourcePlan): TimeWindow[] {
  const { incremental } = plan;
  if (!incremental) return plan.windows;
  return plan.windows.flatMap((w) => uncoveredIntervals([incremental], w.from, w.to));
}

const spanOf = (windows: TimeWindow[]): number =>
  windows.reduce((n, w) => n + (Date.parse(w.to) - Date.parse(w.from)), 0);

/** From the earliest start to the latest end of a non-empty list of windows. */
const spanning = (windows: TimeWindow[]): TimeWindow => ({
  from: windows.map((w) => w.from).reduce((a, b) => (b < a ? b : a)),
  to: windows.map((w) => w.to).reduce((a, b) => (b > a ? b : a)),
});

/**
 * One manifest entry from the outcomes of several planned windows.
 *
 * The entry's `window` spans them all; `achieved` is exactly what was queried successfully,
 * so the ranges between planned windows are never claimed by this run. `complete` means every
 * planned window was complete, not that the span was queried.
 */
function combineOutcomes(outcomes: CollectionOutcome[]): CollectionOutcome {
  if (outcomes.length === 1) return outcomes[0]!;

  const achieved = mergeWindows(outcomes.flatMap((o) => o.achieved));
  let status: SourceStatus;
  if (outcomes.every((o) => o.status === 'complete')) status = 'complete';
  else if (achieved.length > 0) status = 'partial';
  else if (outcomes.every((o) => o.status === 'failed')) status = 'failed';
  else status = 'degraded';

  return {
    source: outcomes[0]!.source,
    status,
    window: spanning(outcomes.map((o) => o.window)),
    achieved,
    records: outcomes.flatMap((o) => o.records),
    degradations: outcomes.flatMap((o) => o.degradations),
    fetched: outcomes.reduce((n, o) => n + o.fetched, 0),
    deduped: outcomes.reduce((n, o) => n + o.deduped, 0),
  };
}

/** Reads a file from the archive, or null when it does not exist. */
async function readIfPresent(sink: Sink, relPath: string): Promise<string | null> {
  try {
    return (await sink.readFile(relPath)).toString('utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function preparedFile(relPath: string, text: string): PreparedFile {
  const bytes = Buffer.from(text, 'utf8');
  return { relPath, bytes, sha256: `sha256:${sha256Hex(bytes)}` };
}

/**
 * The metadata files this batch must carry. Issued here, once, so a CLI host and a Lambda host
 * both get archive.json and org.json without each repeating the query. Never throws: a failure
 * is returned for the caller to surface.
 *
 * Every canonical sink is read. The desired content is built once (archive.json keeps the
 * `created_at` of the first existing copy found), and a file goes in the batch when any
 * canonical sink lacks it or holds different bytes, so a sink added later catches up.
 */
async function prepareMetadata(
  args: RunCollectArgs,
  canonical: Sink[],
  now: string,
): Promise<{ files: PreparedFile[]; error?: string }> {
  try {
    const orgInfo = await resolveOrgInfo(args.soql);
    if (orgInfo.id !== args.orgId) {
      return {
        files: [],
        error: `the org reported id ${orgInfo.id} but this run was started for ${args.orgId}; org.json was not written.`,
      };
    }
    const orgPath = orgJsonPath(args.orgId);
    const held = await Promise.all(
      canonical.map(async (sink) => ({
        archive: await readIfPresent(sink, ARCHIVE_JSON_PATH),
        org: await readIfPresent(sink, orgPath),
      })),
    );
    const firstArchive = held.map((h) => h.archive).find((t) => t !== null) ?? null;
    const firstOrg = held.map((h) => h.org).find((t) => t !== null) ?? null;
    const built = buildMetadataFiles({
      orgInfo,
      instanceUrl: args.instanceUrl,
      apiVersion: API_VERSION,
      producer: PRODUCER,
      existing: { archive: firstArchive, org: firstOrg },
      now,
    });

    const desired: PreparedFile[] = [];
    const archive =
      built.find((f) => f.relPath === ARCHIVE_JSON_PATH) ??
      (firstArchive === null ? undefined : preparedFile(ARCHIVE_JSON_PATH, firstArchive));
    const org =
      built.find((f) => f.relPath === orgPath) ??
      (firstOrg === null ? undefined : preparedFile(orgPath, firstOrg));
    if (archive) desired.push(archive);
    if (org) desired.push(org);

    const files = desired.filter((f) =>
      held.some((h) => {
        const text = f.relPath === ARCHIVE_JSON_PATH ? h.archive : h.org;
        return text === null || text !== f.bytes.toString('utf8');
      }),
    );
    return { files };
  } catch (err) {
    return {
      files: [],
      error: `archive.json and org.json were not updated: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runCollect(args: RunCollectArgs): Promise<CollectResult> {
  const canonical = args.sinks.filter((s) => s.capabilities.canonical);
  if (canonical.length === 0) {
    throw new Error(
      'No canonical sink configured. A SIEM mirror is write-only and cannot hold the archive; ' +
        'configure a local, git, s3 or azure sink as well.',
    );
  }

  const now = args.now ?? new Date();
  const collectedAt = toIsoMs(now);
  const runId = newRunId(now.getTime());

  // Chain position comes from the first canonical sink; every canonical sink receives the
  // same manifest, so their chains stay identical.
  const primary = canonical[0]!;
  const reader = new ArchiveReader(primary);
  const head = await primary.head(args.orgId);
  const seq = (head?.seq ?? 0) + 1;
  const prev = head?.manifest_hash ?? GENESIS_PREV;

  const outcomes: SourceBatchInput[] = [];
  const degradations: Degradation[] = [];
  const sourceResults: SourceResult[] = [];

  // Not persisted here: a dry run must leave `_state/` untouched, and the cache is refreshed
  // only after a canonical sink has accepted the batch.
  const summaries = await reader.summarise(args.orgId, { persist: false });

  // Before the loop, and outside the guard's try/catch below: a bad floor is a usage error,
  // not an unreadable budget, and must not be reported as "not checked".
  assertValidFloor(args.apiFloor);

  for (const source of args.sources) {
    const collector = getCollector(source);
    // A snapshot has no history to backfill or repair: the only thing it can collect is now,
    // so `since`, `until`, `backfill` and prior coverage do not apply (SPEC.md §4.4).
    const plan: SourcePlan =
      collector.kind === 'snapshot'
        ? { windows: [hourWindow(now)], incremental: null }
        : planSource({
            now,
            since: args.since,
            until: args.until,
            backfill: args.backfill,
            retentionDays: collector.retentionDays,
            // Already clipped at each run's created_at by the reader, the same summary
            // `status` assesses, so the planner and `status` agree on where coverage ends.
            coverage: summaries.find((s) => s.source === source)?.coverage ?? [],
          });
    const guarded = collector.kind === 'snapshot' ? [] : guardedWindows(plan);

    let windows = plan.windows;
    const refused: Degradation[] = [];
    let apiBudgetChecked: boolean | undefined;
    let apiBudgetNote: string | undefined;
    if (spanOf(guarded) > GUARDED_SPAN_MS) {
      let verdict: Awaited<ReturnType<typeof checkApiBudget>> | undefined;
      // Without a client, or when `/limits/` cannot be read, the budget is unknown. The run
      // goes ahead, as it would have before the guard existed, and says so in the result.
      // Refusing instead would let an unrelated `/limits/` failure block evidence collection.
      if (args.rest) {
        try {
          verdict = await checkApiBudget(args.rest, args.apiFloor);
        } catch (err) {
          verdict = undefined;
          apiBudgetNote = err instanceof Error ? err.message : String(err);
        }
      } else {
        apiBudgetNote = 'no REST client was available to read GET /limits/.';
      }
      apiBudgetChecked = verdict !== undefined;
      if (verdict && !verdict.ok) {
        const remediation =
          `Re-run when DailyApiRequests.Remaining is at least ${verdict.floor} (it is ${verdict.remaining} now), ` +
          `or lower the floor with --api-floor <requests>.`;
        const below = `DailyApiRequests.Remaining is ${verdict.remaining}, below the floor of ${verdict.floor}.`;

        if (!plan.incremental) {
          const span = spanning(plan.windows);
          const degradation: Degradation = {
            source,
            code: 'API_BUDGET_FLOOR',
            detail: `${below} The planned collection spans more than 7 days, so it was not started.`,
            remediation,
          };
          outcomes.push({ source, status: 'degraded', window: span, achieved: [], records: [] });
          degradations.push(degradation);
          sourceResults.push({
            source,
            status: 'degraded',
            window: span,
            queried: [],
            achieved: [],
            recordsFetched: 0,
            recordsWritten: 0,
            recordsDeduped: 0,
            files: [],
            degradations: [degradation],
            apiBudgetChecked,
          });
          continue;
        }

        // Only the repair is refused. The incremental window keeps the source current, and
        // each refused window is named so the gap it leaves is explicit and re-collectable.
        for (const window of guarded) {
          refused.push({
            source,
            code: 'API_BUDGET_FLOOR',
            detail:
              `${below} The gap repair spans more than 7 days, so this window was not collected; ` +
              'the incremental window was.',
            remediation,
            window,
          });
        }
        windows = [plan.incremental];
      }
    }

    const perWindow: CollectionOutcome[] = [];
    const seenThisRun = new Set<string>();
    for (const window of windows) {
      // Dedupe reads only the month partitions this window touches, plus what earlier
      // windows of this run already collected.
      const known = await reader.knownSourceIds(args.orgId, source, window);
      for (const id of seenThisRun) known.add(id);
      const windowOutcome = await collector.collect(
        { soql: args.soql, rest: args.rest, orgId: args.orgId, apiVersion: API_VERSION, collectedAt },
        { window, knownSourceIds: known },
      );
      for (const rec of windowOutcome.records) seenThisRun.add(rec.source_id);
      perWindow.push(windowOutcome);
    }
    const combined = combineOutcomes(perWindow);
    // A refused repair leaves part of the plan uncollected: never `complete`, and the entry's
    // window spans the plan, so the refused windows sit inside it and outside `achieved`.
    const outcome: CollectionOutcome =
      refused.length === 0
        ? combined
        : {
            ...combined,
            status: combined.status === 'complete' ? 'partial' : combined.status,
            window: spanning(plan.windows),
            degradations: [...refused, ...combined.degradations],
          };

    outcomes.push({
      source,
      status: outcome.status,
      window: outcome.window,
      achieved: outcome.achieved,
      records: outcome.records,
    });
    degradations.push(...outcome.degradations);

    sourceResults.push({
      source,
      status: outcome.status,
      window: outcome.window,
      queried: windows,
      achieved: outcome.achieved,
      ...(collector.kind === 'snapshot' && outcome.fetched > 0 ? { sampledAt: collectedAt } : {}),
      recordsFetched: outcome.fetched,
      recordsWritten: outcome.records.length,
      recordsDeduped: outcome.deduped,
      files: [],
      degradations: outcome.degradations,
      ...(apiBudgetChecked === undefined ? {} : { apiBudgetChecked }),
      ...(apiBudgetNote === undefined ? {} : { apiBudgetNote }),
    });
  }

  const metadata = await prepareMetadata(args, canonical, collectedAt);

  const batch = buildBatch({
    orgId: args.orgId,
    runId,
    createdAt: collectedAt,
    collectedAt,
    prevManifestHash: prev,
    seq,
    outcomes,
    degradations,
    metadata: metadata.files,
  });

  for (const result of sourceResults) {
    result.files =
      batch.manifest.sources.find((s) => s.source === result.source)?.files.map((f) => f.path) ?? [];
  }

  const hash = manifestHash(batch.manifest);
  const orphansFound = await primary.listOrphans(args.orgId);
  const sinkResults: SinkResult[] = [];

  if (!args.dryRun) {
    for (const sink of args.sinks) {
      // Per-sink isolation (SPEC.md §8.2). A sink that throws leaves its own chain at its
      // previous head and is reported as failed; it does not abort the run and discard a
      // batch the other sinks already accepted. The whole run only fails when no canonical
      // sink took it, which is the case where nothing was archived anywhere.
      try {
        const out = await sink.putBatch(batch);
        sinkResults.push({
          id: sink.id,
          written: out.written,
          commit: out.commit,
          pushPending: out.pushPending,
          // A failed anchoring commit is not a failed write: the batch is on disk. It is
          // still recorded, and still makes the run degraded, because the sink did not do
          // everything it was asked to.
          error: out.anchorError,
        });
      } catch (err) {
        sinkResults.push({
          id: sink.id,
          written: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const canonicalWrote = args.sinks.some(
      (sink, i) => sink.capabilities.canonical && sinkResults[i]!.written,
    );
    if (!canonicalWrote) {
      const detail = sinkResults
        .filter((r) => r.error)
        .map((r) => `${r.id}: ${r.error}`)
        .join('; ');
      // Deliberately says "did not complete", not "nothing was archived". Sinks write
      // record files, then the manifest, then head — so a failure partway through leaves
      // real files behind, and this function cannot tell how far each sink got. Claiming
      // an empty archive would send the operator looking for data that may be sitting
      // there, and would be the same overclaim in the opposite direction.
      throw new Error(
        'No canonical sink completed this run. Files may already be on disk: sinks write ' +
          'record files, then the manifest, then the head pointer, so a failure partway ' +
          'through leaves what was written before it. Nothing here can tell you how far ' +
          `each sink got — run \`sf evidence verify --org-id ${args.orgId}\` to see what ` +
          `the archive actually holds before retrying. ${detail}`,
      );
    }

    // Refresh `_state/coverage.json` from the sink the reader reads, once it holds this
    // batch. Best-effort: the cache only makes the next run faster, and a failure here must
    // not report an archived batch as a failed run.
    if (sinkResults[args.sinks.indexOf(primary)]?.written) {
      try {
        await reader.summarise(args.orgId);
      } catch {
        // Deliberately ignored: the next run rebuilds the cache from the manifests.
      }
    }
  }

  return {
    runId,
    orgId: args.orgId,
    manifest: { seq, hash, prev },
    sources: sourceResults,
    sinks: sinkResults,
    orphansFound,
    metadata: {
      written: args.dryRun ? [] : metadata.files.map((f) => f.relPath),
      prepared: metadata.files.map((f) => f.relPath),
      ...(metadata.error === undefined ? {} : { error: metadata.error }),
    },
    dryRun: args.dryRun ?? false,
    clock: args.clock ?? 'local',
    ...(args.clockNote === undefined ? {} : { clockNote: args.clockNote }),
    degraded:
      sourceResults.some((s) => s.status !== 'complete') ||
      // Both sink failure shapes count: a sink that took nothing, and a sink that took the
      // batch but could not finish anchoring it.
      sinkResults.some((s) => !s.written || s.error !== undefined),
  };
}
