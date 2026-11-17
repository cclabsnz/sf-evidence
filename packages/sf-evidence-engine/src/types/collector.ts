import type { RestClient, SoqlClient } from '@cclabsnz/sf-core';
import type { Degradation, SourceStatus, TimeWindow } from './manifest.js';
import type { NormalisedRecord, SourceId } from './record.js';

export interface CollectorContext {
  soql: SoqlClient;
  /** Absent when the host wired no REST client; a REST collector then degrades with `NO_REST_CLIENT`. */
  rest?: RestClient;
  orgId: string;
  apiVersion: string;
  collectedAt: string;
}

export interface CollectOptions {
  window: TimeWindow;
  /** Source ids already in the archive; excluded from the result (SPEC.md §10.1). */
  knownSourceIds?: ReadonlySet<string>;
}

export interface CollectionOutcome {
  source: SourceId;
  status: SourceStatus;
  window: TimeWindow;
  records: NormalisedRecord[];
  /** Sub-ranges of `window` that were actually collected, sorted and merged. */
  achieved: TimeWindow[];
  /** One entry per failed slice, each carrying that slice's `window`. */
  degradations: Degradation[];
  /** Rows returned by the org across all slices, before dedupe. */
  fetched: number;
  /** Rows discarded because their source_id was already archived or seen this run. */
  deduped: number;
}

/**
 * One query the plugin will issue, for `explain` (SPEC.md §8.5).
 *
 * `scope` distinguishes a query a collector owns from one the plugin itself issues before
 * any collector runs (resolving the org id). `explain` promises an exhaustive list; a
 * reviewer who watches the org's API log must find nothing there that this list omitted,
 * and must be able to tell which component to look at for each entry.
 */
export interface QueryDescription {
  object: string;
  /** The SOQL text, or for a REST read `GET <path>`. */
  soql: string;
  permission: string;
  /** Defaults to `collector` when absent. */
  scope?: 'collector' | 'plugin';
  /** When the plugin issues it, for a read that is not issued on every run. */
  note?: string;
}

/** Members every collector has, whatever its kind. */
interface CollectorBase {
  readonly source: SourceId;
  /** Static description of every read, computed without a connection. */
  describeQueries(): QueryDescription[];
  collect(ctx: CollectorContext, opts: CollectOptions): Promise<CollectionOutcome>;
}

/** A stream of timestamped events Salesforce retains for a bounded time, so a missed range is recoverable until it expires. */
export interface EventCollector extends CollectorBase {
  readonly kind: 'event';
  /** Source-side retention in days; the window beyond which data is destroyed. */
  readonly retentionDays: number;
}

/**
 * Current-state reads with no history behind them (SPEC.md §4.4): a sample not taken is lost
 * for good, so there is no retention window and no backfill. `retentionDays` is `null`,
 * and the discriminant is what lets the type system refuse a null retention on an event source.
 */
export interface SnapshotCollector extends CollectorBase {
  readonly kind: 'snapshot';
  readonly retentionDays: null;
}

export type Collector = EventCollector | SnapshotCollector;
