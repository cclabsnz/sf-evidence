import type { Connection } from '@salesforce/core';
import { RestClientImpl, SoqlClientImpl } from '@cclabsnz/sf-core';
import type { RestClient, SoqlClient } from '@cclabsnz/sf-core';
import type { CountedSoqlClient } from '@cclabsnz/sf-evidence-engine';

/**
 * The most rows one fetch-everything query returns. Above @salesforce/core's 10,000 default so
 * a busy time slice is split less often; an sf `maxQueryLimit` config value still overrides it.
 * It is an optimisation only: the engine compares the rows against `totalSize` and splits any
 * slice that came back short, whatever the limit was.
 */
export const MAX_FETCH = 50_000;

/** sf-core's SOQL client, plus the `totalSize` its `queryAll` drops. */
class CountingSoqlClient extends SoqlClientImpl implements CountedSoqlClient {
  public constructor(private readonly conn: Connection) {
    super(conn);
  }

  public async queryAllCounted<T>(soql: string): Promise<{ records: T[]; totalSize: number }> {
    const result = await this.conn.autoFetchQuery(soql, { maxFetch: MAX_FETCH });
    return { records: (result.records ?? []) as T[], totalSize: result.totalSize };
  }
}

/**
 * Builds the org clients from the sf CLI's Connection. The only part of org access that needs
 * @salesforce/core; the API version and org-id query live in the engine package, where hosts
 * that never load the sf CLI can use them too.
 */
export function buildClients(conn: Connection): { soql: SoqlClient; rest: RestClient } {
  return { soql: new CountingSoqlClient(conn), rest: new RestClientImpl(conn) };
}
