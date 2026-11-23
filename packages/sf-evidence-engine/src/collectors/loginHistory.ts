import { isApiError } from '@cclabsnz/sf-core';
import { normaliseLoginHistoryRow, type LoginHistoryRow } from './normalise.js';
import { collectSliced } from './slicing.js';
import { toSoqlDateTime } from '../lib/time.js';
import { API_VERSION } from '../salesforce.js';
import type { Degradation, TimeWindow } from '../types/manifest.js';
import type { NormalisedRecord, SourceId } from '../types/record.js';
import type {
  CollectOptions,
  EventCollector,
  CollectorContext,
  CollectionOutcome,
  QueryDescription,
} from '../types/collector.js';

/** Salesforce keeps LoginHistory for six months. */
const RETENTION_DAYS = 180;

const PERMISSION = 'Monitor Login History (MonitorLoginHistory) or Manage Users';

/** Fields every supported API version exposes, in the order they are selected. */
export const LOGIN_HISTORY_BASE_FIELDS = [
  'Id',
  'UserId',
  'LoginTime',
  'LoginType',
  'LoginSubType',
  'Status',
  'Application',
  'Browser',
  'Platform',
  'SourceIp',
  'CountryIso',
  'LoginGeoId',
  'LoginUrl',
  'NetworkId',
  'ApiType',
  'ApiVersion',
  'ClientVersion',
  'AuthenticationServiceId',
  'CipherSuite',
  'TlsProtocol',
  'OptionsIsGet',
  'OptionsIsPost',
] as const;

/** Fields that exist only from a given API version on. */
export const LOGIN_HISTORY_VERSIONED_FIELDS: ReadonlyArray<{ name: string; since: string }> = [
  { name: 'ForwardedForIp', since: '61.0' },
  { name: 'AuthMethodReference', since: '51.0' },
  { name: 'AuthContextClassRef', since: '67.0' },
];

const VERSIONED_NAMES = new Set(LOGIN_HISTORY_VERSIONED_FIELDS.map((f) => f.name));

/** The base fields plus every versioned field the given API version exposes. */
export function loginHistoryFields(apiVersion: string): string[] {
  const v = parseFloat(apiVersion);
  return [
    ...LOGIN_HISTORY_BASE_FIELDS,
    ...LOGIN_HISTORY_VERSIONED_FIELDS.filter((f) => parseFloat(f.since) <= v).map((f) => f.name),
  ];
}

function soqlFor(fields: readonly string[], window: TimeWindow): string {
  // Id breaks LoginTime ties, so a page boundary can never reorder rows with equal times.
  return (
    `SELECT ${fields.join(', ')} FROM LoginHistory ` +
    `WHERE LoginTime >= ${toSoqlDateTime(window.from)} ` +
    `AND LoginTime < ${toSoqlDateTime(window.to)} ` +
    'ORDER BY LoginTime ASC, Id ASC'
  );
}

/** The query with placeholders for the window, as for audit-trail. */
function soqlTemplate(fields: readonly string[]): string {
  return (
    `SELECT ${fields.join(', ')} FROM LoginHistory ` +
    'WHERE LoginTime >= <from> AND LoginTime < <to> ' +
    'ORDER BY LoginTime ASC, Id ASC'
  );
}

/** A fetched row and the field list it was queried with, which its payload must match. */
interface FetchedRow {
  row: LoginHistoryRow;
  fields: readonly string[];
}

export class LoginHistoryCollector implements EventCollector {
  public readonly source: SourceId = 'login-history';
  public readonly kind = 'event' as const;
  public readonly retentionDays = RETENTION_DAYS;

  public describeQueries(): QueryDescription[] {
    // Static, with no connection: describes the query at the API version this release uses.
    // A run against an org that rejects the versioned fields issues the same query without them.
    return [
      {
        object: 'LoginHistory',
        soql: soqlTemplate(loginHistoryFields(API_VERSION)),
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
      throw new Error(
        `Invalid window: from (${window.from}) is after to (${window.to}).`,
      );
    }

    let fields: readonly string[] = loginHistoryFields(ctx.apiVersion);
    let downgrade: Degradation | undefined;

    const query = async (slice: TimeWindow): Promise<FetchedRow[]> => {
      const used = fields;
      const rows = await ctx.soql.queryAll<LoginHistoryRow>(soqlFor(used, slice));
      return rows.map((row) => ({ row, fields: used }));
    };

    const fetchSlice = async (slice: TimeWindow): Promise<FetchedRow[]> => {
      try {
        return await query(slice);
      } catch (err) {
        // One downgrade per run, never more: a second INVALID_FIELD is not about the
        // versioned fields, so it falls through to collectSliced as an ordinary slice
        // degradation. The error message is not parsed for the field name.
        const dropped = fields.filter((f) => VERSIONED_NAMES.has(f));
        if (downgrade || !isApiError(err) || err.errorCode !== 'INVALID_FIELD' || dropped.length === 0) {
          throw err;
        }
        fields = fields.filter((f) => !VERSIONED_NAMES.has(f));
        downgrade = {
          source: this.source,
          code: 'INVALID_FIELD',
          detail: err.message,
          fieldsDropped: dropped,
          remediation:
            'The org rejected these LoginHistory fields although API v67.0 should ' +
            'expose them; records from this run omit them. Check the org\'s API version and ' +
            'field visibility for the running user.',
        };
        return await query(slice);
      }
    };

    const sliced = await collectSliced(window, fetchSlice, { source: this.source });
    // The downgrade applies to the whole run, so it carries no window, and it does not
    // touch status: every slice it covers was collected, only with fewer fields.
    const degradations = downgrade ? [downgrade, ...sliced.degradations] : sliced.degradations;

    if (sliced.achieved.length === 0 && sliced.degradations.length === 0) {
      // window.from === window.to: an empty interval, `complete` by explicit decision (C7).
      return {
        source: this.source,
        status: 'complete',
        window,
        achieved: [],
        records: [],
        degradations,
        fetched: 0,
        deduped: 0,
      };
    }

    const seen = new Set<string>(opts.knownSourceIds ?? []);
    const records: NormalisedRecord[] = [];
    let fetched = 0;
    let deduped = 0;

    for (const { row, fields: rowFields } of sliced.rows) {
      fetched += 1;
      if (!row.Id) {
        // Fatal for the same reason as on audit-trail: a skipped row would leave
        // recordsFetched greater than recordsWritten + recordsDeduped with no trace.
        throw new Error(
          'LoginHistory row is missing Id; it cannot be deduplicated. ' +
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
        normaliseLoginHistoryRow(
          row,
          { orgId: ctx.orgId, apiVersion: ctx.apiVersion, collectedAt: ctx.collectedAt },
          rowFields,
        ),
      );
    }

    // C7: `complete` only when every slice succeeded; a wholly failed window is `degraded`,
    // never `complete` with zero records.
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
      degradations,
      fetched,
      deduped,
    };
  }
}
