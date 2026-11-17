import { AUDIT_TRAIL_FIELDS, normaliseAuditTrailRow, type AuditTrailRow } from './normalise.js';
import { collectSliced } from './slicing.js';
import { toSoqlDateTime } from '../lib/time.js';
import type { TimeWindow } from '../types/manifest.js';
import type { NormalisedRecord, SourceId } from '../types/record.js';
import type {
  CollectOptions,
  EventCollector,
  CollectorContext,
  CollectionOutcome,
  QueryDescription,
} from '../types/collector.js';

/** Documented: "After 180 days, setup entity records are deleted." (SPEC.md §1.1) */
const RETENTION_DAYS = 180;

const PERMISSION = 'View Setup and Configuration';

function soqlFor(window: TimeWindow): string {
  // Only CreatedDate, Id, Action, CreatedById, DelegateUser and CreatedByContext are
  // filterable on this object. Section and Display are sort-only, so any filtering on them
  // happens in the archive, never here.
  // Bounds go through toSoqlDateTime: SOQL dateTime literals are unquoted and carry no
  // milliseconds, while every timestamp in the archive does.
  return (
    `SELECT ${AUDIT_TRAIL_FIELDS.join(', ')} FROM SetupAuditTrail ` +
    `WHERE CreatedDate >= ${toSoqlDateTime(window.from)} ` +
    `AND CreatedDate < ${toSoqlDateTime(window.to)} ` +
    'ORDER BY CreatedDate ASC'
  );
}

/**
 * The query with the window bounds as placeholders: `explain` has no collection window to
 * show, and a real-looking date would read as the one that will be queried.
 */
function soqlTemplate(): string {
  return (
    `SELECT ${AUDIT_TRAIL_FIELDS.join(', ')} FROM SetupAuditTrail ` +
    'WHERE CreatedDate >= <from> AND CreatedDate < <to> ' +
    'ORDER BY CreatedDate ASC'
  );
}

export class AuditTrailCollector implements EventCollector {
  public readonly source: SourceId = 'audit-trail';
  public readonly kind = 'event' as const;
  public readonly retentionDays = RETENTION_DAYS;

  public describeQueries(): QueryDescription[] {
    return [
      {
        object: 'SetupAuditTrail',
        soql: soqlTemplate(),
        permission: PERMISSION,
      },
    ];
  }

  public async collect(
    ctx: CollectorContext,
    opts: CollectOptions,
  ): Promise<CollectionOutcome> {
    const { window } = opts;
    if (window.from > window.to) {
      // A caller contract violation, not a coverage gap: fail loudly at the boundary rather
      // than let an inverted window fall through to a plausible-looking empty `complete`.
      throw new Error(
        `Invalid window: from (${window.from}) is after to (${window.to}).`,
      );
    }

    const seen = new Set<string>(opts.knownSourceIds ?? []);
    const records: NormalisedRecord[] = [];

    const sliced = await collectSliced(
      window,
      (slice) => ctx.soql.queryAll<AuditTrailRow>(soqlFor(slice)),
      { source: this.source },
    );

    if (sliced.achieved.length === 0 && sliced.degradations.length === 0) {
      // window.from === window.to: a genuinely empty interval. `complete` is the honest
      // answer here, but it must be reached as an explicit decision, not by falling through
      // a loop that never ran, which is indistinguishable from a caller bug (C7).
      return {
        source: this.source,
        status: 'complete',
        window,
        achieved: [],
        records: [],
        degradations: [],
        fetched: 0,
        deduped: 0,
      };
    }

    let fetched = 0;
    let deduped = 0;

    for (const row of sliced.rows) {
      fetched += 1;
      if (!row.Id) {
        // Deliberately fatal, and deliberately the same verdict `normaliseAuditTrailRow`
        // reaches for the same condition. Skipping the row silently counted it in
        // `fetched` but in neither `written` nor `deduped`, so the run reported
        // fetched !== written + deduped with nothing on the record explaining the
        // difference: a record that vanished with no trace, in an archive whose only
        // job is that records do not vanish without trace.
        throw new Error(
          'SetupAuditTrail row is missing Id; it cannot be deduplicated. ' +
            'Refusing to drop it silently: a dropped row would leave ' +
            'recordsFetched greater than recordsWritten + recordsDeduped with nothing ' +
            'in the archive to explain the gap.',
        );
      }
      if (seen.has(row.Id)) {
        deduped += 1;
        continue;
      }
      seen.add(row.Id);
      records.push(
        normaliseAuditTrailRow(row, {
          orgId: ctx.orgId,
          apiVersion: ctx.apiVersion,
          collectedAt: ctx.collectedAt,
        }),
      );
    }

    // C7: `complete` must be reached by positive decision, not by falling through an
    // initializer — the window is `complete` only when every slice succeeded. A window that
    // partly failed is `partial`, and one that wholly failed is `degraded`, never `complete`
    // with zero records, which would be indistinguishable from "nothing happened".
    let status: CollectionOutcome['status'];
    if (sliced.degradations.length === 0) {
      status = 'complete';
    } else if (sliced.achieved.length === 0) {
      status = 'degraded';
    } else {
      status = 'partial';
    }

    return {
      source: this.source,
      status,
      window,
      achieved: sliced.achieved,
      records,
      degradations: sliced.degradations,
      fetched,
      deduped,
    };
  }
}
