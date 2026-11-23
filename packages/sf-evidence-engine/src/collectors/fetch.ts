import type { SoqlClient } from '@cclabsnz/sf-core';

/**
 * A `SoqlClient` that can also say how many rows a fetch-everything query matched.
 *
 * sf-core's `queryAll` returns the rows only. Under the sf CLI it is `autoFetchQuery`, which
 * stops at a maxFetch (10,000 by default, or the `maxQueryLimit` config value) and discards
 * `totalSize`, so a truncated result looks exactly like a complete one. A host that can read
 * `totalSize` implements this; the sf CLI wiring does.
 */
export interface CountedSoqlClient extends SoqlClient {
  queryAllCounted<T>(soql: string): Promise<{ records: T[]; totalSize: number }>;
}

const isCounted = (soql: SoqlClient): soql is CountedSoqlClient =>
  typeof (soql as Partial<CountedSoqlClient>).queryAllCounted === 'function';

/**
 * Thrown when a query returned fewer rows than it matched. It carries an `errorCode` so
 * `collectSliced` treats it like a timeout: split the slice and try again, and at the floor
 * record a `QUERY_TRUNCATED` degradation. The rows it did return are discarded.
 */
export class QueryTruncatedError extends Error {
  public readonly errorCode = 'QUERY_TRUNCATED';

  public constructor(
    public readonly fetched: number,
    public readonly totalSize: number,
  ) {
    super(`The query matched ${totalSize} rows but returned ${fetched}: more than one query could fetch.`);
    this.name = 'QUERY_TRUNCATED';
  }
}

/**
 * Every row a query matches, or a `QueryTruncatedError`. Never a silently short result: a
 * slice recorded as collected must hold every row the org has for it.
 *
 * With a `CountedSoqlClient` this is one fetch. With a plain `SoqlClient` there is nothing
 * to read `totalSize` from, so a non-empty result is checked with one `query` for the same
 * SOQL (its first page also reports `totalSize`). That costs one more request per non-empty
 * slice, which is the price of not assuming the result was complete.
 */
export async function queryAllComplete<T>(soql: SoqlClient, q: string): Promise<T[]> {
  if (isCounted(soql)) {
    const { records, totalSize } = await soql.queryAllCounted<T>(q);
    if (records.length < totalSize) throw new QueryTruncatedError(records.length, totalSize);
    return records;
  }
  const records = await soql.queryAll<T>(q);
  // An empty result cannot have been cut short: truncation keeps the first maxFetch rows.
  if (records.length === 0) return records;
  const { totalSize } = await soql.query<T>(q);
  if (records.length < totalSize) throw new QueryTruncatedError(records.length, totalSize);
  return records;
}
