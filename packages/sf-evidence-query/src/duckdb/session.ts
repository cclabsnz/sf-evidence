import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileDuckdbViews, type QueryFiles } from '@cclabsnz/sf-evidence-engine';
import { asFileAccessRejection, errorMessage, guardStatement } from './guard.js';

/**
 * The only module that imports `@duckdb/node-api` (the dependency-boundary test enforces it), so
 * every DuckDB instance the plugin opens goes through `openQuerySession` and gets the lockdown
 * below. Setting names and the order they must go in are verified in DUCKDB-FACTS.md.
 */
type DuckDbModule = typeof import('@duckdb/node-api');
type DuckDBInstance = import('@duckdb/node-api').DuckDBInstance;
type DuckDBConnection = import('@duckdb/node-api').DuckDBConnection;
type DuckDBPreparedStatement = import('@duckdb/node-api').DuckDBPreparedStatement;
type DuckDBResultReader = import('@duckdb/node-api').DuckDBResultReader;
type DuckDBType = import('@duckdb/node-api').DuckDBType;
type DuckDBListType = import('@duckdb/node-api').DuckDBListType;
type DuckDBStructType = import('@duckdb/node-api').DuckDBStructType;
type DuckDBMapType = import('@duckdb/node-api').DuckDBMapType;

/** DuckDB's native binding could not be loaded (missing prebuilt binary, unsupported platform, ...). */
export class QueryEngineUnavailable extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'QueryEngineUnavailable';
  }
}

/**
 * Load DuckDB on first use, never at plugin load: it is a large native addon, and a broken one
 * must fail `query` (and the doctor check) with a clear error rather than every `sf` command.
 *
 * `load` exists so a test can simulate a failed load directly. The default is a dynamic import
 * evaluated inside this function, so `jest.unstable_mockModule('@duckdb/node-api', ...)`
 * registered before this module is imported also takes effect.
 */
export async function loadDuckdb(
  load: () => Promise<DuckDbModule> = () => import('@duckdb/node-api'),
): Promise<DuckDbModule> {
  try {
    return await load();
  } catch (err) {
    throw new QueryEngineUnavailable(`The DuckDB query engine could not be loaded: ${errorMessage(err)}`);
  }
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  /** True when the query produced more rows than the `limit` passed to `run`. */
  truncated: boolean;
}

export interface QuerySession {
  /** Run one guarded SELECT. Throws `StatementRejected` for anything the sandbox refuses. */
  run(sql: string, limit?: number): Promise<QueryResult>;
  /** The engine version, for example `v1.5.6`. */
  version(): Promise<string>;
  close(): void;
}

/** A SQL string literal. DuckDB string literals do not process backslashes, so doubling `'` is the whole escape. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Fractional seconds: none when zero, `.mmm` when only milliseconds are set, else every digit DuckDB kept. */
function fraction(digits: string): string {
  const d = digits.replace(/0+$/, '');
  if (d === '') return '';
  return `.${d.padEnd(d.length <= 3 ? 3 : d.length <= 6 ? 6 : 9, '0')}`;
}

/** DuckDB's naive timestamp text, `YYYY-MM-DD HH:MM:SS[.f]`. BC dates and infinities do not match and pass through. */
const NAIVE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/;

/** Floor division, so an instant before 1970 still splits into whole seconds plus a non-negative remainder. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** The instants `Date` and `Intl` render faithfully: years 0001 to 9999 UTC, with a day's margin for the offset. */
const MIN_MS = new Date('0001-01-02T00:00:00Z').getTime();
const MAX_MS = Date.UTC(9999, 11, 30);

/**
 * Renders one result's values for JSON output (design §5.6). Built on `getRowObjectsJson`, which
 * already gives BIGINT, HUGEINT and DECIMAL as precise strings; only timestamps are rewritten,
 * at any depth inside LIST, ARRAY, STRUCT and MAP.
 *
 * - TIMESTAMP (and its _S/_MS/_NS variants) is UTC wall time by the views' contract, so it
 *   prints as ISO `…Z`.
 * - TIMESTAMPTZ prints in the session zone with that instant's `±HH:MM` offset, never `Z`: the
 *   offset is the point of a `*_local` column. It is formatted here from the raw instant
 *   because `getRowObjectsJson` ignores the session TimeZone and labels every TIMESTAMPTZ with
 *   the Node process's current offset (an August Auckland instant printed `+13` from an NZDT
 *   host, where the truth is `+12`). The zone is pinned by `lock_configuration`, so the one the
 *   session was opened with is the one in force.
 */
class RowRenderer {
  private readonly wall: Intl.DateTimeFormat;

  public constructor(
    private readonly ids: DuckDbModule['DuckDBTypeId'],
    timezone: string,
  ) {
    this.wall = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  public rows(reader: DuckDBResultReader): Record<string, unknown>[] {
    const json = reader.getRowObjectsJson() as Record<string, unknown>[];
    const types = reader.columnTypes();
    const names = reader.columnNames();
    const touched = types.map((t) => this.hasTimestamp(t));
    if (!touched.some(Boolean)) return json;
    // Raw values carry a TIMESTAMPTZ's exact instant; only fetched when one is in the result.
    const raw = types.some((t) => this.hasTimestampTz(t)) ? (reader.getRowObjects() as Record<string, unknown>[]) : undefined;
    return json.map((row, r) => {
      const out = { ...row };
      names.forEach((name, c) => {
        if (touched[c]) out[name] = this.value(types[c]!, row[name], raw?.[r]?.[name]);
      });
      return out;
    });
  }

  private value(type: DuckDBType, json: unknown, raw: unknown): unknown {
    if (json === null || json === undefined) return json;
    const ids = this.ids;
    switch (type.typeId) {
      case ids.TIMESTAMP:
      case ids.TIMESTAMP_S:
      case ids.TIMESTAMP_MS:
      case ids.TIMESTAMP_NS:
        return this.naive(json);
      case ids.TIMESTAMP_TZ:
        return this.zoned(json, raw);
      case ids.LIST:
      case ids.ARRAY: {
        const item = (type as DuckDBListType).valueType;
        const items = (raw as { items?: unknown[] } | undefined)?.items;
        return Array.isArray(json) ? json.map((v, i) => this.value(item, v, items?.[i])) : json;
      }
      case ids.STRUCT: {
        const st = type as DuckDBStructType;
        const entries = (raw as { entries?: Record<string, unknown> } | undefined)?.entries;
        const obj = { ...(json as Record<string, unknown>) };
        st.entryNames.forEach((n, i) => {
          if (n in obj) obj[n] = this.value(st.entryTypes[i]!, obj[n], entries?.[n]);
        });
        return obj;
      }
      case ids.MAP: {
        const mt = type as DuckDBMapType;
        const entries = (raw as { entries?: { key: unknown; value: unknown }[] } | undefined)?.entries;
        return Array.isArray(json)
          ? (json as { key: unknown; value: unknown }[]).map((e, i) => ({
              key: this.value(mt.keyType, e.key, entries?.[i]?.key),
              value: this.value(mt.valueType, e.value, entries?.[i]?.value),
            }))
          : json;
      }
      default:
        return json;
    }
  }

  private naive(json: unknown): unknown {
    const m = typeof json === 'string' ? NAIVE.exec(json) : null;
    return m ? `${m[1]}T${m[2]}${fraction(m[3] ?? '')}Z` : json;
  }

  private zoned(json: unknown, raw: unknown): unknown {
    const micros = (raw as { micros?: unknown } | undefined)?.micros;
    if (typeof micros !== 'bigint') return json;
    const seconds = floorDiv(micros, 1_000_000n);
    const ms = Number(seconds) * 1000;
    // Infinities and instants outside Date's faithful range keep DuckDB's own text.
    if (!(ms >= MIN_MS && ms <= MAX_MS)) return json;
    const parts: Record<string, string> = {};
    for (const p of this.wall.formatToParts(new Date(ms))) parts[p.type] = p.value;
    const year = Number(parts.year);
    const [mo, d, h, mi, s] = [parts.month, parts.day, parts.hour, parts.minute, parts.second].map(Number) as [number, number, number, number, number];
    // setUTCFullYear, not Date.UTC, which would read years 1-99 as 1901-1999.
    const asUtc = new Date(0);
    asUtc.setUTCFullYear(year, mo - 1, d);
    asUtc.setUTCHours(h, mi, s);
    const offset = Math.round((asUtc.getTime() - ms) / 1000);
    const abs = Math.abs(offset);
    const pad = (n: number): string => String(n).padStart(2, '0');
    // Historical local mean times have offsets with seconds; print them rather than lie in ±HH:MM.
    const off = `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 3600))}:${pad(Math.floor(abs / 60) % 60)}${abs % 60 === 0 ? '' : `:${pad(abs % 60)}`}`;
    const frac = fraction(String(micros - seconds * 1_000_000n).padStart(6, '0'));
    return `${String(year).padStart(4, '0')}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${frac}${off}`;
  }

  private hasTimestamp(type: DuckDBType): boolean {
    const ids = this.ids;
    switch (type.typeId) {
      case ids.TIMESTAMP:
      case ids.TIMESTAMP_S:
      case ids.TIMESTAMP_MS:
      case ids.TIMESTAMP_NS:
      case ids.TIMESTAMP_TZ:
        return true;
      default:
        return this.children(type).some((t) => this.hasTimestamp(t));
    }
  }

  private hasTimestampTz(type: DuckDBType): boolean {
    return type.typeId === this.ids.TIMESTAMP_TZ || this.children(type).some((t) => this.hasTimestampTz(t));
  }

  /** The nested types `value` descends into; other containers (UNION) are left as DuckDB renders them. */
  private children(type: DuckDBType): readonly DuckDBType[] {
    const ids = this.ids;
    switch (type.typeId) {
      case ids.LIST:
      case ids.ARRAY:
        return [(type as DuckDBListType).valueType];
      case ids.STRUCT:
        return (type as DuckDBStructType).entryTypes;
      case ids.MAP:
        return [(type as DuckDBMapType).keyType, (type as DuckDBMapType).valueType];
      default:
        return [];
    }
  }
}

/**
 * Open an in-memory DuckDB instance locked down to the chain-covered record files in `files`
 * (design §5.4), with the query views (§5.3, §5.5) created over them.
 *
 * The order is load-bearing:
 * 1. Create options: extension autoinstall and autoload off; `temp_directory` empty so nothing
 *    spills to disk; DuckDB's home, extension and secret directories pointed at a path that is
 *    never created, so nothing is read from or written to `~/.duckdb`.
 * 2. `max_temp_directory_size = '0B'`, the second half of spill-off. It only takes effect via
 *    SET (as a create option it is ignored), and only before any query uses the temp directory.
 * 3. `TimeZone`, which DuckDB uses for TIMESTAMPTZ casts and date parts and `RowRenderer` prints
 *    TIMESTAMPTZ in; the lock then pins it.
 * 4. The views. DuckDB checks their files exist at CREATE time, which needs file access on.
 * 5. `allowed_paths` = every file in `files.bySource` and nothing else. It must be set before
 *    external access goes off; DuckDB refuses to change it afterwards. It is an exact-file list
 *    (a sibling in the same directory is denied), and an empty list denies every file, so a
 *    session with no files (the doctor check) needs no stand-in entry. `allowed_directories` is
 *    set empty explicitly so no directory-wide grant can ride along.
 * 6. HTTP and S3 filesystems disabled. Redundant under step 7, kept as a second wall.
 * 7. `enable_external_access = false`: reads outside the allow-list, globs, COPY TO, ATTACH of a
 *    file, INSTALL and LOAD all fail from here on.
 * 8. `lock_configuration = true`, so user SQL cannot SET or RESET any of the above.
 * User SQL then passes through `guardStatement`, the real read-only control.
 */
export async function openQuerySession(opts: {
  files: QueryFiles;
  timezone: string;
  load?: () => Promise<DuckDbModule>;
}): Promise<QuerySession> {
  // Compiled first: a path the compiler refuses (glob characters) fails before any instance exists.
  const views = compileDuckdbViews({ files: opts.files, timezone: opts.timezone });
  const allowed = [...new Set(Object.values(opts.files.bySource).flat())].sort();

  const duckdb = await loadDuckdb(opts.load);
  const unused = join(tmpdir(), `sf-evidence-query-no-home-${randomUUID()}`);
  const instance = await duckdb.DuckDBInstance.create(':memory:', {
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    temp_directory: '',
    home_directory: join(unused, 'home'),
    extension_directory: join(unused, 'extensions'),
    secret_directory: join(unused, 'secrets'),
  });
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    await connection.run("SET max_temp_directory_size = '0B'");
    await connection.run(`SET TimeZone = ${lit(opts.timezone)}`);
    for (const view of views) await connection.run(view);
    await connection.run(`SET allowed_paths = [${allowed.map(lit).join(', ')}]::VARCHAR[]`);
    await connection.run('SET allowed_directories = []::VARCHAR[]');
    await connection.run("SET disabled_filesystems = 'HTTPFileSystem,S3FileSystem'");
    await connection.run('SET enable_external_access = false');
    await connection.run('SET lock_configuration = true');
  } catch (err) {
    connection?.closeSync();
    instance.closeSync();
    throw err;
  }
  return sessionOver(instance, connection, new RowRenderer(duckdb.DuckDBTypeId, opts.timezone));
}

function sessionOver(
  instance: DuckDBInstance,
  connection: DuckDBConnection,
  renderer: RowRenderer,
): QuerySession {
  const port = {
    extract: (sql: string) => connection.extractStatements(sql),
    // DuckDB's own parser, before PRAGMA rewriting; the SQL is bound, never spliced.
    serialize: async (sql: string): Promise<string> => {
      const reader = await connection.runAndReadAll('SELECT json_serialize_sql(CAST($1 AS VARCHAR)) AS j', [sql]);
      const json = reader.getRowObjectsJson()[0]?.j;
      return typeof json === 'string' ? json : '';
    },
    statementType: (p: DuckDBPreparedStatement) => p.statementType as number,
    destroy: (p: DuckDBPreparedStatement) => p.destroySync(),
  };
  let closed = false;

  return {
    async run(sql: string, limit?: number): Promise<QueryResult> {
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0)) {
        throw new TypeError(`limit must be a non-negative integer, got ${String(limit)}.`);
      }
      const prepared = await guardStatement(sql, port);
      try {
        // Streamed, so a limited query stops pulling rows once it has one past the limit. The
        // reader fills whole chunks, so it may hold more than asked; the slice below trims it.
        const reader =
          limit === undefined ? await prepared.streamAndReadAll() : await prepared.streamAndReadUntil(limit + 1);
        const names = reader.columnNames();
        const types = reader.columnTypes();
        const columns = names.map((name, i) => ({ name, type: types[i]!.toString() }));
        const rows = renderer.rows(reader);
        const truncated = limit !== undefined && rows.length > limit;
        return { columns, rows: truncated ? rows.slice(0, limit) : rows, truncated };
      } catch (err) {
        throw asFileAccessRejection(err);
      } finally {
        prepared.destroySync();
      }
    },
    async version(): Promise<string> {
      const reader = await connection.runAndReadAll('SELECT version() AS v');
      return String(reader.getRowObjectsJson()[0]?.v);
    },
    /** Idempotent: a second call (an error path after a normal close) is a no-op. */
    close(): void {
      if (closed) return;
      closed = true;
      connection.closeSync();
      instance.closeSync();
    },
  };
}
