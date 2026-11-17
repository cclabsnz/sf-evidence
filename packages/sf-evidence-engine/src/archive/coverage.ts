import { EXIT, type ExitCode } from '../lib/exit.js';
import { mergeWindows } from '../lib/windows.js';
import type { TimeWindow } from '../types/manifest.js';

/**
 * The sub-intervals of `[from, to)` that `coverage` does not cover, sorted.
 *
 * The one implementation of "what is missing". Collection planning uses it to re-collect
 * gaps, and gap assessment builds on it, so the two can never disagree about where a gap is.
 * Coverage may be unsorted or overlapping; it is merged first. An empty or inverted range
 * has nothing uncovered.
 */
export function uncoveredIntervals(coverage: TimeWindow[], from: string, to: string): TimeWindow[] {
  const gaps: TimeWindow[] = [];
  let cursor = from;

  for (const w of mergeWindows(coverage)) {
    if (cursor >= to) break;
    if (w.to <= cursor) continue;
    if (w.from > cursor) gaps.push({ from: cursor, to: w.from < to ? w.from : to });
    if (w.to > cursor) cursor = w.to;
  }

  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

/** Milliseconds in a day. */
export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface Gap {
  from: string;
  to: string;
  days: number;
}

export interface CoverageAssessment {
  /** Merged achieved coverage from the start of the evaluation window (its end is not clipped at now). */
  coverage: TimeWindow[];
  /** Uncovered intervals inside both the evaluation window and retention, up to the last covered instant. */
  gaps: Gap[];
  /** (last covered instant, now]. Not yet collected, not a hole (R5). */
  pending: TimeWindow | null;
  /**
   * Uncovered inside the evaluation window and entirely beyond retention: already destroyed, not
   * actionable (R6). Only a window longer than retention can hold any.
   */
  lost: TimeWindow[];
  /**
   * Seconds until the oldest uncovered instant still inside retention is destroyed, measured over
   * the retention window whatever the evaluation window is. Null for snapshot sources.
   */
  headroomSeconds: number | null;
  /** Oldest uncovered instant plus retention. Null for snapshot sources. */
  destroyedAfter: string | null;
  atRisk: boolean;
  /** Snapshot sources only: no sample within `staleAfterHours` (R7). */
  stale: boolean;
}

interface CoverageInputBase {
  coverage: TimeWindow[];
  lastSuccess: string | null;
}

/** Mirrors `Collector`: an event source always has a retention window, a snapshot source never does. */
export type CoverageInput =
  | (CoverageInputBase & { kind: 'event'; retentionDays: number })
  | (CoverageInputBase & { kind: 'snapshot'; retentionDays: null });

const toIso = (ms: number): string => new Date(ms).toISOString();

/** The oldest instant Salesforce still holds for a source with this retention: `now - retentionDays`. */
export function retentionStart(now: Date, retentionDays: number): string {
  return toIso(now.getTime() - retentionDays * DAY_MS);
}

/**
 * What the archive holds, what it is missing, and how long until the missing part is gone.
 *
 * Gaps and lost intervals are both derived from `uncoveredIntervals`; this function only
 * decides which range to ask about. Pure: no sink access.
 */
export function assessCoverage(
  input: CoverageInput,
  now: Date,
  opts: { windowDays?: number; staleAfterHours?: number } = {},
): CoverageAssessment {
  const nowMs = now.getTime();
  const nowIso = toIso(nowMs);
  const windowDays = opts.windowDays ?? input.retentionDays;
  const windowStartMs = windowDays === null ? Number.NEGATIVE_INFINITY : nowMs - windowDays * DAY_MS;
  const windowStart = Number.isFinite(windowStartMs) ? toIso(windowStartMs) : '0000-01-01T00:00:00.000Z';

  // Clipped to the evaluation window's start only. The end is not clipped at `now`: the summary
  // already ends each run's coverage at its created_at, and a second clip at this host's clock
  // would make `status` disagree with the collect planner, which reads the same summary.
  const clipped: TimeWindow[] = [];
  for (const w of mergeWindows(input.coverage)) {
    const from = toIso(Math.max(Date.parse(w.from), windowStartMs));
    const to = toIso(Date.parse(w.to));
    if (from < to) clipped.push({ from, to });
  }
  const coverage = mergeWindows(clipped);

  if (input.kind === 'snapshot') {
    const staleAfterMs = (opts.staleAfterHours ?? 26) * HOUR_MS;
    const last = input.lastSuccess === null ? null : Date.parse(input.lastSuccess);
    return {
      coverage,
      gaps: [],
      pending: null,
      lost: [],
      headroomSeconds: null,
      destroyedAfter: null,
      atRisk: false,
      stale: last === null || nowMs - last > staleAfterMs,
    };
  }

  const retentionMs = input.retentionDays * DAY_MS;
  const retentionStartIso = retentionStart(now, input.retentionDays);
  const retentionStartMs = Date.parse(retentionStartIso);
  const lastCovered = coverage.at(-1)?.to ?? null;

  let gaps: Gap[] = [];
  let lost: TimeWindow[] = [];
  let pending: TimeWindow | null = null;

  if (lastCovered === null) {
    // Coverage that ended before the evaluation window is clipped away but still marks where
    // collection stopped; everything after it that Salesforce has deleted is lost.
    const droppedTo = mergeWindows(input.coverage).at(-1)?.to;
    const lostFrom =
      droppedTo !== undefined && toIso(Date.parse(droppedTo)) < windowStart
        ? toIso(Date.parse(droppedTo))
        : windowStart;
    if (lostFrom < retentionStartIso) lost = [{ from: lostFrom, to: retentionStartIso }];
    pending = {
      from: windowStart > retentionStartIso ? windowStart : retentionStartIso,
      to: nowIso,
    };
  } else {
    const gapsFrom = toIso(Math.max(windowStartMs, retentionStartMs));
    gaps = uncoveredIntervals(coverage, gapsFrom, lastCovered).map((g) => ({
      ...g,
      // Rounded up, minimum 1: a gap of any length is never reported as 0 days.
      days: Math.max(1, Math.ceil((Date.parse(g.to) - Date.parse(g.from)) / DAY_MS)),
    }));
    // From the window start, not the first coverage: with a window longer than retention, the
    // span before the first coverage was never collected and Salesforce has deleted it.
    const lostTo = toIso(Math.min(Date.parse(lastCovered), retentionStartMs));
    lost = uncoveredIntervals(coverage, windowStart, lostTo);
    if (lastCovered < nowIso) {
      // Part of the trailing interval Salesforce has already deleted is lost, not pending.
      if (lastCovered < retentionStartIso) lost.push({ from: lastCovered, to: retentionStartIso });
      pending = {
        from: lastCovered > retentionStartIso ? lastCovered : retentionStartIso,
        to: nowIso,
      };
    }
  }

  // Headroom is a property of the source, not of the window it is viewed through: a short
  // --window must not hide that Salesforce is deleting the oldest uncollected data now.
  const oldestUncovered = uncoveredIntervals(mergeWindows(input.coverage), retentionStartIso, nowIso)[0]?.from;
  const oldestUncoveredMs = oldestUncovered === undefined ? nowMs : Date.parse(oldestUncovered);

  const headroomSeconds = (oldestUncoveredMs + retentionMs - nowMs) / 1000;
  return {
    coverage,
    gaps,
    pending,
    lost,
    headroomSeconds,
    destroyedAfter: toIso(oldestUncoveredMs + retentionMs),
    atRisk: headroomSeconds < input.retentionDays * 0.1 * 86400,
    stale: false,
  };
}

/** 3 when any source is at risk (or any gap under `strict`), 4 for gaps or stale snapshots, else 0. */
export function statusExit(
  assessments: Pick<CoverageAssessment, 'gaps' | 'atRisk' | 'stale'>[],
  strict: boolean,
): ExitCode {
  const anyGap = assessments.some((a) => a.gaps.length > 0);
  if (assessments.some((a) => a.atRisk) || (strict && anyGap)) return EXIT.INTEGRITY;
  if (anyGap || assessments.some((a) => a.stale)) return EXIT.DEGRADED;
  return EXIT.OK;
}
