import type { Sink } from '../types/sink.js';
import { mergeWindows } from '../lib/windows.js';
import { manifestHash } from '../chain/manifestBuilder.js';
import { canonicalBytes } from '../chain/canonical.js';
import { sha256Hex } from '../chain/hash.js';
import type { SourceOutcomeEntry, SourceStatus, TimeWindow } from '../types/manifest.js';
import type { NormalisedRecord, SourceId } from '../types/record.js';

export interface SourceSummary {
  source: SourceId;
  /** `created_at` of the most recent manifest touching this source. */
  lastRun: string | null;
  /** `created_at` of the newest manifest whose entry for this source is `complete`. */
  lastSuccess: string | null;
  /**
   * `created_at` of the newest manifest whose entry for this source stored records
   * (`record_count > 0`). A run that stored nothing, such as a deduped snapshot, does not move
   * it. For `limits` this equals the stored sample's `payload.sampled_at`.
   */
  lastWritten: string | null;
  recordCount: number;
  /**
   * Intervals actually covered, sorted and merged: the union of `achievedOf` across every
   * manifest entry regardless of status, so a partial run counts for what it achieved. Each
   * entry is clipped at its manifest's `created_at`: no run covered time after it ran.
   *
   * A list rather than a from/to pair because coverage is not necessarily
   * contiguous: a month with no run at all leaves a hole that a single range
   * would silently paper over. Named to match SPEC.md §8.4.
   */
  coverage: TimeWindow[];
  statuses: Record<SourceStatus, number>;
}

/**
 * The sub-ranges of an entry's window that it actually covered.
 *
 * Manifests written before `achieved` existed carry only `window` and `status`. For those,
 * `complete` meant the whole window and anything else meant nothing could be vouched for.
 */
export function achievedOf(entry: SourceOutcomeEntry): TimeWindow[] {
  if (entry.achieved) return entry.achieved;
  return entry.status === 'complete' ? [entry.window] : [];
}

/**
 * `windows` cut off at `at`, dropping any that start at or after it.
 *
 * An entry can claim coverage past the moment its run happened (a legacy unvalidated
 * `--until`, or a clock ahead of the org). Clipping here, once, is what makes `status` and the
 * collect planner read the same coverage: both take it from this summary.
 */
function clipAt(windows: TimeWindow[], at: string): TimeWindow[] {
  return windows.filter((w) => w.from < at).map((w) => (w.to > at ? { from: w.from, to: at } : w));
}

/** `_state/coverage.json`: a derived cache of `summarise`, keyed to the chain seq it reflects. */
const COVERAGE_STATE = 'coverage.json';
const COVERAGE_VERSION = 3;

interface CoverageCache {
  version: typeof COVERAGE_VERSION;
  /** The highest manifest seq folded into `summaries`. */
  seq: number;
  summaries: SourceSummary[];
  /**
   * `manifestHash` of the manifest at `seq`. A cache is trusted only while the chain still
   * holds that exact manifest, so a replaced chain of the same length cannot reuse it.
   */
  manifest_hash?: string;
  /** `sha256:` over the canonical bytes of `summaries`, so an edited value is detected. */
  summaries_sha256?: string;
}

function summariesDigest(summaries: SourceSummary[]): string {
  return `sha256:${sha256Hex(canonicalBytes(summaries))}`;
}

const PARTITION_RE = /\/year=(\d{4})\/month=(\d{2})\//;

/**
 * Whether a record file's month partition can hold a record inside `window`.
 *
 * Inclusive at both ends, so a window that starts or ends exactly on a month boundary still
 * reads the neighbouring partition: reading one file too many costs time, reading one too few
 * lets a duplicate in. A path without a recognisable partition is always read, for the same
 * reason.
 */
function partitionTouches(relPath: string, window: TimeWindow): boolean {
  const m = PARTITION_RE.exec(relPath);
  if (!m) return true;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const end = new Date(Date.UTC(year, month, 1)).toISOString();
  return start <= window.to && end >= window.from;
}

function isCoverageCache(value: unknown): value is CoverageCache {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CoverageCache>;
  return (
    v.version === COVERAGE_VERSION &&
    Number.isInteger(v.seq) &&
    (v.seq as number) >= 0 &&
    Array.isArray(v.summaries) &&
    v.summaries.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof s.source === 'string' &&
        typeof s.recordCount === 'number' &&
        Array.isArray(s.coverage) &&
        typeof s.statuses === 'object' &&
        s.statuses !== null,
    )
  );
}

/** A source the archive holds nothing for: no run, no records, no coverage. */
export function emptySummary(source: SourceId): SourceSummary {
  return {
    source,
    lastRun: null,
    lastSuccess: null,
    lastWritten: null,
    recordCount: 0,
    coverage: [],
    statuses: { complete: 0, partial: 0, degraded: 0, failed: 0 },
  };
}

/**
 * The only component permitted to assume the archive layout (SPEC.md §3.1, §5.1). Every
 * consumer — verify, status, and later query and check — goes through it, so a layout
 * change has exactly one call site.
 */
export class ArchiveReader {
  public constructor(private readonly sink: Sink) {}

  /**
   * Every `source_id` already archived for a source within `window`'s month partitions, for
   * write-time dedupe (SPEC.md §10.1).
   *
   * Records are partitioned by the month they occurred in, so a record inside `window` can
   * only be in a partition the window touches; files in other months are never read. This is
   * still derived from the manifests and record files, not from `_state/`, so it is correct
   * whatever state the cache is in.
   */
  public async knownSourceIds(orgId: string, source: SourceId, window: TimeWindow): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const seq of await this.sink.listManifests(orgId)) {
      const manifest = await this.sink.readManifest(orgId, seq);
      for (const entry of manifest?.sources ?? []) {
        if (entry.source !== source) continue;
        for (const file of entry.files) {
          if (!partitionTouches(file.path, window)) continue;
          const bytes = await this.sink.readFile(file.path);
          for (const line of bytes.toString('utf8').split('\n')) {
            if (line.length === 0) continue;
            ids.add((JSON.parse(line) as NormalisedRecord).source_id);
          }
        }
      }
    }
    return ids;
  }

  /**
   * Per-source coverage summary, computed from manifests rather than from state files.
   *
   * `_state/coverage.json` caches the result with the seq it reflects, and only manifests
   * after that seq are replayed. The cache is disposable (SPEC.md §5.4): when it is missing,
   * unreadable, unparsable, the wrong version, ahead of the highest manifest, its summaries
   * do not match their stored digest, or the manifest at its seq is not the one it was built
   * from, the summary is
   * rebuilt from seq 1 and the answer is the same. With `persist: false` nothing is written,
   * which is what a dry run needs.
   */
  public async summarise(orgId: string, opts: { persist?: boolean } = {}): Promise<SourceSummary[]> {
    // The chain head here is the highest manifest present, not head.json: the uncached
    // fold reads every listed manifest, so this is what keeps the cached answer identical to
    // it, including when a head write was interrupted or a manifest has gone missing.
    const seqs = await this.sink.listManifests(orgId);
    const headSeq = seqs.at(-1) ?? 0;
    const cached = await this.readCoverageCache(orgId, headSeq);
    if (cached && cached.seq === headSeq) return cached.summaries;

    const fromSeq = cached?.seq ?? 0;
    const acc = new Map<SourceId, SourceSummary>();
    const achievedWindows = new Map<SourceId, TimeWindow[]>();
    for (const s of cached?.summaries ?? []) {
      acc.set(s.source, { ...s, statuses: { ...s.statuses }, coverage: [] });
      achievedWindows.set(s.source, [...s.coverage]);
    }

    let headHash: string | undefined;
    for (const seq of seqs) {
      if (seq <= fromSeq) continue;
      const manifest = await this.sink.readManifest(orgId, seq);
      if (!manifest) continue;
      if (seq === headSeq) headHash = manifestHash(manifest);

      for (const entry of manifest.sources) {
        let s = acc.get(entry.source);
        if (!s) {
          s = emptySummary(entry.source);
          acc.set(entry.source, s);
          achievedWindows.set(entry.source, []);
        }

        s.recordCount += entry.record_count;
        s.statuses[entry.status] += 1;
        if (!s.lastRun || manifest.created_at > s.lastRun) s.lastRun = manifest.created_at;

        if (entry.status === 'complete' && (!s.lastSuccess || manifest.created_at > s.lastSuccess)) {
          s.lastSuccess = manifest.created_at;
        }
        if (entry.record_count > 0 && (!s.lastWritten || manifest.created_at > s.lastWritten)) {
          s.lastWritten = manifest.created_at;
        }
        achievedWindows.get(entry.source)!.push(...clipAt(achievedOf(entry), manifest.created_at));
      }
    }

    for (const s of acc.values()) {
      s.coverage = mergeWindows(achievedWindows.get(s.source) ?? []);
    }

    const summaries = [...acc.values()].sort((a, b) => (a.source < b.source ? -1 : 1));
    // An org with no manifests gets no cache: writing one would create the org's directory.
    // Without the head manifest's hash the cache could not be verified on read, so none is
    // written (only a sink that lists a seq it cannot read gets here).
    if (opts.persist !== false && headHash !== undefined) {
      await this.writeCoverageCache(orgId, {
        version: COVERAGE_VERSION,
        seq: headSeq,
        summaries,
        manifest_hash: headHash,
        summaries_sha256: summariesDigest(summaries),
      });
    }
    return summaries;
  }

  /** The cache when it is usable for this chain, otherwise null. Never throws. */
  private async readCoverageCache(orgId: string, headSeq: number): Promise<CoverageCache | null> {
    try {
      const raw = await this.sink.readState(orgId, COVERAGE_STATE);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isCoverageCache(parsed) || parsed.seq < 1 || parsed.seq > headSeq) return null;
      // Shape alone is not trust (SPEC.md §5.4): the summaries must hash to what was stored,
      // and the chain must still hold the manifest the cache was built up to.
      if (parsed.summaries_sha256 !== summariesDigest(parsed.summaries)) return null;
      const manifest = await this.sink.readManifest(orgId, parsed.seq);
      if (!manifest || manifestHash(manifest) !== parsed.manifest_hash) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort. A cache that cannot be written makes the next read slower, never wrong, so
   * a write failure must not fail the command that asked for the summary.
   */
  private async writeCoverageCache(orgId: string, cache: CoverageCache): Promise<void> {
    try {
      await this.sink.writeState(orgId, COVERAGE_STATE, JSON.stringify(cache));
    } catch {
      // Deliberately ignored: see above.
    }
  }
}
