import type { SoqlClient } from '@cclabsnz/sf-core';

/** The API version this plugin negotiates. Bumped deliberately, never floated. */
export const API_VERSION = '67.0';

/**
 * The one query this plugin issues that no collector owns: it resolves the archive's
 * top-level partition key before any collector runs.
 *
 * Exported as a constant, and issued through the same `SoqlClient` every collector uses,
 * because `explain` promises a security reviewer an exhaustive list of queries. It used to
 * go direct to the raw `Connection`, which meant a reviewer who audited with `explain` and
 * then watched the org's API log saw a query the tool had not disclosed — and made the
 * assertion that collectors reach the org only through the clients built in wire.ts false of
 * wire.ts itself.
 */
export const ORG_ID_QUERY = {
  object: 'Organization',
  soql: 'SELECT Id FROM Organization LIMIT 1',
  permission: 'API Enabled (every user can read their own Organization record)',
  scope: 'plugin',
} as const;

/** The 18-character org id, which is the archive's top-level partition key. */
export async function resolveOrgId(soql: SoqlClient): Promise<string> {
  const result = await soql.query<{ Id: string }>(ORG_ID_QUERY.soql);
  const id = result.records[0]?.Id;
  if (!id) throw new Error('Could not retrieve the Organization record to determine the org id.');
  return id;
}

/**
 * The second query the plugin issues that no collector owns: it reads the org's name,
 * edition, instance and sandbox flag for `org.json` (SPEC.md §5.3). Listed by `explain` for
 * the same reason `ORG_ID_QUERY` is.
 */
export const ORG_INFO_QUERY = {
  object: 'Organization',
  soql: 'SELECT Id, Name, OrganizationType, InstanceName, IsSandbox FROM Organization LIMIT 1',
  permission: 'API Enabled (every user can read their own Organization record)',
  scope: 'plugin',
} as const;

/**
 * The org's clock, read from the response `Date` header of one `GET /services/data/`. `collect`
 * issues it on every run to end its windows at the earlier of the local and org clocks
 * (SPEC.md §10.8); `doctor` issues it only when `--target-org` is passed, to report skew.
 */
export const ORG_CLOCK_QUERY = {
  object: 'API version list',
  soql: 'GET /services/data/',
  permission: 'a valid sf CLI session (the response Date header is all that is read)',
  scope: 'plugin',
  note:
    'Issued by collect on every run, to end collection windows at the earlier of the local and ' +
    'org clocks, and by doctor only when --target-org is passed, to report clock skew.',
} as const;

/**
 * The API budget read `collect` makes before an event source collects a long span (SPEC.md
 * §10.3). Not owned by a collector: it is the guard in runCollect, issued whatever the
 * `limits` source is doing.
 */
export const API_BUDGET_QUERY = {
  object: 'limits (API budget check)',
  soql: `GET /services/data/v${API_VERSION}/limits/`,
  permission: 'View Setup and Configuration',
  scope: 'plugin',
  note:
    'Issued by collect, once per event source, when the windows the budget guard covers span ' +
    'more than 7 days: the whole plan on a first run, --since or --backfill, otherwise only the ' +
    'gap repair. Reads DailyApiRequests.Remaining and, below the floor, refuses those windows; ' +
    'the routine incremental window still runs.',
} as const;

export interface OrgInfo {
  id: string;
  name: string;
  /** Salesforce `OrganizationType`, e.g. "Enterprise Edition". */
  edition: string;
  instance: string;
  isSandbox: boolean;
}

interface OrganizationRow {
  Id: string;
  Name: string;
  OrganizationType: string;
  InstanceName: string;
  IsSandbox: boolean;
}

export async function resolveOrgInfo(soql: SoqlClient): Promise<OrgInfo> {
  const result = await soql.query<OrganizationRow>(ORG_INFO_QUERY.soql);
  const row = result.records[0];
  if (!row?.Id) throw new Error('Could not retrieve the Organization record to describe the org.');
  return {
    id: row.Id,
    name: row.Name,
    edition: row.OrganizationType,
    instance: row.InstanceName,
    isSandbox: row.IsSandbox,
  };
}
