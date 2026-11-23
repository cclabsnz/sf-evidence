import type { SourceId } from '../types/record.js';

/**
 * The query views, as data (design §5.5). The compiler turns these into SQL, and
 * `docs/query-views.md` is generated from the same definitions, so the data dictionary cannot
 * drift from what a query actually returns.
 *
 * Expressions are per dialect strings, not a dialect-neutral language: two dialects do not
 * justify an expression language, and the AWS edition adds the `athena` strings alongside a
 * cross-engine fixture test. Only `duckdb` is filled now.
 */
export type Dialect = 'duckdb' | 'athena';

export type ViewColumnType =
  | 'VARCHAR'
  | 'BOOLEAN'
  | 'INTEGER'
  | 'BIGINT'
  | 'DOUBLE'
  | 'JSON'
  | 'TIMESTAMP'
  | 'TIMESTAMPTZ';

export interface ViewColumn {
  name: string;
  /** The type the compiler casts the expression to, so an empty view and a full one agree. */
  type: ViewColumnType;
  description: string;
  /**
   * The column's expression in each dialect. A DuckDB expression is evaluated over the
   * compiler's per-view stage relation (see `compileDuckdb.ts`), and may name a column declared
   * earlier in the same view (DuckDB resolves select-list aliases left to right).
   */
  expr: Partial<Record<Dialect, string>>;
}

export interface ViewDefinition {
  name: 'records' | 'setup_changes' | 'limit_samples' | 'login_history';
  version: 1;
  /** What one row is. */
  grain: string;
  description: string;
  /** The sources whose chain-covered record files the view reads. */
  sources: SourceId[];
  /** The column `--from` / `--to` bound and results are ordered by. */
  timeColumn: string;
  columns: ViewColumn[];
  /** What the view cannot tell you, stated in the dictionary rather than discovered by a user. */
  knownGaps: string[];
}

/** `payload->>'<field>'`: a payload field as VARCHAR; a JSON null or absent key is SQL NULL. */
function field(name: string): string {
  return `payload->>'${name}'`;
}

/**
 * A limit's numeric field as a BIGINT, or NULL unless the JSON value is an integer. Gated on
 * `json_type` because `TRY_CAST('1.5' AS BIGINT)` rounds to 2, which would state a figure the
 * org never returned.
 */
function limitInt(name: string): string {
  return `CASE WHEN json_type(limit_value, '$.${name}') IN ('BIGINT', 'UBIGINT') THEN TRY_CAST(limit_value->>'$.${name}' AS BIGINT) END`;
}

const ORG_ID: ViewColumn = {
  name: 'org_id',
  type: 'VARCHAR',
  description: '18-character Salesforce org id, from the archive partition the record file lives in.',
  expr: { duckdb: 'org_id' },
};

const ORG_LABEL: ViewColumn = {
  name: 'org_label',
  type: 'VARCHAR',
  description: "The org's name from org.json in the archive; NULL when org.json is missing or unreadable.",
  expr: { duckdb: 'org_label' },
};

const SOURCE_ID: ViewColumn = {
  name: 'source_id',
  type: 'VARCHAR',
  description: 'Dedupe key of the record: the Salesforce Id for event sources, the hour bucket for limits.',
  expr: { duckdb: 'source_id' },
};

const COLLECTED_AT_UTC: ViewColumn = {
  name: 'collected_at_utc',
  type: 'TIMESTAMP',
  description: 'When the collecting run started, UTC wall time. Local clock, advisory only.',
  expr: { duckdb: "timezone('UTC', collected_at)" },
};

const RECORDS: ViewDefinition = {
  name: 'records',
  version: 1,
  grain: 'One row per archived record, every source.',
  description:
    "Every chain-covered record with its envelope and the verbatim payload as JSON. The escape hatch for anything the other views don't flatten.",
  sources: ['audit-trail', 'login-history', 'limits'],
  timeColumn: 'occurred_at_utc',
  columns: [
    ORG_ID,
    ORG_LABEL,
    { name: 'source', type: 'VARCHAR', description: 'Source the record came from, e.g. audit-trail or limits.', expr: { duckdb: 'source' } },
    SOURCE_ID,
    { name: 'schema', type: 'VARCHAR', description: 'Record schema and version, e.g. sf-evidence/audit-trail/v1.', expr: { duckdb: 'schema' } },
    {
      name: 'occurred_at_utc',
      type: 'TIMESTAMP',
      description: "Salesforce's timestamp for the record (for limits, the UTC hour the sample belongs to), UTC wall time.",
      expr: { duckdb: "timezone('UTC', occurred_at)" },
    },
    COLLECTED_AT_UTC,
    { name: 'api_version', type: 'VARCHAR', description: 'Salesforce API version the record was collected with.', expr: { duckdb: 'api_version' } },
    { name: 'year', type: 'INTEGER', description: 'Archive partition year (UTC year of occurred_at).', expr: { duckdb: 'year' } },
    { name: 'month', type: 'INTEGER', description: 'Archive partition month, 1-12 (UTC month of occurred_at).', expr: { duckdb: 'month' } },
    {
      name: 'payload',
      type: 'JSON',
      description: 'The source payload exactly as archived, with verbatim Salesforce field names.',
      expr: { duckdb: 'payload' },
    },
  ],
  knownGaps: [],
};

const SETUP_CHANGES: ViewDefinition = {
  name: 'setup_changes',
  version: 1,
  grain: 'One row per Setup Audit Trail entry.',
  description:
    'Setup changes from the Setup Audit Trail, with Login-As attribution resolved: performed_by is who acted, recorded_as is who Salesforce recorded.',
  sources: ['audit-trail'],
  timeColumn: 'occurred_at_utc',
  columns: [
    {
      name: 'occurred_at_utc',
      type: 'TIMESTAMP',
      description: 'CreatedDate, UTC wall time.',
      expr: { duckdb: "timezone('UTC', occurred_at)" },
    },
    {
      name: 'occurred_at_local',
      type: 'TIMESTAMPTZ',
      description: 'CreatedDate as an instant, shown in the --timezone zone.',
      expr: { duckdb: 'occurred_at' },
    },
    { name: 'action', type: 'VARCHAR', description: 'Action, verbatim (e.g. PermSetAssign).', expr: { duckdb: field('Action') } },
    { name: 'section', type: 'VARCHAR', description: 'Section, verbatim (e.g. Manage Users).', expr: { duckdb: field('Section') } },
    { name: 'display', type: 'VARCHAR', description: 'Display, verbatim: Salesforce\'s description of the change.', expr: { duckdb: field('Display') } },
    {
      name: 'via_login_as',
      type: 'BOOLEAN',
      description: 'True when the change was made through Login-As (DelegateUser is set).',
      expr: { duckdb: `${field('DelegateUser')} IS NOT NULL` },
    },
    {
      name: 'performed_by',
      type: 'VARCHAR',
      description:
        'Username of who performed the change: DelegateUser when via Login-As, otherwise CreatedByUsername. NULL where Salesforce returned no username.',
      expr: {
        duckdb: `CASE WHEN ${field('DelegateUser')} IS NOT NULL THEN ${field('DelegateUser')} ELSE ${field('CreatedByUsername')} END`,
      },
    },
    {
      name: 'performed_by_id',
      type: 'VARCHAR',
      description:
        'User id of who performed the change: CreatedById when not via Login-As. NULL via Login-As, because CreatedById is then the impersonated user and DelegateUser is only a username.',
      // Never falls back to CreatedById: under Login-As that is the impersonated user, and
      // naming them as the actor inverts attribution (SPEC.md §1.2).
      expr: { duckdb: `CASE WHEN ${field('DelegateUser')} IS NULL THEN ${field('CreatedById')} END` },
    },
    {
      name: 'recorded_as',
      type: 'VARCHAR',
      description: 'CreatedByUsername: who Salesforce recorded (the impersonated user under Login-As). NULL where no username was returned.',
      expr: { duckdb: field('CreatedByUsername') },
    },
    { name: 'recorded_as_id', type: 'VARCHAR', description: 'CreatedById: the user id Salesforce recorded.', expr: { duckdb: field('CreatedById') } },
    { name: 'recorded_as_name', type: 'VARCHAR', description: "CreatedByName: the recorded user's full name.", expr: { duckdb: field('CreatedByName') } },
    { name: 'created_by_context', type: 'VARCHAR', description: 'CreatedByContext, verbatim.', expr: { duckdb: field('CreatedByContext') } },
    SOURCE_ID,
    ORG_ID,
    ORG_LABEL,
    COLLECTED_AT_UTC,
  ],
  knownGaps: [
    'performed_by and recorded_as are NULL wherever Salesforce returned no username (about 12% of entries in a typical dev org).',
    'performed_by_id is NULL for changes made via Login-As: DelegateUser is a username, and resolving it to a user id needs user snapshots, which are not collected yet.',
  ],
};

const LIMIT_SAMPLES: ViewDefinition = {
  name: 'limit_samples',
  version: 1,
  grain: 'One row per top-level limit per sample (long form).',
  description: 'Org limit samples from GET /limits/, one row per limit, with usage and percentage used.',
  sources: ['limits'],
  timeColumn: 'sampled_at_utc',
  columns: [
    {
      name: 'sampled_at_utc',
      type: 'TIMESTAMP',
      description: 'When the sample was taken (payload sampled_at, exact), UTC wall time.',
      expr: { duckdb: `timezone('UTC', CAST(${field('sampled_at')} AS TIMESTAMPTZ))` },
    },
    {
      name: 'sampled_at_local',
      type: 'TIMESTAMPTZ',
      description: 'When the sample was taken, as an instant shown in the --timezone zone.',
      expr: { duckdb: `CAST(${field('sampled_at')} AS TIMESTAMPTZ)` },
    },
    {
      name: 'hour_utc',
      type: 'TIMESTAMP',
      description: 'The UTC hour bucket the sample belongs to (occurred_at, the dedupe key), UTC wall time.',
      expr: { duckdb: "timezone('UTC', occurred_at)" },
    },
    { name: 'limit_name', type: 'VARCHAR', description: 'The limit, a top-level key of the /limits/ response (e.g. DailyApiRequests).', expr: { duckdb: 'limit_name' } },
    { name: 'max', type: 'BIGINT', description: 'Max as returned. NULL when absent or not an integer.', expr: { duckdb: limitInt('Max') } },
    { name: 'remaining', type: 'BIGINT', description: 'Remaining as returned. NULL when absent or not an integer.', expr: { duckdb: limitInt('Remaining') } },
    {
      name: 'used',
      type: 'BIGINT',
      description: 'Used as stored, or max - remaining when Used is absent and both are integers; otherwise NULL.',
      expr: { duckdb: `coalesce(${limitInt('Used')}, max - remaining)` },
    },
    {
      name: 'pct_used',
      type: 'DOUBLE',
      description: '100 * used / max. NULL when max is 0 or NULL, or used is NULL.',
      expr: { duckdb: 'CASE WHEN max IS NULL OR max = 0 THEN NULL ELSE 100.0 * used / max END' },
    },
    ORG_ID,
    ORG_LABEL,
  ],
  knownGaps: [
    'Only top-level limits are included. Nested sub-limits (e.g. PermissionSets.CreateCustom) are left out; read them from records.payload.',
  ],
};

const LOGIN_HISTORY: ViewDefinition = {
  name: 'login_history',
  version: 1,
  grain: 'One row per login attempt.',
  description:
    'Login attempts from LoginHistory, successful and failed, with the verbatim Salesforce fields flattened to columns.',
  sources: ['login-history'],
  timeColumn: 'occurred_at_utc',
  columns: [
    {
      name: 'occurred_at_utc',
      type: 'TIMESTAMP',
      description: 'LoginTime, UTC wall time.',
      expr: { duckdb: "timezone('UTC', occurred_at)" },
    },
    {
      name: 'occurred_at_local',
      type: 'TIMESTAMPTZ',
      description: 'LoginTime as an instant, shown in the --timezone zone.',
      expr: { duckdb: 'occurred_at' },
    },
    {
      name: 'user_id',
      type: 'VARCHAR',
      description: "UserId: the user who attempted the login. LoginHistory carries no username.",
      expr: { duckdb: field('UserId') },
    },
    {
      name: 'status',
      type: 'VARCHAR',
      description: "Status, verbatim: Success or Salesforce's failure text (e.g. Invalid Password).",
      expr: { duckdb: field('Status') },
    },
    {
      name: 'login_type',
      type: 'VARCHAR',
      description: "LoginType, verbatim (e.g. Application, Remote Access 2.0).",
      expr: { duckdb: field('LoginType') },
    },
    {
      name: 'login_sub_type',
      type: 'VARCHAR',
      description: "LoginSubType, verbatim (e.g. OAuth 2.0 Web Server Flow).",
      expr: { duckdb: field('LoginSubType') },
    },
    {
      name: 'application',
      type: 'VARCHAR',
      description: "Application the login came through, verbatim.",
      expr: { duckdb: field('Application') },
    },
    {
      name: 'browser',
      type: 'VARCHAR',
      description: "Browser, verbatim.",
      expr: { duckdb: field('Browser') },
    },
    {
      name: 'platform',
      type: 'VARCHAR',
      description: "Platform (operating system), verbatim.",
      expr: { duckdb: field('Platform') },
    },
    {
      name: 'source_ip',
      type: 'VARCHAR',
      description: "SourceIp: the IP address the login came from.",
      expr: { duckdb: field('SourceIp') },
    },
    {
      name: 'forwarded_for_ip',
      type: 'VARCHAR',
      description: "ForwardedForIp: the client address behind a proxy, when Salesforce recorded one.",
      expr: { duckdb: field('ForwardedForIp') },
    },
    {
      name: 'country_iso',
      type: 'VARCHAR',
      description: "CountryIso: two-letter country code Salesforce resolved from the IP. NULL when it could not.",
      expr: { duckdb: field('CountryIso') },
    },
    {
      name: 'login_url',
      type: 'VARCHAR',
      description: "LoginUrl: the host the user logged in at.",
      expr: { duckdb: field('LoginUrl') },
    },
    {
      name: 'api_type',
      type: 'VARCHAR',
      description: "ApiType, verbatim (e.g. SOAP Enterprise). NULL for UI logins.",
      expr: { duckdb: field('ApiType') },
    },
    {
      name: 'api_version',
      type: 'VARCHAR',
      description: "ApiVersion of the login, verbatim (e.g. 64.0). Not the version the record was collected with.",
      expr: { duckdb: field('ApiVersion') },
    },
    {
      name: 'auth_method_reference',
      type: 'VARCHAR',
      description: "AuthMethodReference: how the user authenticated (e.g. password, MFA), verbatim.",
      expr: { duckdb: field('AuthMethodReference') },
    },
    {
      name: 'tls_protocol',
      type: 'VARCHAR',
      description: "TlsProtocol, verbatim (e.g. TLS 1.3).",
      expr: { duckdb: field('TlsProtocol') },
    },
    {
      name: 'auth_context_class_ref',
      type: 'VARCHAR',
      description: "AuthContextClassRef: the authentication context class, verbatim.",
      expr: { duckdb: field('AuthContextClassRef') },
    },
    SOURCE_ID,
    ORG_ID,
    ORG_LABEL,
    COLLECTED_AT_UTC,
  ],
  knownGaps: [
    'No username: LoginHistory carries only UserId. Join user_id to setup_changes.performed_by_id to name users who also made setup changes.',
    "Status is free text from Salesforce (e.g. Success, Invalid Password); match on it, don't assume a closed list.",
    "forwarded_for_ip, auth_method_reference and auth_context_class_ref are NULL for records collected after the org rejected them (see the manifest's fieldsDropped).",
  ],
};

export const VIEWS: readonly ViewDefinition[] = [RECORDS, SETUP_CHANGES, LIMIT_SAMPLES, LOGIN_HISTORY];
