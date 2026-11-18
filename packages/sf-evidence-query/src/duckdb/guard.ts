/**
 * The statement guard: the read-only control for user SQL (design §5.4 step 6). The lockdown
 * settings are defence in depth; after `lock_configuration`, `CREATE TABLE` and
 * `ATTACH ':memory:'` still succeed, so this gate is what keeps a query a query.
 *
 * It talks to DuckDB through `GuardPort`, never the package, so `session.ts` stays the only
 * module that imports `@duckdb/node-api`.
 */

/** User SQL refused before it ran. The message says why: statement count, statement type, or file access. */
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
  /** Whether DuckDB's parser, before any rewriting, reads `sql` as exactly one SELECT statement. */
  parsesAsSelect(sql: string): Promise<boolean>;
  statementType(prepared: P): number;
}

/**
 * DuckDB reports a read outside `allowed_paths`, a glob, or a remote URL as a Permission Error
 * ("file system operations are disabled by configuration"). Those are refusals, so they surface
 * as `StatementRejected`; every other engine error (Catalog, Binder, Conversion) is the user's
 * SQL being wrong and passes through untouched.
 */
export function asFileAccessRejection(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (/Permission Error|disabled by configuration/.test(message)) {
    return new StatementRejected(`Query refused (file access): it reads a file or URL other than the archive's chain-covered record files. ${message}`);
  }
  return err;
}

/**
 * Prepare `sql` only if it is exactly one SELECT, and return the prepared statement.
 *
 * Order matters:
 * 1. Blank input is refused up front: DuckDB's splitter throws an opaque native error on it.
 * 2. The splitter must find exactly one statement, so `SELECT 1; COPY ...` never reaches the
 *    binder and `PIVOT` (which DuckDB expands into two) is refused.
 * 3. The un-rewritten parse must be a SELECT. The prepared type alone is not enough: DuckDB
 *    rewrites `PRAGMA version` into a table-function SELECT before binding, so it prepares as
 *    SELECT. `DESCRIBE`, `SHOW` and `SUMMARIZE` parse as SELECT nodes and stay allowed.
 * 4. The prepared statement's type must be SELECT. This is the classification the design names,
 *    by DuckDB's binder and never by pattern matching on the text. `EXPLAIN` is refused (the
 *    design allows SELECT only).
 * Checking 3 before preparing also means a non-SELECT is never bound at all.
 */
export async function guardStatement<P>(sql: string, port: GuardPort<P>): Promise<P> {
  if (/^[\s;]*$/.test(sql)) {
    throw new StatementRejected('Query refused: the SQL is empty.');
  }
  let extracted: Awaited<ReturnType<GuardPort<P>['extract']>>;
  try {
    extracted = await port.extract(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
  if (!(await port.parsesAsSelect(sql))) {
    throw new StatementRejected('Query refused: only SELECT statements may run against the archive.');
  }
  let prepared: P;
  try {
    prepared = await extracted.prepare(0);
  } catch (err) {
    throw asFileAccessRejection(err);
  }
  const type = port.statementType(prepared);
  if (type !== SELECT_STATEMENT_TYPE) {
    throw new StatementRejected(
      `Query refused: only SELECT statements may run against the archive (statement type ${type}).`,
    );
  }
  return prepared;
}
