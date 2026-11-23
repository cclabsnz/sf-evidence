import { assessStatus } from '../../../src/archive/status.js';
import type { SourceSummary } from '../../../src/archive/reader.js';
import { EXIT } from '../../../src/lib/exit.js';
import type { TimeWindow } from '../../../src/types/manifest.js';
import type { SourceId } from '../../../src/types/record.js';

/**
 * Every decision `status` makes, in the engine, so a host other than the CLI (the AWS Lambda)
 * reaches the same rows and the same exit code from the same archive. The exits pinned here
 * are the ones test/unit/commands/status.test.ts pins through the CLI.
 */
const NOW = new Date('2026-08-15T09:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
/** now − 180d. */
const RETENTION_START = ago(180);

function summary(source: SourceId, coverage: TimeWindow[], over: Partial<SourceSummary> = {}): SourceSummary {
  return {
    source,
    lastRun: ago(0.01),
    lastSuccess: ago(0.01),
    lastWritten: ago(0.01),
    recordCount: 1,
    coverage,
    statuses: { complete: coverage.length > 0 ? 1 : 0, partial: 0, degraded: 0, failed: 0 },
    ...over,
  };
}

const hole = summary('audit-trail', [
  { from: RETENTION_START, to: '2026-06-01T00:00:00.000Z' },
  { from: '2026-07-01T00:00:00.000Z', to: NOW_ISO },
]);

describe('assessStatus', () => {
  it('exits 3 on at-risk coverage without strict', () => {
    const s = assessStatus([summary('audit-trail', [{ from: RETENTION_START, to: '2026-03-03T17:00:00.000Z' }])], NOW);
    expect(s.exit).toBe(EXIT.INTEGRITY);
    expect(s.atRisk).toBe(true);
    expect(s.rows[0]).toMatchObject({ kind: 'event', retentionDays: 180, gaps: [], atRisk: true });
  });

  it('exits 4 on a gap that is not at risk, and 3 with strict', () => {
    const s = assessStatus([hole], NOW);
    expect(s.exit).toBe(EXIT.DEGRADED);
    expect(s.atRisk).toBe(false);
    expect(assessStatus([hole], NOW, { strict: true }).exit).toBe(EXIT.INTEGRITY);
  });

  it('exits 0 with only pending coverage', () => {
    const s = assessStatus([summary('audit-trail', [{ from: RETENTION_START, to: ago(5) }])], NOW);
    expect(s.exit).toBe(EXIT.OK);
    expect(s.rows[0]).toMatchObject({ pending: { from: ago(5), to: NOW_ISO } });
  });

  it('renders the assessment coverage, clipped to the window, not the summary coverage', () => {
    const s = assessStatus([summary('audit-trail', [{ from: ago(400), to: NOW_ISO }])], NOW);
    expect(s.rows[0]!.coverage).toEqual([{ from: RETENTION_START, to: NOW_ISO }]);
  });

  it('marks a source with no registered collector unassessed: nulls, never computed-looking values, and exit 4', () => {
    // Every SourceId has a collector since login-history was registered, so this stands in
    // for a source an older or newer release archived that this one has no collector for.
    const unregistered = 'retired-source' as SourceId;
    const s = assessStatus(
      [
        summary('audit-trail', [{ from: RETENTION_START, to: NOW_ISO }]),
        summary(unregistered, [{ from: RETENTION_START, to: '2026-03-03T17:00:00.000Z' }]),
      ],
      NOW,
    );
    expect(s.rows[1]).toMatchObject({
      source: unregistered,
      kind: null,
      retentionDays: null,
      gaps: null,
      pending: null,
      lost: null,
      headroomSeconds: null,
      destroyedAfter: null,
      atRisk: null,
      stale: null,
    });
    // Held coverage is still reported as held.
    expect(s.rows[1]!.coverage).toEqual([{ from: RETENTION_START, to: '2026-03-03T17:00:00.000Z' }]);
    expect(s.atRisk).toBe(false);
    expect(s.exit).toBe(EXIT.DEGRADED);
  });

  it('marks a snapshot source with no sample in 26 hours stale, and exits 4', () => {
    const s = assessStatus(
      [summary('limits', [{ from: ago(3), to: ago(2) }], { lastSuccess: ago(1 / 24), lastWritten: ago(27 / 24) })],
      NOW,
    );
    expect(s.rows[0]).toMatchObject({ kind: 'snapshot', stale: true, headroomSeconds: null });
    expect(s.exit).toBe(EXIT.DEGRADED);
  });

  it('reports a snapshot row with samples and no coverage intervals', () => {
    const s = assessStatus(
      [summary('limits', [{ from: ago(3), to: ago(2) }], { lastSuccess: ago(1 / 24), lastWritten: ago(1 / 24) })],
      NOW,
    );
    expect(s.rows[0]).toMatchObject({ kind: 'snapshot', coverage: null, gaps: [], stale: false });
  });

  it('measures headroom for a source with nothing collected from now − retention, whatever the window', () => {
    // Salesforce is deleting the oldest of it now. A 30-day window must not turn that into
    // 150 days of headroom.
    const s = assessStatus([summary('audit-trail', [], { lastSuccess: null })], NOW, { windowDays: 30 });
    expect(s.rows[0]).toMatchObject({ headroomSeconds: 0, atRisk: true, destroyedAfter: NOW_ISO });
    expect(s.exit).toBe(EXIT.INTEGRITY);
  });

  it('never exits 0 for an event source with no coverage in the window', () => {
    // Collected until 60 days ago: 120 days of headroom, nothing at risk, no gap, but the 30-day
    // window holds nothing at all.
    const s = assessStatus([summary('audit-trail', [{ from: RETENTION_START, to: ago(60) }])], NOW, {
      windowDays: 30,
    });
    expect(s.rows[0]).toMatchObject({ coverage: [], atRisk: false });
    expect((s.rows[0] as { headroomSeconds: number }).headroomSeconds).toBeCloseTo(120 * 86400, 0);
    expect(s.exit).toBe(EXIT.DEGRADED);
  });

  it('with a window beyond retention, reports the span before the first coverage as lost', () => {
    const s = assessStatus([summary('audit-trail', [{ from: RETENTION_START, to: NOW_ISO }])], NOW, {
      windowDays: 365,
    });
    expect(s.rows[0]).toMatchObject({ lost: [{ from: ago(365), to: RETENTION_START }], gaps: [] });
    // Lost time cannot be fixed and does not raise the exit (R6).
    expect(s.exit).toBe(EXIT.OK);
  });

  it('with a window beyond retention, splits the span before the first coverage into lost and gap', () => {
    const s = assessStatus([summary('audit-trail', [{ from: ago(100), to: NOW_ISO }])], NOW, {
      windowDays: 365,
    });
    expect(s.rows[0]).toMatchObject({
      lost: [{ from: ago(365), to: RETENTION_START }],
      gaps: [{ from: RETENTION_START, to: ago(100), days: 80 }],
    });
    // The gap starts at the retention boundary: Salesforce is deleting it now.
    expect(s.exit).toBe(EXIT.INTEGRITY);
  });

  it('reports exactly the named sources, with a named source the archive lacks as nothing collected', () => {
    const s = assessStatus(
      [summary('limits', [{ from: ago(0.04), to: NOW_ISO }]), hole],
      NOW,
      { sources: ['limits', 'audit-trail', 'limits'] },
    );
    expect(s.rows.map((r) => r.source)).toEqual(['audit-trail', 'limits']);

    const missing = assessStatus([summary('limits', [{ from: ago(0.04), to: NOW_ISO }])], NOW, {
      sources: ['audit-trail'],
    });
    expect(missing.rows).toHaveLength(1);
    expect(missing.rows[0]).toMatchObject({ source: 'audit-trail', recordCount: 0, coverage: [], lastRun: null });
    expect(missing.exit).toBe(EXIT.INTEGRITY);
  });

  it('exits 1 with no rows and no named source: nothing was assessed, as verify does on an empty chain', () => {
    // Exit 0 means complete. A wrong --org-id or --archive reads as an empty archive, and
    // must not pass a CI gate as "complete".
    expect(assessStatus([], NOW)).toEqual({ rows: [], exit: EXIT.ERROR, atRisk: false });
  });

  it('keeps assessing named sources on an empty archive: each is reported as nothing collected', () => {
    const s = assessStatus([], NOW, { sources: ['audit-trail'] });
    expect(s.rows).toHaveLength(1);
    expect(s.exit).toBe(EXIT.INTEGRITY);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects windowDays %s with a clear error', (windowDays) => {
    expect(() => assessStatus([hole], NOW, { windowDays })).toThrow(/windowDays must be a positive whole number of days/);
  });

  it('accepts a positive whole windowDays', () => {
    expect(() => assessStatus([hole], NOW, { windowDays: 30 })).not.toThrow();
  });
});
