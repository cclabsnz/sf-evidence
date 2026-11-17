import type { Connection } from '@salesforce/core';
import { RestClientImpl, SoqlClientImpl } from '@cclabsnz/sf-core';
import type { RestClient, SoqlClient } from '@cclabsnz/sf-core';

/**
 * Builds the org clients from the sf CLI's Connection. The only part of org access that needs
 * @salesforce/core; the API version and org-id query live in the engine package, where hosts
 * that never load the sf CLI can use them too.
 */
export function buildClients(conn: Connection): { soql: SoqlClient; rest: RestClient } {
  return { soql: new SoqlClientImpl(conn), rest: new RestClientImpl(conn) };
}
