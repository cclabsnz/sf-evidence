import type { Collector } from '../../../src/types/collector.js';
import {
  assessCoverage,
  statusExit,
  uncoveredIntervals,
  type CoverageAssessment,
} from '../../../src/archive/coverage.js';

const w = (from: string, to: string) => ({
  from: `2026-${from}T00:00:00.000Z`,
  to: `2026-${to}T00:00:00.000Z`,
});

describe('uncoveredIntervals', () => {
  it('returns the whole range when nothing is covered', () => {
    expect(uncoveredIntervals([], w('01-01', '02-01').from, w('01-01', '02-01').to)).toEqual([w('01-01', '02-01')]);
  });

  it('returns nothing when the range is fully covered', () => {
    expect(uncoveredIntervals([w('01-01', '03-01')], w('01-15', '02-01').from, w('01-15', '02-01').to)).toEqual([]);
  });

  it('returns the holes between, before and after coverage, clipped to the range', () => {
    const coverage = [w('01-10', '01-20'), w('02-01', '02-10')];
    expect(uncoveredIntervals(coverage, w('01-01', '03-01').from, w('01-01', '03-01').to)).toEqual([
      w('01-01', '01-10'),
      w('01-20', '02-01'),
      w('02-10', '03-01'),
    ]);
  });

  it('merges unsorted, overlapping coverage before subtracting', () => {
    const coverage = [w('01-15', '02-01'), w('01-01', '01-20')];
    expect(uncoveredIntervals(coverage, w('01-01', '02-15').from, w('01-01', '02-15').to)).toEqual([
      w('02-01', '02-15'),
    ]);
  });

  it('ignores coverage entirely outside the range', () => {
    const coverage = [w('01-01', '01-05'), w('03-01', '04-01')];
    expect(uncoveredIntervals(coverage, w('02-01', '02-10').from, w('02-01', '02-10').to)).toEqual([
      w('02-01', '02-10'),
    ]);
  });

  it('returns nothing for an empty or inverted range', () => {
    expect(uncoveredIntervals([], w('02-01', '02-01').from, w('02-01', '02-01').to)).toEqual([]);
    expect(uncoveredIntervals([], w('02-01', '01-01').from, w('02-01', '01-01').to)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const coverage = [w('01-15', '02-01'), w('01-01', '01-20')];
    const copy = JSON.parse(JSON.stringify(coverage));
    uncoveredIntervals(coverage, w('01-01', '03-01').from, w('01-01', '03-01').to);
    expect(coverage).toEqual(copy);
  });
});

describe('assessCoverage', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const DAY = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const ago = (days: number) => iso(now.getTime() - days * DAY);
  const event = (coverage: { from: string; to: string }[], lastSuccess: string | null = null) => ({
    kind: 'event' as const,
    retentionDays: 180,
    coverage,
    lastSuccess,
  });

  it('complete coverage up to the last run is not a gap and has ~180d headroom', () => {
    const last = iso(now.getTime() - 60_000);
    const a = assessCoverage(event([{ from: ago(180), to: last }], last), now);
    expect(a.gaps).toEqual([]);
    expect(a.pending).toEqual({ from: last, to: now.toISOString() });
    expect(a.headroomSeconds).toBeGreaterThan(179 * 86400);
    expect(a.atRisk).toBe(false);
    expect(a.stale).toBe(false);
  });

  it('a source last covered 165 days ago is at risk with 15d 8h headroom', () => {
    const a = assessCoverage(
      event([{ from: '2026-02-16T00:00:00Z', to: '2026-03-03T17:00:00Z' }], '2026-03-03T17:00:00Z'),
      now,
      { windowDays: 180 },
    );
    expect(a.gaps).toEqual([]);
    expect(a.pending).toEqual({
      from: '2026-03-03T17:00:00.000Z',
      to: now.toISOString(),
    });
    expect(Math.abs((a.headroomSeconds as number) - 1_324_800)).toBeLessThanOrEqual(1);
    expect(a.atRisk).toBe(true);
    expect(a.destroyedAfter).toBe('2026-08-30T17:00:00.000Z');
  });

  it('a hole between two covered intervals is a gap, with headroom from the hole start', () => {
    const last = iso(now.getTime() - 60_000);
    const a = assessCoverage(
      event([
        { from: ago(180), to: ago(100) },
        { from: ago(40), to: last },
      ]),
      now,
    );
    expect(a.gaps).toEqual([{ from: ago(100), to: ago(40), days: 60 }]);
    expect(a.headroomSeconds).toBeCloseTo(80 * 86400, 0);
    expect(a.destroyedAfter).toBe(iso(now.getTime() - 100 * DAY + 180 * DAY));
    expect(a.atRisk).toBe(false);
  });

  it('an interval before a first --since run is a gap, not covered', () => {
    const last = iso(now.getTime() - 60_000);
    const a = assessCoverage(event([{ from: ago(30), to: last }]), now);
    expect(a.gaps).toEqual([{ from: ago(180), to: ago(30), days: 150 }]);
    expect(a.coverage).toEqual([{ from: ago(30), to: last }]);
    expect(a.atRisk).toBe(true);
  });

  it('does not re-clip coverage at now: the summary already ends each run at its created_at', () => {
    // ArchiveReader.summarise clips each entry at the created_at of its manifest, and the collect
    // planner reads that same summary. A second clip here, at status's own now, made status and
    // the planner disagree about where coverage ends whenever the two clocks differed.
    const runAt = iso(now.getTime() + 60_000);
    const a = assessCoverage(event([{ from: ago(180), to: runAt }]), now);
    expect(a.coverage).toEqual([{ from: ago(180), to: runAt }]);
    expect(a.pending).toBeNull();
    expect(a.gaps).toEqual([]);
  });

  it('an uncovered interval older than the window is lost and does not raise the exit', () => {
    const last = iso(now.getTime() - 60_000);
    const a = assessCoverage(
      event([
        { from: ago(300), to: ago(250) },
        { from: ago(190), to: last },
      ]),
      now,
      { windowDays: 365 },
    );
    // The span before the first coverage inside the window is lost too: it was never checked
    // and Salesforce has deleted it.
    expect(a.lost).toEqual([
      { from: ago(365), to: ago(300) },
      { from: ago(250), to: ago(190) },
    ]);
    expect(a.gaps).toEqual([]);
    expect(a.atRisk).toBe(false);
    expect(statusExit([a], false)).toBe(0);
    expect(statusExit([a], true)).toBe(0);
  });

  it('a dormant source reports the already-deleted stretch as lost, not pending', () => {
    const a = assessCoverage(event([{ from: ago(300), to: ago(200) }]), now, {
      windowDays: 180,
    });
    expect(a.lost).toEqual([{ from: ago(200), to: ago(180) }]);
    expect(a.pending).toEqual({ from: ago(180), to: now.toISOString() });
    expect(a.atRisk).toBe(true);
  });

  it('a source with no coverage and a window beyond retention loses the older part', () => {
    const a = assessCoverage(event([]), now, { windowDays: 365 });
    expect(a.lost).toEqual([{ from: ago(365), to: ago(180) }]);
    expect(a.pending).toEqual({ from: ago(180), to: now.toISOString() });
    expect(a.gaps).toEqual([]);
    expect(a.atRisk).toBe(true);
  });

  it('measures headroom over the retention window, whatever the evaluation window', () => {
    // Nothing collected: the oldest uncollected instant is now − retention, being deleted now.
    const none = assessCoverage(event([]), now, { windowDays: 30 });
    expect(none.headroomSeconds).toBe(0);
    expect(none.destroyedAfter).toBe(now.toISOString());
    expect(none.atRisk).toBe(true);
    // A window beyond retention does not push headroom negative: that older part is lost.
    expect(assessCoverage(event([]), now, { windowDays: 365 }).headroomSeconds).toBe(0);
    // Collected until 60 days ago, judged over the last 30: headroom still counts from 60 days ago.
    const stopped = assessCoverage(event([{ from: ago(180), to: ago(60) }]), now, { windowDays: 30 });
    expect(stopped.headroomSeconds).toBeCloseTo(120 * 86400, 0);
    // A hole older than a short window still sets the headroom.
    const last = iso(now.getTime() - 60_000);
    const older = assessCoverage(
      event([
        { from: ago(180), to: ago(170) },
        { from: ago(165), to: last },
      ]),
      now,
      { windowDays: 30 },
    );
    expect(older.headroomSeconds).toBeCloseTo(10 * 86400, 0);
    expect(older.atRisk).toBe(true);
  });

  it('a source with no coverage and window equal to retention is all pending and at risk', () => {
    const a = assessCoverage(event([]), now);
    expect(a.lost).toEqual([]);
    expect(a.pending).toEqual({ from: ago(180), to: now.toISOString() });
    expect(a.atRisk).toBe(true);
  });

  it('a hole crossing the retention boundary is split into a lost part and a gap part', () => {
    const last = iso(now.getTime() - 60_000);
    const a = assessCoverage(
      event([
        { from: ago(300), to: ago(200) },
        { from: ago(100), to: last },
      ]),
      now,
      { windowDays: 365 },
    );
    expect(a.lost).toEqual([
      { from: ago(365), to: ago(300) },
      { from: ago(200), to: ago(180) },
    ]);
    expect(a.gaps).toEqual([{ from: ago(180), to: ago(100), days: 80 }]);
    expect(a.atRisk).toBe(true);
  });

  it('a gap shorter than a day is reported as 1 day, and 164.67 days as 165', () => {
    const last = iso(now.getTime() - 60_000);
    const short = assessCoverage(
      event([
        { from: ago(180), to: ago(10) },
        { from: iso(now.getTime() - 10 * DAY + 3 * 3_600_000), to: last },
      ]),
      now,
    );
    expect(short.gaps.map((g) => g.days)).toEqual([1]);
    const g = assessCoverage(
      event([
        { from: ago(180), to: ago(170) },
        { from: ago(170 - 164.67), to: last },
      ]),
      now,
    );
    expect(g.gaps[0]?.days).toBe(165);
  });

  it('a snapshot source that has never been sampled is stale', () => {
    const a = assessCoverage(
      {
        kind: 'snapshot',
        retentionDays: null,
        coverage: [],
        lastSuccess: null,
      },
      now,
    );
    expect(a.stale).toBe(true);
  });

  it('a snapshot source with no sample for 27 hours is stale', () => {
    const snap = (h: number) => ({
      kind: 'snapshot' as const,
      retentionDays: null,
      coverage: [],
      lastSuccess: iso(now.getTime() - h * 3_600_000),
    });
    const a = assessCoverage(snap(27), now);
    expect(a.stale).toBe(true);
    expect(a.headroomSeconds).toBeNull();
    expect(a.destroyedAfter).toBeNull();
    expect(a.atRisk).toBe(false);
    expect(statusExit([a], false)).toBe(4);
  });

  it('a snapshot source with no sample for 25 hours is not stale', () => {
    const a = assessCoverage(
      {
        kind: 'snapshot',
        retentionDays: null,
        coverage: [],
        lastSuccess: iso(now.getTime() - 25 * 3_600_000),
      },
      now,
    );
    expect(a.stale).toBe(false);
    expect(statusExit([a], false)).toBe(0);
  });
});

describe('statusExit', () => {
  const base: CoverageAssessment = {
    coverage: [],
    gaps: [],
    pending: null,
    lost: [],
    headroomSeconds: 1e7,
    destroyedAfter: null,
    atRisk: false,
    stale: false,
  };
  const gap = { from: 'a', to: 'b', days: 1 };

  it('at-risk is 3 without --strict; a plain gap is 4; --strict makes a gap 3', () => {
    expect(statusExit([{ ...base, atRisk: true }], false)).toBe(3);
    expect(statusExit([{ ...base, gaps: [gap] }], false)).toBe(4);
    expect(statusExit([{ ...base, gaps: [gap] }], true)).toBe(3);
    expect(statusExit([base], true)).toBe(0);
    expect(statusExit([base, { ...base, stale: true }], false)).toBe(4);
  });
});

describe('collector kind typing', () => {
  it('refuses a null retention on an event source at compile time', () => {
    // Consumed by `tsc`: if the unions regress, the unused directive fails the typecheck.
    // @ts-expect-error an event source must have a numeric retentionDays
    const input: Parameters<typeof assessCoverage>[0] = {
      kind: 'event',
      retentionDays: null,
      coverage: [],
      lastSuccess: null,
    };
    // @ts-expect-error an event collector must have a numeric retentionDays
    const collector: Collector = {
      source: 'audit-trail',
      kind: 'event',
      retentionDays: null,
      describeQueries: () => [],
      collect: async () => {
        throw new Error('unused');
      },
    };
    expect(input.kind).toBe('event');
    expect(collector.kind).toBe('event');
  });
});
