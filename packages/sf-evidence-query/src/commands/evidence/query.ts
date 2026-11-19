import { readFile } from 'node:fs/promises';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { SfError } from '@salesforce/core';
import {
  DEFAULT_ARCHIVE,
  EXIT,
  VIEWS,
  isOrgId,
  resolveQueryFiles,
  resolveSink,
  setExitCode,
  type ViewDefinition,
} from '@cclabsnz/sf-evidence-engine';
import { QueryEngineUnavailable, openQuerySession, type QuerySession } from '../../duckdb/session.js';
import { StatementRejected, errorMessage } from '../../duckdb/guard.js';
import { csvLines, ndjsonLines, tableLines, toJsonRows, type Column, type OutputFormat } from '../../format.js';

export interface QueryCommandResult {
  columns: Column[];
  /** BIGINT/DECIMAL as numbers where exact, else strings; timestamps as ISO-8601. */
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when `--limit` cut the result short. The table format's default cap does not set it. */
  truncated: boolean;
  warnings: string[];
}

/** How many rows `--format table` prints when no `--limit` is given, so a terminal is not flooded. */
const TABLE_DEFAULT_ROWS = 100;
const FORMATS: OutputFormat[] = ['table', 'json', 'csv', 'ndjson'];
const REINSTALL = 'Reinstall it with: sf plugins install @cclabsnz/sf-evidence-query';

type EngineLoad = Parameters<typeof openQuerySession>[0]['load'];

function usage(message: string): SfError {
  return new SfError(message, 'QueryUsageError', [], EXIT.USAGE);
}

function failure(message: string, name = 'QueryFailed', actions: string[] = []): SfError {
  return new SfError(message, name, actions, EXIT.ERROR);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Seconds optional; at most microseconds, DuckDB's TIMESTAMP precision; a zone is required. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** True when y-m-d is a real calendar date. `Date` rolls 2026-02-30 over to March; this does not. */
function realDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * `--from`/`--to` as a DuckDB TIMESTAMP literal in UTC wall time, the views' time axis
 * (design §5.2). Accepts `YYYY-MM-DD` (UTC midnight) or an ISO timestamp with `Z` or an
 * offset. The literal is printed from the parsed `Date` (plus validated microsecond digits),
 * never from the user's text, so nothing they typed reaches the SQL.
 */
export function utcBound(flag: string, value: string): string {
  const date = DATE_ONLY.exec(value);
  const ts = date ? null : TIMESTAMP.exec(value);
  const parts = date ?? ts;
  if (!parts) {
    throw usage(`--${flag} must be YYYY-MM-DD or an ISO timestamp with Z or an offset, got '${value}'.`);
  }
  const [y, mo, d] = [parts[1], parts[2], parts[3]].map(Number) as [number, number, number];
  let micros = '000';
  let instant: Date;
  if (ts) {
    const [h, mi, s, oh, om] = [ts[4], ts[5], ts[6] ?? '0', ts[9] ?? '0', ts[10] ?? '0'].map(Number) as number[];
    if (!realDate(y, mo, d) || h! > 23 || mi! > 59 || s! > 59 || oh! > 23 || om! > 59) {
      throw usage(`--${flag} is not a valid timestamp: '${value}'.`);
    }
    const frac = (ts[7] ?? '').padEnd(6, '0');
    micros = frac.slice(3);
    instant = new Date(`${ts[1]}-${ts[2]}-${ts[3]}T${ts[4]}:${ts[5]}:${ts[6] ?? '00'}.${frac.slice(0, 3)}${ts[8]}`);
  } else {
    if (!realDate(y, mo, d)) throw usage(`--${flag} is not a valid date: '${value}'.`);
    instant = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00.000Z`);
  }
  if (Number.isNaN(instant.getTime())) throw usage(`--${flag} is not a valid timestamp: '${value}'.`);
  const iso = instant.toISOString();
  // Years outside 0000-9999 print as ±YYYYYY, which is no TIMESTAMP literal.
  if (!/^\d{4}-/.test(iso)) throw usage(`--${flag} is out of range: '${value}'.`);
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}${micros}`;
}

/** `SELECT * FROM <view> [WHERE <time> >= from AND <time> < to] ORDER BY <time>`, built only from `VIEWS` metadata and parsed bounds. */
export function viewSql(view: ViewDefinition, from: string | undefined, to: string | undefined): string {
  const t = `"${view.timeColumn}"`;
  const where = [
    ...(from === undefined ? [] : [`${t} >= TIMESTAMP '${utcBound('from', from)}'`]),
    ...(to === undefined ? [] : [`${t} < TIMESTAMP '${utcBound('to', to)}'`]),
  ];
  return `SELECT * FROM "${view.name}"${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${t}`;
}

export default class EvidenceQuery extends SfCommand<QueryCommandResult> {
  public static readonly summary = 'Query the archive with SQL, or print one of its views';

  public static readonly description = `Runs one read-only SELECT against the archive in an in-process, sandboxed DuckDB, or
prints a view (records, setup_changes, limit_samples) with --view. Queries see only the record
files the hash chain covers; files it does not cover are excluded and counted in a warning.

Results are not verified: this command says nothing about chain validity. Run
sf evidence verify when the answer is going to an auditor.

Contacts no Salesforce org and no network, and writes nothing.

--from and --to (with --view only) take YYYY-MM-DD (UTC midnight) or an ISO timestamp with Z
or an offset, and bound the view's time column as [from, to), in UTC.

Exit codes: 0 success, including zero rows · 1 the archive holds no chain for the requested
org (or no orgs at all), the query engine could not load, the SQL was refused, or the SQL
failed · 2 usage error, including an --org-id that is not an 18-character org id.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --org-id 00D5j000000AbCdEAK --view setup_changes --from 2026-08-01 --to 2026-09-01',
    `<%= config.bin %> <%= command.id %> --all-orgs --sql "SELECT org_label, action, count(*) AS n FROM setup_changes GROUP BY ALL ORDER BY n DESC" --format csv`,
    '<%= config.bin %> <%= command.id %> --org-id 00D5j000000AbCdEAK --file ./who-changed-profiles.sql --format ndjson',
  ];

  public static readonly flags = {
    sql: Flags.string({ summary: 'One SELECT statement to run.', exactlyOne: ['sql', 'file', 'view'] }),
    file: Flags.file({ summary: 'File holding one SELECT statement to run.', exists: true, exactlyOne: ['sql', 'file', 'view'] }),
    view: Flags.string({
      summary: 'Print one view, ordered by its time column.',
      options: VIEWS.map((v) => v.name),
      exactlyOne: ['sql', 'file', 'view'],
    }),
    'org-id': Flags.string({ summary: 'Org id partition to query.', exactlyOne: ['org-id', 'all-orgs'] }),
    'all-orgs': Flags.boolean({ summary: 'Query every org in the archive.', exactlyOne: ['org-id', 'all-orgs'] }),
    archive: Flags.string({ summary: 'Archive root directory.', default: DEFAULT_ARCHIVE }),
    sink: Flags.string({ summary: 'Sink holding the archive.', default: 'local' }),
    from: Flags.string({
      summary: 'With --view: only rows at or after this UTC date or ISO timestamp.',
      helpValue: '<date>',
      dependsOn: ['view'],
    }),
    to: Flags.string({
      summary: 'With --view: only rows before this UTC date or ISO timestamp.',
      helpValue: '<date>',
      dependsOn: ['view'],
    }),
    format: Flags.string({ summary: 'Output format.', options: FORMATS, default: 'table' }),
    limit: Flags.integer({
      summary: `Return at most this many rows, in every format. Table output shows ${TABLE_DEFAULT_ROWS} when it is not given.`,
      min: 0,
    }),
    timezone: Flags.string({
      summary: 'IANA zone for the *_local columns.',
      default: 'Pacific/Auckland',
      helpValue: '<IANA>',
    }),
  };

  public async run(): Promise<QueryCommandResult> {
    const { flags } = await this.parse(EvidenceQuery);
    const format = flags.format as OutputFormat;

    // Validated before anything is opened: DuckDB would accept some names Intl rejects, and the
    // session renders *_local values through Intl.
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: flags.timezone });
    } catch {
      throw usage(`--timezone '${flags.timezone}' is not an IANA time zone, e.g. Pacific/Auckland or UTC.`);
    }
    // A usage error (exit 2), not a failure: the value is wrong before any archive is consulted.
    const orgId = flags['org-id'];
    if (orgId !== undefined && !isOrgId(orgId)) {
      throw usage(`--org-id must be an 18-character alphanumeric org id, got '${orgId}'.`);
    }
    const sql = await this.statement(flags);

    let session: QuerySession | undefined;
    try {
      const sink = resolveSink(flags.sink, flags.archive);
      // Not init(): that asks for write access, and query only reads, so a read-only archive must work.
      await sink.checkReadable();
      // The resolved root, so the message names the directory actually consulted, not a relative flag.
      const where = sink.queryRoot() ?? flags.archive;
      const orgIds = flags['all-orgs'] ? await sink.listOrgs() : [orgId!];
      // Without these, an archive with nothing to read is exit 0 and zero rows, which reads as
      // "no events" when the truth is "wrong --org-id or wrong --archive".
      if (orgIds.length === 0) throw failure(`No orgs found in ${where}.`, 'NoArchive');
      const files = await resolveQueryFiles(sink, orgIds);
      if (files.missingOrgs.length === orgIds.length) {
        throw failure(
          `No archive for org ${files.missingOrgs.join(', ')} in ${where}. Check --org-id, or run sf evidence status.`,
          'NoArchive',
        );
      }

      const warnings: string[] = [];
      const warn = (w: string): void => {
        warnings.push(w);
        this.warn(w);
      };
      // Only --all-orgs reaches this with a missing org: an org_id= partition with no chain.
      for (const id of files.missingOrgs) {
        warn(`No archive for org ${id} in ${where}; it has no manifests, so it adds no rows. Run sf evidence status.`);
      }
      if (files.rejectedPaths > 0) {
        warn(`${files.rejectedPaths} manifest file path(s) are outside the archive layout and were excluded. Run sf evidence verify.`);
      }
      if (files.orphanCount > 0) {
        warn(`${files.orphanCount} record file(s) in the archive are not covered by the hash chain and were excluded. Run sf evidence verify.`);
      }

      session = await openQuerySession({ files, timezone: flags.timezone, load: this.engineLoader() });
      const result = await session.run(sql, flags.limit);
      const rows = toJsonRows(result.columns, result.rows);
      // --json prints only the envelope; SfCommand would discard these lines anyway.
      if (!this.jsonEnabled()) this.print(format, result.columns, rows, flags.limit === undefined);
      // Every non-zero exit here is a thrown error; named so the success path matches status/doctor.
      setExitCode(EXIT.OK);
      return { columns: result.columns, rows, rowCount: rows.length, truncated: result.truncated, warnings };
    } catch (err) {
      throw this.asCommandError(err);
    } finally {
      session?.close();
    }
  }

  /** Where DuckDB is loaded from. Undefined is the real package; a test overrides it to simulate a broken install. */
  protected engineLoader(): EngineLoad {
    return undefined;
  }

  private async statement(flags: { sql?: string; file?: string; view?: string; from?: string; to?: string }): Promise<string> {
    if (flags.sql !== undefined) return flags.sql;
    if (flags.file !== undefined) {
      try {
        return await readFile(flags.file, 'utf8');
      } catch (err) {
        throw failure(`Could not read --file ${flags.file}: ${errorMessage(err)}`);
      }
    }
    const view = VIEWS.find((v) => v.name === flags.view);
    // Unreachable: oclif checks --view against VIEWS' names and requires one of the three flags.
    if (!view) throw usage(`Unknown view '${String(flags.view)}'.`);
    return viewSql(view, flags.from, flags.to);
  }

  private print(format: OutputFormat, columns: Column[], rows: Record<string, unknown>[], capTable: boolean): void {
    switch (format) {
      case 'json':
        this.log(JSON.stringify(rows, null, 2));
        return;
      case 'csv':
        for (const line of csvLines(columns, rows)) this.log(line);
        return;
      case 'ndjson':
        for (const line of ndjsonLines(rows)) this.log(line);
        return;
      case 'table': {
        const shown = capTable ? rows.slice(0, TABLE_DEFAULT_ROWS) : rows;
        for (const line of tableLines(columns, shown)) this.log(line);
        const more = rows.length - shown.length;
        if (more > 0) this.log(`… ${more} more rows. Use --limit or --format csv.`);
        return;
      }
    }
  }

  /**
   * Every failure past flag parsing is exit 1 (design §5.2), as an `SfError` so `SfCommand`
   * cannot reclassify it: it maps a bare TypeError to exit 10, and an error whose text looks
   * like a Salesforce gack to 20. DuckDB's own errors are cross-realm under Jest, hence
   * `errorMessage`, not `instanceof Error`.
   */
  private asCommandError(err: unknown): unknown {
    if (err instanceof SfError) return err;
    if (err instanceof QueryEngineUnavailable) {
      return failure(`Query engine could not load: ${err.message}. ${REINSTALL}`, 'QueryEngineUnavailable', [REINSTALL]);
    }
    if (err instanceof StatementRejected) return failure(err.message, 'StatementRejected');
    return failure(errorMessage(err));
  }
}
