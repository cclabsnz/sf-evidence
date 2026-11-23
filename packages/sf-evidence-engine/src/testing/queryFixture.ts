import { writeFile } from 'node:fs/promises';
import { buildBatch } from '../chain/manifestBuilder.js';
import { buildMetadataFiles } from '../archive/metadata.js';
import { LocalSink } from '../sinks/local.js';
import { absoluteRecordPath } from '../sinks/layout.js';
import { GENESIS_PREV } from '../types/manifest.js';
import { canonicalBytes } from '../chain/canonical.js';
import { normaliseLoginHistoryRow } from '../collectors/normalise.js';
import { loginHistoryFields } from '../collectors/loginHistory.js';
import type { NormalisedRecord } from '../types/record.js';

/**
 * A small archive with known contents, for the DuckDB view and command tests in
 * `@cclabsnz/sf-evidence-query`. Tests assert against these names, never against literals, so a
 * change to the fixture is one edit here.
 *
 * The audit-trail rows are chosen to hit the awkward cases: a null `DelegateUser`, a populated
 * one, an event just before midnight UTC (a local-timezone day boundary), and a row with no
 * actor name, section or username at all. The limits sample covers a normal limit, a limit
 * that is nearly full, a zero cap, a limit the org gave no `Remaining` for (so no `Used`), and
 * a nested limit.
 */
export const FIXTURE = {
  orgA: '00D5j000000AbCdEAK',
  orgB: '00D000000000002AAA',
  orgNames: { A: 'Fixture Prod', B: 'Fixture UAT' },
  ids: {
    a1: '0YmA00000000001AAA',
    a2: '0YmA00000000002AAA',
    a3: '0YmA00000000003AAA',
    b1: '0YmB00000000001AAA',
    orphan: '0YmA0000000000XAAA',
  },
  /** Archive-relative path of the one file no manifest references, in org A. */
  orphanRelPath: 'org_id=00D5j000000AbCdEAK/source=audit-trail/year=2026/month=08/part-orphan.ndjson',
  /**
   * Org A's login attempts, all in October 2026 (so August-based counts are unchanged): a
   * success, two failures by one user from NZ, and a failure with no country or forwarded IP.
   * `statusCounts` is `SELECT status, count(*) ... GROUP BY ALL ORDER BY 1`.
   */
  login: {
    ids: {
      ok: '0YaA00000000001AAA',
      bad1: '0YaA00000000002AAA',
      bad2: '0YaA00000000003AAA',
      noCountry: '0YaA00000000004AAA',
    },
    statusCounts: [
      ['Failed: Computer Activation Required', 1],
      ['Invalid Password', 2],
      ['Success', 1],
    ],
  },
  limits: {
    occurredAt: '2026-11-17T08:00:00.000Z',
    sampledAt: '2026-11-17T08:00:12.482Z',
    DailyApiRequests: { Max: 15000, Remaining: 14998, Used: 2 },
    DataStorageMB: { Max: 5, Remaining: 1, Used: 4 },
    ZeroCap: { Max: 0, Remaining: 0, Used: 0 },
    NoRemaining: { Max: 10, Remaining: null },
    PermissionSets: {
      Max: 1500,
      Remaining: 1499,
      Used: 1,
      CreateCustom: { Max: 1000, Remaining: 999 },
    },
  },
} as const;

const API_VERSION = '64.0';
const COLLECTED_AT = '2026-11-17T09:00:00.000Z';

interface Row {
  orgId: string;
  id: string;
  at: string;
  action: string;
  by: string;
  name: string | null;
  username: string | null;
  delegate: string | null;
  section: string | null;
  display: string;
}

function auditRecord(r: Row): NormalisedRecord {
  return {
    schema: 'sf-evidence/audit-trail/v1',
    org_id: r.orgId,
    source: 'audit-trail',
    source_id: r.id,
    occurred_at: r.at,
    collected_at: COLLECTED_AT,
    api_version: API_VERSION,
    payload: {
      Action: r.action,
      CreatedByContext: null,
      CreatedById: r.by,
      CreatedByIssuer: null,
      CreatedByName: r.name,
      CreatedByUsername: r.username,
      CreatedDate: r.at,
      DelegateUser: r.delegate,
      Display: r.display,
      Id: r.id,
      Section: r.section,
    },
  };
}

const ROWS: Row[] = [
  {
    orgId: FIXTURE.orgA, id: FIXTURE.ids.a1, at: '2026-08-14T02:11:09.000Z', action: 'PermSetAssign',
    by: '005A00000000001AAA', name: 'Ada Admin', username: 'admin@fixture.example', delegate: null,
    section: 'Manage Users', display: 'Assigned permission set Fixture Admin to user jane@fixture.example',
  },
  {
    orgId: FIXTURE.orgA, id: FIXTURE.ids.a2, at: '2026-08-20T23:30:00.000Z', action: 'changedprofileforuser',
    by: '005A00000000002AAA', name: 'Jane Doe', username: 'jane@fixture.example', delegate: 'admin@fixture.example',
    section: 'Manage Users', display: 'Changed profile for user jane@fixture.example from Standard User to Fixture Admin',
  },
  {
    orgId: FIXTURE.orgA, id: FIXTURE.ids.a3, at: '2026-09-01T05:59:29.000Z', action: 'value_MAX_STREAMING_TOPICS_PROV',
    by: '005A00000000003AAA', name: null, username: null, delegate: null,
    section: null, display: 'Changed value MAX_STREAMING_TOPICS_PROV from 20 to 40',
  },
  {
    orgId: FIXTURE.orgB, id: FIXTURE.ids.b1, at: '2026-08-15T00:00:00.000Z', action: 'PermSetAssign',
    by: '005B00000000001AAA', name: 'Ops User', username: 'ops@fixture.example', delegate: null,
    section: 'Manage Users', display: 'Assigned permission set Fixture Ops to user ops@fixture.example',
  },
];

const ORPHAN = auditRecord({
  orgId: FIXTURE.orgA, id: FIXTURE.ids.orphan, at: '2026-08-16T00:00:00.000Z', action: 'PermSetAssign',
  by: '005A00000000001AAA', name: 'Ada Admin', username: 'admin@fixture.example', delegate: null,
  section: 'Manage Users', display: 'Assigned permission set Fixture Admin to user orphan@fixture.example',
});

function limitsRecord(): NormalisedRecord {
  const { occurredAt, sampledAt, ...limits } = FIXTURE.limits;
  return {
    schema: 'sf-evidence/limits/v1',
    org_id: FIXTURE.orgA,
    source: 'limits',
    source_id: `limits:${FIXTURE.orgA}:${occurredAt.slice(0, 13)}`,
    occurred_at: occurredAt,
    collected_at: COLLECTED_AT,
    api_version: API_VERSION,
    payload: { sampled_at: sampledAt, limits: JSON.parse(JSON.stringify(limits)) as unknown },
  };
}

interface LoginRow {
  id: string;
  at: string;
  user: string;
  status: string;
  ip: string;
  country: string | null;
  forwarded: string | null;
}

const LOGINS: LoginRow[] = [
  { id: FIXTURE.login.ids.ok, at: '2026-10-05T01:15:00.000Z', user: '005A00000000001AAA', status: 'Success', ip: '192.0.2.10', country: 'NZ', forwarded: '198.51.100.7' },
  { id: FIXTURE.login.ids.bad1, at: '2026-10-05T03:00:00.000Z', user: '005A00000000002AAA', status: 'Invalid Password', ip: '192.0.2.20', country: 'NZ', forwarded: null },
  { id: FIXTURE.login.ids.bad2, at: '2026-10-07T21:30:00.000Z', user: '005A00000000002AAA', status: 'Invalid Password', ip: '192.0.2.21', country: 'NZ', forwarded: null },
  { id: FIXTURE.login.ids.noCountry, at: '2026-10-09T10:00:00.000Z', user: '005A00000000003AAA', status: 'Failed: Computer Activation Required', ip: '203.0.113.9', country: null, forwarded: null },
];

function loginRecord(r: LoginRow): NormalisedRecord {
  return normaliseLoginHistoryRow(
    {
      Id: r.id, LoginTime: r.at, UserId: r.user, Status: r.status, LoginType: 'Application',
      LoginSubType: 'Other Apex API', Application: 'Fixture App', Browser: 'Unknown', Platform: 'Unknown',
      SourceIp: r.ip, CountryIso: r.country, LoginUrl: 'fixture.my.salesforce.com', ApiType: 'SOAP Enterprise',
      ApiVersion: '64.0', TlsProtocol: 'TLS 1.3', ForwardedForIp: r.forwarded,
    },
    { orgId: FIXTURE.orgA, collectedAt: COLLECTED_AT, apiVersion: API_VERSION },
    loginHistoryFields('67.0'),
  );
}

const WINDOW = { from: '2026-02-16T00:00:00.000Z', to: COLLECTED_AT };

/**
 * Write the fixture into `root`, which must already exist (sinks never create roots). Each org
 * gets a one-link chain written through `LocalSink.putBatch`, with `archive.json` and `org.json`
 * built by `buildMetadataFiles` so they are what `collect` would write. Org A then gets one
 * unreferenced record file, an orphan, written behind the sink's back.
 */
export async function writeQueryFixture(root: string): Promise<{ orgIds: [string, string] }> {
  const sink = new LocalSink(root);
  await sink.init();

  const orgs = [
    { id: FIXTURE.orgA, name: FIXTURE.orgNames.A, isSandbox: false, edition: 'Enterprise Edition', instance: 'AP99', first: true },
    { id: FIXTURE.orgB, name: FIXTURE.orgNames.B, isSandbox: true, edition: 'Developer Edition', instance: 'AP98', first: false },
  ];

  for (const [i, org] of orgs.entries()) {
    const audit = ROWS.filter((r) => r.orgId === org.id).map(auditRecord);
    const outcomes = [
      { source: 'audit-trail' as const, status: 'complete' as const, window: WINDOW, achieved: [WINDOW], records: audit },
      ...(org.first
        ? [{
            source: 'limits' as const,
            status: 'complete' as const,
            window: { from: FIXTURE.limits.occurredAt, to: '2026-11-17T09:00:00.000Z' },
            achieved: [{ from: FIXTURE.limits.occurredAt, to: '2026-11-17T09:00:00.000Z' }],
            records: [limitsRecord()],
          }]
        : []),
      ...(org.first
        ? [{ source: 'login-history' as const, status: 'complete' as const, window: WINDOW, achieved: [WINDOW], records: LOGINS.map(loginRecord) }]
        : []),
    ];
    // Both orgs share one archive.json; only the first batch writes it (it is absent until then).
    const metadata = buildMetadataFiles({
      orgInfo: { id: org.id, name: org.name, edition: org.edition, instance: org.instance, isSandbox: org.isSandbox },
      apiVersion: API_VERSION,
      producer: { name: '@cclabsnz/sf-evidence', version: '0.1.0' },
      existing: { archive: i === 0 ? null : 'present', org: null },
      now: COLLECTED_AT,
    });
    const batch = buildBatch({
      orgId: org.id,
      runId: `01K3QF8H2N00000000000000A${i}`,
      createdAt: COLLECTED_AT,
      collectedAt: COLLECTED_AT,
      prevManifestHash: GENESIS_PREV,
      seq: 1,
      outcomes,
      degradations: [],
      metadata,
    });
    await sink.putBatch(batch);
  }

  // Same directory as org A's August file, but named by no manifest.
  await writeFile(
    absoluteRecordPath(root, FIXTURE.orphanRelPath),
    Buffer.concat([canonicalBytes(ORPHAN), Buffer.from('\n', 'utf8')]),
  );

  return { orgIds: [FIXTURE.orgA, FIXTURE.orgB] };
}
