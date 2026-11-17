import { COLLECTORS } from '../collectors/registry.js';
import { EXIT, type ExitCode } from '../lib/exit.js';
import { assessCoverage, statusExit, type CoverageAssessment } from './coverage.js';
import { emptySummary, type SourceSummary } from './reader.js';
import type { SourceId } from '../types/record.js';

/** Every assessment field, `null`: what a source nothing assessed carries in their place. */
type Unassessed = { [K in keyof Omit<CoverageAssessment, 'coverage'>]: null };

/**
 * One source as `status` reports it: the archive summary overlaid with the assessment of its
 * coverage, so `coverage` is the assessment's (clipped to the evaluation window), not the
 * summary's.
 *
 * A source whose collector is not registered in this release has no known retention window, so
 * nothing about it was assessed. It keeps its held coverage and carries `null` for every
 * assessment field, `atRisk` and `stale` included: `false` there would be a verdict nothing
 * computed.
 */
export type StatusRow =
  | (SourceSummary & CoverageAssessment & { kind: 'event'; retentionDays: number })
  // A snapshot source has samples, not coverage: `coverage` is null so no consumer can read a
  // range into one reading. Its hour bucket is the dedupe unit (SPEC.md §4.4), not a claim.
  | (Omit<SourceSummary, 'coverage'> & Omit<CoverageAssessment, 'coverage'> & { coverage: null; kind: 'snapshot'; retentionDays: null })
  | (SourceSummary & Unassessed & { kind: null; retentionDays: null });

export interface StatusAssessment {
  rows: StatusRow[];
  /** The exit code `status` returns (SPEC.md §8.4). */
  exit: ExitCode;
  /** Whether any assessed source is at risk: exit 3 whatever `strict` says. */
  atRisk: boolean;
}

export interface AssessStatusOptions {
  /** Days back from `now` to evaluate. Defaults to each source's retention window. */
  windowDays?: number;
  /** Any gap is exit 3, not only coverage at risk. */
  strict?: boolean;
  /**
   * Report exactly these sources, sorted and de-duplicated. One the archive holds nothing for
   * is reported as nothing collected, never left out. Defaults to every summarised source.
   */
  sources?: SourceId[];
}

function toRow(summary: SourceSummary, now: Date, windowDays: number | undefined): StatusRow {
  const collector = COLLECTORS[summary.source];
  if (!collector) {
    return {
      ...summary,
      kind: null,
      retentionDays: null,
      gaps: null,
      pending: null,
      lost: null,
      headroomSeconds: null,
      destroyedAfter: null,
      atRisk: null,
      stale: null,
    };
  }

  const base = { coverage: summary.coverage, lastSuccess: summary.lastSuccess };
  if (collector.kind === 'snapshot') {
    // Staleness runs from the newest stored sample: a run that stored nothing proves no sample.
    const a = assessCoverage({ ...base, lastSuccess: summary.lastWritten, kind: 'snapshot', retentionDays: null }, now, { windowDays });
    return { ...summary, ...a, coverage: null, kind: 'snapshot', retentionDays: null };
  }
  const a = assessCoverage({ ...base, kind: 'event', retentionDays: collector.retentionDays }, now, { windowDays });
  return { ...summary, ...a, kind: 'event', retentionDays: collector.retentionDays };
}

/**
 * Every decision `sf evidence status` makes, from the archive summary to the exit code, so any
 * host reaches the same answer from the same archive. Kind and retention come from the
 * collector registry. Pure: no sink access.
 *
 * The exit is `statusExit` over the assessed sources, raised from 0 to 4 for two rows that
 * have not earned "full coverage" though nothing in them is at risk or gapped: a source nothing
 * assessed, and an event source with no coverage in the window (no covered instant for a gap
 * to precede). With no rows and no named source the archive holds nothing for the org, and the
 * exit is 1, as `verify` exits on an empty chain: nothing was assessed, and a wrong org id or
 * archive path must not pass a CI gate as complete.
 *
 * Throws when `windowDays` is not a positive whole number of days.
 */
export function assessStatus(
  summaries: readonly SourceSummary[],
  now: Date,
  opts: AssessStatusOptions = {},
): StatusAssessment {
  if (opts.windowDays !== undefined && !(Number.isInteger(opts.windowDays) && opts.windowDays > 0)) {
    throw new Error(`windowDays must be a positive whole number of days; got ${String(opts.windowDays)}.`);
  }
  const selected =
    opts.sources === undefined
      ? [...summaries]
      : [...new Set(opts.sources)]
          .sort()
          .map((name) => summaries.find((s) => s.source === name) ?? emptySummary(name));

  const rows = selected.map((s) => toRow(s, now, opts.windowDays));
  if (rows.length === 0 && opts.sources === undefined) return { rows, exit: EXIT.ERROR, atRisk: false };
  const assessed = rows.filter((r): r is Exclude<StatusRow, { kind: null }> => r.kind !== null);

  let exit = statusExit(assessed, opts.strict ?? false);
  const unearned = rows.some((r) => r.kind === null || (r.kind === 'event' && r.coverage.length === 0));
  if (exit === EXIT.OK && unearned) exit = EXIT.DEGRADED;

  return { rows, exit, atRisk: assessed.some((a) => a.atRisk) };
}
