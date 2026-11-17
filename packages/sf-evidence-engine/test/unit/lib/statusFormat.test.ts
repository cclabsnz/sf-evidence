import { formatStatus } from '../../../src/lib/statusFormat.js';
import type { StatusRow } from '../../../src/archive/status.js';
import { assessCoverage, type CoverageInput } from '../../../src/archive/coverage.js';
import type { SourceSummary } from '../../../src/archive/reader.js';
import type { TimeWindow } from '../../../src/types/manifest.js';
import type { SourceId } from '../../../src/types/record.js';

const NOW = new Date('2026-08-15T09:00:00.000Z');

function summary(source: SourceId, lastRun: string | null, recordCount: number, coverage: TimeWindow[]): SourceSummary {
  return {
    source,
    lastRun,
    lastSuccess: lastRun,
    lastWritten: lastRun,
    recordCount,
    coverage,
    statuses: { complete: coverage.length > 0 ? 1 : 0, partial: 0, degraded: 0, failed: 0 },
  };
}

/** A row as `status` builds it: the summary, overlaid with the assessment of its coverage. */
function row(
  s: SourceSummary,
  kind: { kind: 'event'; retentionDays: number } | { kind: 'snapshot'; retentionDays: null },
  now: Date = NOW,
): StatusRow {
  const input = { coverage: s.coverage, lastSuccess: s.lastSuccess, ...kind } as CoverageInput;
  const coverage = kind.kind === 'snapshot' ? { coverage: null } : {};
  return { ...s, ...assessCoverage(input, now), ...coverage, ...kind } as StatusRow;
}

const EVENT = { kind: 'event', retentionDays: 180 } as const;
const SNAPSHOT = { kind: 'snapshot', retentionDays: null } as const;

describe('formatStatus', () => {
  it('renders the SPEC §8.4 example', () => {
    // The spec's three sources, with login-history's trailing interval rendered per rule R5:
    // pending, not a gap. Last covered 2026-03-03T17:00Z, so the oldest uncovered instant is
    // destroyed 180 days later, 2026-08-30T17:00Z: 15d 8h from now, inside the 18-day threshold.
    const lines = formatStatus([
      row(
        summary('audit-trail', '2026-08-15T09:00:12.482Z', 71204, [
          { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
        ]),
        EVENT,
      ),
      row(
        summary('login-history', '2026-03-03T17:00:00.000Z', 9881, [
          { from: '2026-02-16T00:00:00.000Z', to: '2026-03-03T17:00:00.000Z' },
        ]),
        EVENT,
      ),
      row(
        summary('limits', '2026-08-15T09:00:12.482Z', 184, [
          { from: '2026-02-12T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
        ]),
        SNAPSHOT,
      ),
    ]);
    const text = lines.join('\n');

    expect(text).toMatch(/^audit-trail\s+last run 2026-08-15 09:00:12\.482Z\s+71,204 records$/m);
    expect(text).toMatch(/^\s+coverage 2026-02-16 09:00Z → 2026-08-15 09:00Z\s+\(180d window: complete\)$/m);
    expect(text).toMatch(/^\s+headroom 180d 0h\s+OK$/m);

    expect(text).toMatch(/^login-history\s+last run 2026-03-03 17:00Z\s+9,881 records$/m);
    expect(text).toMatch(/^\s+pending  2026-03-03 17:00Z → 2026-08-15 09:00Z\s+\(165d not yet collected\)$/m);
    expect(text).toMatch(/^\s+headroom 15d 8h\s+AT RISK$/m);
    expect(text).toMatch(/^\s+→ the 2026-03-03 window is destroyed on 2026-08-30\. Collect now\.$/m);
    // R5: the trailing interval is never printed as a gap.
    expect(text).not.toMatch(/GAP/);

    expect(text).toMatch(/^limits\s+last run 2026-08-15 09:00:12\.482Z\s+184 samples$/m);
    expect(text).toMatch(/^\s+samples  184   newest 2026-08-15 09:00:12\.482Z\s+\(snapshot source; no backfill possible\)$/m);
    // A snapshot has samples, not a covered range.
    expect(text.split('limits')[1]).not.toMatch(/coverage/);
    expect(text).toMatch(/^\s+headroom n\/a\s+OK$/m);

    // Exactly one destroyed-on line: only login-history is at risk.
    expect(lines.filter((l) => l.includes('destroyed on'))).toHaveLength(1);
  });

  it('renders a hole between two covered intervals as a GAP with its days', () => {
    const text = formatStatus([
      row(
        summary('audit-trail', '2026-08-15T09:00:00.000Z', 10, [
          { from: '2026-02-16T09:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
          { from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
        ]),
        EVENT,
      ),
    ]).join('\n');

    expect(text).toMatch(/^\s+coverage 2026-02-16 09:00Z → 2026-06-01$/m);
    expect(text).toMatch(/^\s+GAP      2026-06-01 → 2026-07-01\s+\(30d\)$/m);
    expect(text).toMatch(/^\s+coverage 2026-07-01 → 2026-08-15 09:00Z$/m);
    // The window is not complete, and the line saying so must not appear.
    expect(text).not.toMatch(/complete/);
    // Destroyed 2026-11-28: 104d 15h of headroom, well outside the 18-day threshold.
    expect(text).toMatch(/^\s+headroom 104d 15h\s+OK$/m);
    expect(text).not.toMatch(/destroyed on/);
  });

  it('renders the line order coverage, GAP, coverage so the hole sits where it is', () => {
    const lines = formatStatus([
      row(
        summary('audit-trail', '2026-08-15T09:00:00.000Z', 10, [
          { from: '2026-02-16T09:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
          { from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' },
        ]),
        EVENT,
      ),
    ]);
    const labels = lines.map((l) => l.trim().split(/\s+/)[0]).filter((l) => l === 'coverage' || l === 'GAP');
    expect(labels).toEqual(['coverage', 'GAP', 'coverage']);
  });

  it('reports intervals Salesforce has already destroyed as lost', () => {
    // Collection stopped 2026-01-01; everything from then to the retention start is gone.
    const now = new Date('2026-08-15T09:00:00.000Z');
    const text = formatStatus([
      row(
        summary('audit-trail', '2026-01-01T00:00:00.000Z', 3, [
          { from: '2025-12-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
        ]),
        EVENT,
        now,
      ),
    ]).join('\n');

    expect(text).toMatch(/^\s+lost     2026-01-01 → 2026-02-16 09:00Z\s+\(destroyed by Salesforce; not recoverable\)$/m);
  });

  it('says plainly that nothing has been collected, not a tidy pending line', () => {
    const text = formatStatus([
      row(
        {
          ...summary('audit-trail', '2026-08-15T09:00:00.000Z', 0, []),
          statuses: { complete: 0, partial: 0, degraded: 1, failed: 0 },
        },
        EVENT,
      ),
    ]).join('\n');

    expect(text).toMatch(/coverage NONE: nothing collected yet/);
    expect(text).not.toMatch(/pending/);
    expect(text).toMatch(/AT RISK/);
  });

  it('distinguishes coverage outside the evaluated window from nothing collected', () => {
    const text = formatStatus([
      row(
        summary('audit-trail', '2025-06-01T00:00:00.000Z', 5, [
          { from: '2025-05-01T00:00:00.000Z', to: '2025-06-01T00:00:00.000Z' },
        ]),
        EVENT,
      ),
    ]).join('\n');

    expect(text).toMatch(/coverage NONE inside the evaluated window/);
    expect(text).not.toMatch(/nothing collected yet/);
  });

  it('renders newest from the last stored sample, not the last run', () => {
    const s = { ...summary('limits', '2026-08-15T08:00:00.000Z', 3, []), lastWritten: '2026-08-14T06:00:00.000Z' };
    const text = formatStatus([row(s, SNAPSHOT)]).join('\n');
    expect(text).toMatch(/newest 2026-08-14 06:00Z/);
    expect(text).not.toMatch(/newest 2026-08-15/);
  });

  it('marks a snapshot source with no recent sample STALE', () => {
    const text = formatStatus([
      row(
        summary('limits', '2026-08-14T06:00:00.000Z', 20, [
          { from: '2026-08-13T00:00:00.000Z', to: '2026-08-14T07:00:00.000Z' },
        ]),
        SNAPSHOT,
      ),
    ]).join('\n');

    expect(text).toMatch(/^\s+headroom n\/a\s+STALE$/m);
  });

  it('lists a source with no registered collector, and says it was not assessed', () => {
    const text = formatStatus([
      {
        ...summary('login-history', '2026-03-03T17:00:00.000Z', 9881, [
          { from: '2026-02-16T00:00:00.000Z', to: '2026-03-03T17:00:00.000Z' },
        ]),
        kind: null,
        retentionDays: null,
        gaps: null,
        pending: null,
        lost: null,
        headroomSeconds: null,
        destroyedAfter: null,
        atRisk: null,
        stale: null,
      },
    ]).join('\n');

    expect(text).toMatch(/^login-history/m);
    expect(text).toMatch(/coverage 2026-02-16 → 2026-03-03 17:00Z/);
    expect(text).toMatch(/not assessed: no collector for this source in this release/);
    expect(text).not.toMatch(/^\s+headroom/m);
    expect(text).not.toMatch(/OK/);
  });

  it('calls a window longer than retention complete only when it is covered back to the window start', () => {
    const now = NOW;
    const input = (from: string) =>
      ({ coverage: [{ from, to: now.toISOString() }], lastSuccess: now.toISOString(), ...EVENT }) as CoverageInput;
    const render = (from: string) => {
      const s = summary('audit-trail', now.toISOString(), 1, [{ from, to: now.toISOString() }]);
      const a = assessCoverage(input(from), now, { windowDays: 365 });
      return formatStatus([{ ...s, ...a, ...EVENT } as StatusRow], { windowDays: 365 }).join('\n');
    };
    expect(render('2025-08-01T00:00:00.000Z')).toMatch(/\(365d window: complete\)/);
    // Covered only from retention start: the older part of the window is lost, not complete.
    const partial = render('2026-02-16T09:00:00.000Z');
    expect(partial).not.toMatch(/complete/);
    expect(partial).toMatch(/lost\s+2025-08-15 09:00Z → 2026-02-16 09:00Z/);
  });

  it('says the archive is empty when there is nothing to summarise', () => {
    const text = formatStatus([]).join('\n');
    expect(text).toMatch(/no data archived/i);
    expect(text).not.toMatch(/not implemented/i);
  });

  it('names the org and archive it found nothing for', () => {
    const text = formatStatus([], { orgId: '00D000000000001AAA', archive: '/srv/archive' }).join('\n');
    expect(text).toMatch(/no data archived for 00D000000000001AAA in \/srv\/archive/i);
  });
});
