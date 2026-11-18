/**
 * The statement guard: the read-only control for user SQL (design §5.4 step 6). The lockdown
 * settings are defence in depth; after `lock_configuration`, `CREATE TABLE` and
 * `ATTACH ':memory:'` still succeed, so this gate is what keeps a query a query.
 *
 * It talks to DuckDB through `GuardPort`, never the package, so `session.ts` stays the only
 * module that imports `@duckdb/node-api`.
 */

/** User SQL refused before it ran. The message says why: statement count, statement type, a function, or file access. */
export class StatementRejected extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StatementRejected';
  }
}

/** `StatementType.SELECT` in `@duckdb/node-api` 1.5.6 (DUCKDB-FACTS.md, "Statement classification"). */
export const SELECT_STATEMENT_TYPE = 1;

export interface GuardPort<P> {
  /** DuckDB's statement splitter; throws on empty, comment-only or unparseable input. */
  extract(sql: string): Promise<{ count: number; prepare(index: number): Promise<P> }>;
  /** `json_serialize_sql(sql)`: DuckDB's own parse tree of `sql`, before any PRAGMA rewriting, as JSON text. */
  serialize(sql: string): Promise<string>;
  statementType(prepared: P): number;
  destroy(prepared: P): void;
}

/**
 * Table functions a query may call, by name (schema stripped, case-insensitive). An allowlist,
 * because a SELECT is not side-effect free in DuckDB: `enable_logging`, `enable_profiling`,
 * `checkpoint` and friends are table functions that change engine state after
 * `lock_configuration`, and `enable_logging(storage='file', ...)` leaves every later query
 * failing and makes closing the instance abort the process. The readers are listed because
 * `allowed_paths` already confines them to the chain-covered files.
 */
const ALLOWED_TABLE_FUNCTIONS = new Set([
  'range',
  'generate_series',
  'unnest',
  'json_each',
  'json_tree',
  'read_ndjson',
  'read_ndjson_auto',
  'read_json',
  'read_json_auto',
  'read_json_objects',
  'read_csv',
  'read_csv_auto',
  'read_parquet',
  'read_text',
  'read_blob',
  'glob',
]);

/** The read-only catalog functions (`duckdb_settings`, `duckdb_views`, ...) share this prefix in 1.5.6. */
const ALLOWED_TABLE_FUNCTION_PREFIX = 'duckdb_';

/**
 * Refused even if a future list or prefix would admit them: each runs SQL held in a string
 * argument, which this parse-tree inspection cannot see into.
 */
const OPAQUE_SQL_FUNCTIONS = new Set(['query', 'query_table', 'json_execute_serialized_sql']);

/**
 * Scalar functions with an effect outside the query's own result. Of the 1.5.6 functions
 * `duckdb_functions()` flags `has_side_effects`, these two change session state: `write_log`
 * appends to the engine log, and `setseed` resets the random generator other queries share. The
 * rest (random, uuid, nextval/currval with no sequences to name, sleep_ms, error, current_*)
 * only affect the value they return or the query's own run time.
 */
const DENIED_SCALAR_FUNCTIONS = new Set(['write_log', 'setseed']);

interface FunctionRefs {
  table: string[];
  scalar: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * An error's message, read structurally: errors the native addon throws can come from another
 * realm (Jest's VM context, for one), where `instanceof Error` is false and `String(err)` would
 * prefix `Error: `.
 */
export function errorMessage(err: unknown): string {
  return isObject(err) && typeof err.message === 'string' ? err.message : String(err);
}

/** Lower-cased function name, schema dropped: `main.Enable_Logging` and `enable_logging` are one function. */
function functionName(fn: Record<string, unknown>): string {
  return typeof fn.function_name === 'string' ? fn.function_name.toLowerCase() : '';
}

/**
 * Every function the parse tree names, found by walking all of it rather than known paths, so
 * CTEs, subqueries, set-operation branches, joins, lateral refs and function arguments are all
 * reached without listing them. A table-function ref is `{type: 'TABLE_FUNCTION', function: {...}}`;
 * any other `{class: 'FUNCTION'}` node is a scalar, aggregate or window call.
 */
function collectFunctions(node: unknown, out: FunctionRefs, inTableRef = false): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFunctions(item, out);
    return;
  }
  if (!isObject(node)) return;
  if (node.type === 'TABLE_FUNCTION' && isObject(node.function)) {
    out.table.push(functionName(node.function));
    collectFunctions(node.function, out, true);
  } else if (node.class === 'FUNCTION' && !inTableRef) {
    out.scalar.push(functionName(node));
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'function' && node.type === 'TABLE_FUNCTION') continue;
    collectFunctions(value, out);
  }
}

function tableFunctionAllowed(name: string): boolean {
  if (OPAQUE_SQL_FUNCTIONS.has(name)) return false;
  return ALLOWED_TABLE_FUNCTIONS.has(name) || name.startsWith(ALLOWED_TABLE_FUNCTION_PREFIX);
}

/**
 * Check DuckDB's serialized parse of the SQL: exactly one SELECT statement, calling only
 * allowed table functions and no denied scalar. `json_serialize_sql` refuses anything that is
 * not a SELECT ("Only SELECT statements can be serialized"), which is what catches `PRAGMA`.
 */
function checkParseTree(json: string): void {
  let tree: unknown;
  try {
    tree = JSON.parse(json);
  } catch {
    tree = null;
  }
  const statements = isObject(tree) && tree.error === false ? tree.statements : undefined;
  if (!Array.isArray(statements) || statements.length !== 1) {
    throw new StatementRejected('Query refused: only SELECT statements may run against the archive.');
  }
  const refs: FunctionRefs = { table: [], scalar: [] };
  collectFunctions(statements, refs);
  const table = refs.table.find((name) => !tableFunctionAllowed(name));
  if (table !== undefined) {
    throw new StatementRejected(
      `Query refused: table function ${table}() is not allowed; only read-only table functions may run against the archive.`,
    );
  }
  const scalar = refs.scalar.find((name) => DENIED_SCALAR_FUNCTIONS.has(name));
  if (scalar !== undefined) {
    throw new StatementRejected(
      `Query refused: function ${scalar}() changes engine state; only read-only functions may run against the archive.`,
    );
  }
}

/**
 * DuckDB reports a read outside `allowed_paths`, a glob, or a remote URL as an error whose
 * message starts `Permission Error` ("... file system operations are disabled by configuration").
 * Those are refusals, so they surface as `StatementRejected`; every other engine error (Catalog,
 * Binder, Conversion) is the user's SQL being wrong and passes through untouched.
 */
export function asFileAccessRejection(err: unknown): unknown {
  const message = errorMessage(err);
  if (/^Permission Error/.test(message)) {
    return new StatementRejected(
      `Query refused (file access): it reads a file or URL other than the archive's chain-covered record files. Query them through the records view. ${message}`,
    );
  }
  return err;
}

/**
 * Prepare `sql` only if it is exactly one read-only SELECT, and return the prepared statement.
 *
 * Order matters:
 * 1. Blank input is refused up front: DuckDB's splitter throws an opaque native error on it.
 * 2. The splitter must find exactly one statement, so `SELECT 1; COPY ...` never reaches the
 *    binder and `PIVOT` (which DuckDB expands into two) is refused.
 * 3. The un-rewritten parse tree must be one SELECT that calls only allowed table functions and
 *    no denied scalar (`checkParseTree`). The prepared type alone is not enough: DuckDB rewrites
 *    `PRAGMA version` into a table-function SELECT before binding, so it prepares as SELECT, and
 *    `SELECT * FROM enable_logging()` is a SELECT that reconfigures the engine. `DESCRIBE`,
 *    `SHOW` and `SUMMARIZE` parse as SELECT nodes over a show ref and stay allowed.
 * 4. The prepared statement's type must be SELECT, by DuckDB's binder and never by pattern
 *    matching on the text. `EXPLAIN` is refused (the design allows SELECT only).
 * Checking 3 before preparing also means a refused statement is never bound at all.
 */
export async function guardStatement<P>(sql: string, port: GuardPort<P>): Promise<P> {
  if (/^[\s;]*$/.test(sql)) {
    throw new StatementRejected('Query refused: the SQL is empty.');
  }
  let extracted: Awaited<ReturnType<GuardPort<P>['extract']>>;
  try {
    extracted = await port.extract(sql);
  } catch (err) {
    const message = errorMessage(err);
    throw new StatementRejected(
      /Parser Error/.test(message)
        ? `Query refused: the SQL could not be parsed. ${message}`
        : 'Query refused: the SQL contains no statement (it is empty or only comments).',
    );
  }
  if (extracted.count !== 1) {
    throw new StatementRejected(
      `Query refused: run exactly one statement at a time (found ${extracted.count}).`,
    );
  }
  checkParseTree(await port.serialize(sql));
  let prepared: P;
  try {
    prepared = await extracted.prepare(0);
  } catch (err) {
    throw asFileAccessRejection(err);
  }
  const type = port.statementType(prepared);
  if (type !== SELECT_STATEMENT_TYPE) {
    port.destroy(prepared);
    throw new StatementRejected(
      `Query refused: only SELECT statements may run against the archive (statement type ${type}).`,
    );
  }
  return prepared;
}
