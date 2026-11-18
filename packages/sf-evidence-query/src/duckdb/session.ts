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

/**
 * Rows as JSON-safe objects. The single place results are converted, so value rendering
 * (timestamps, BIGINT/DECIMAL strings) has one home. `getRowObjectsJson` renders BIGINT, HUGEINT
 * and DECIMAL as strings and TIMESTAMPTZ in the session TimeZone (DUCKDB-FACTS.md).
 */
function toRows(reader: DuckDBResultReader): Record<string, unknown>[] {
  return reader.getRowObjectsJson() as Record<string, unknown>[];
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
 * 3. `TimeZone`, which renders every TIMESTAMPTZ; the lock then pins it.
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
  return sessionOver(instance, connection);
}

function sessionOver(
  instance: DuckDBInstance,
  connection: DuckDBConnection,
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
        const rows = toRows(reader);
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
