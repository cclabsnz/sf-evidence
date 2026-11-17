import { classifyDegradation } from '../lib/errors.js';
import { hourWindow } from '../lib/time.js';
import type { Degradation } from '../types/manifest.js';
import type { NormalisedRecord, SourceId } from '../types/record.js';
import type {
  CollectionOutcome,
  CollectOptions,
  CollectorContext,
  QueryDescription,
  SnapshotCollector,
} from '../types/collector.js';
import { API_VERSION } from '../salesforce.js';
import { isRecord, LIMITS_PATH, readLimitsBody } from '../lib/limits.js';

const PATH = LIMITS_PATH;

/**
 * Each limit exactly as the org returned it. `Used` is added (SPEC.md §4.4) only where it can
 * be computed: `Max` and `Remaining` both numbers. Anything else is kept verbatim and nothing
 * is derived for it, so the archive never states a usage figure the org did not support.
 */
function withUsed(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { Max, Remaining } = value;
  if (typeof Max !== 'number' || typeof Remaining !== 'number') return value;
  return { ...value, Used: Max - Remaining };
}

/**
 * Org limits: a snapshot source (SPEC.md §4.4). `GET /limits/` returns only current values, so
 * each run emits one sample bucketed to the UTC hour of `collectedAt`. A second run in the
 * same hour produces the same `source_id` and dedupes.
 */
export class LimitsCollector implements SnapshotCollector {
  public readonly source: SourceId = 'limits';
  public readonly kind = 'snapshot' as const;
  public readonly retentionDays = null;

  public describeQueries(): QueryDescription[] {
    return [
      {
        object: 'limits',
        soql: `GET /services/data/v${API_VERSION}${PATH}`,
        permission: 'View Setup and Configuration',
      },
    ];
  }

  public async collect(ctx: CollectorContext, opts: CollectOptions): Promise<CollectionOutcome> {
    // The bucket comes from `collectedAt`, not from the requested window: a sample is of the
    // moment it was taken, and cannot claim to cover any other hour.
    const hour = hourWindow(ctx.collectedAt);
    const failed = (d: Degradation): CollectionOutcome => ({
      source: this.source,
      status: 'failed',
      window: hour,
      achieved: [],
      records: [],
      degradations: [d],
      fetched: 0,
      deduped: 0,
    });

    if (!ctx.rest) {
      return failed({
        source: this.source,
        code: 'NO_REST_CLIENT',
        detail: 'No REST client was provided, so GET /limits/ was not issued and no sample was taken.',
        remediation: 'Run collect through the sf plugin, which wires a REST client for snapshot sources.',
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readLimitsBody(ctx.rest);
    } catch (err) {
      // An unrecognised failure must fail the run, not be recorded as reduced coverage (C6).
      const d = classifyDegradation(err, this.source);
      if (!d) throw err;
      return failed(d);
    }

    const limits: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(body)) limits[name] = withUsed(value);

    const record: NormalisedRecord = {
      schema: 'sf-evidence/limits/v1',
      org_id: ctx.orgId,
      source: this.source,
      source_id: `limits:${ctx.orgId}:${hour.from.slice(0, 13)}`,
      occurred_at: hour.from,
      collected_at: ctx.collectedAt,
      api_version: ctx.apiVersion,
      payload: { sampled_at: ctx.collectedAt, limits },
    };

    const duplicate = (opts.knownSourceIds ?? new Set<string>()).has(record.source_id);
    return {
      source: this.source,
      status: 'complete',
      window: hour,
      achieved: [hour],
      records: duplicate ? [] : [record],
      degradations: [],
      fetched: 1,
      deduped: duplicate ? 1 : 0,
    };
  }
}
