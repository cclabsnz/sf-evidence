import type { QueryFiles } from '../archive/queryFiles.js';
import { VIEWS, type ViewDefinition } from './views.js';

/** A SQL string literal. DuckDB string literals do not process backslashes, so doubling `'` is the whole escape. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Partition columns, pinned rather than inferred: `month=08` would otherwise stay VARCHAR and
 * `year` would become BIGINT (DUCKDB-FACTS.md).
 */
const HIVE_TYPES = "{'org_id': 'VARCHAR', 'source': 'VARCHAR', 'year': 'INTEGER', 'month': 'INTEGER'}";

/**
 * Envelope fields read from each record, never inferred. `org_id` and `source` are left out on
 * purpose: the record carries its own copies, which collide with the partition columns of the
 * same names. The partition values win in DuckDB even when the record's are declared, so the
 * view takes them from the partition only, the single place the archive layout states them.
 * The timestamps are ISO strings with `Z`, so reading them as TIMESTAMPTZ fixes the instant
 * whatever the session zone; a naive TIMESTAMP would be reinterpreted in it.
 */
const COLUMNS =
  "{'schema': 'VARCHAR', 'source_id': 'VARCHAR', 'occurred_at': 'TIMESTAMPTZ', 'collected_at': 'TIMESTAMPTZ', 'api_version': 'VARCHAR', 'payload': 'JSON'}";

/** What the base relation exposes; listed, never `*`, so a `k=v` segment in the archive root's own path cannot add a column. */
const BASE_COLUMNS = 'schema, org_id, source, source_id, occurred_at, collected_at, api_version, year, month, payload, org_label';

/** `org_label` per org id, inlined. A zero-row `VALUES` is a syntax error, so no labels gives a typed empty relation. */
function labelRelation(orgLabels: Record<string, string | null>): string {
  const entries = Object.entries(orgLabels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) {
    return '(SELECT CAST(NULL AS VARCHAR) AS org_id, CAST(NULL AS VARCHAR) AS org_label WHERE false) AS org_labels';
  }
  // Each label is cast so an all-NULL label column still types as VARCHAR.
  const rows = entries.map(([id, label]) => `(${lit(id)}, CAST(${label === null ? 'NULL' : lit(label)} AS VARCHAR))`);
  return `(VALUES ${rows.join(', ')}) AS org_labels(org_id, org_label)`;
}

/** Every chain-covered record file of the given files, with its org label joined on. */
function baseRelation(paths: string[], labels: string): string {
  const list = `[${paths.map(lit).join(', ')}]`;
  return (
    `SELECT ${BASE_COLUMNS} FROM read_ndjson(${list}, hive_partitioning = true, hive_types = ${HIVE_TYPES}, columns = ${COLUMNS})` +
    ` LEFT JOIN ${labels} USING (org_id)`
  );
}

/**
 * The relation a view's column expressions are evaluated over. `limit_samples` unnests the
 * top-level keys of `payload.limits` and extracts each value by JSON pointer (`~` and `/`
 * escaped), because `->` with a bare key misreads names such as `$x` as paths. Unnesting by key,
 * never inferring a STRUCT, is what lets the key set vary by org (design §4.4).
 */
function stage(view: ViewDefinition, base: string): string {
  if (view.name !== 'limit_samples') return `(${base}) AS src`;
  const rows = `SELECT org_id, org_label, occurred_at, payload, unnest(json_keys(payload->'limits')) AS limit_name FROM (${base}) AS base`;
  return (
    `(SELECT org_id, org_label, occurred_at, payload, limit_name,` +
    ` json_extract(payload->'limits', '/' || replace(replace(limit_name, '~', '~0'), '/', '~1')) AS limit_value` +
    ` FROM (${rows}) AS limit_rows) AS src`
  );
}

/**
 * A source with no files still gets the view, typed identically: DuckDB rejects an empty file
 * list, and a missing view would turn "no data" into a catalog error.
 */
function emptyView(view: ViewDefinition): string {
  const items = view.columns.map((c) => `CAST(NULL AS ${c.type}) AS ${c.name}`).join(', ');
  return `CREATE VIEW ${view.name} AS SELECT ${items} WHERE false`;
}

/**
 * DuckDB treats `*`, `?` and `[...]` inside every `read_ndjson` list entry as a glob, so a
 * user-chosen archive root such as `/x/[prod]/arch` would read different files, or none,
 * instead of exactly the manifest-referenced ones. Bracket-class escaping (`[[]`) does read the
 * literal file, but only before lockdown: once `enable_external_access=false`, DuckDB still
 * treats the escaped entry as a glob and refuses it with a Permission Error. So there is no
 * usable escape, and such paths are rejected. `{` `}` are not expanded by DuckDB 1.5.6 but are
 * rejected with the rest, so no future brace globbing can widen a view.
 */
const GLOB_CHARS = /[*?[\]{}]/;

function assertNoGlob(paths: Iterable<string>): void {
  for (const p of paths) {
    if (GLOB_CHARS.test(p)) {
      throw new Error(
        `Cannot query record file ${p}: its path contains a glob character (* ? [ ] { }), which DuckDB would expand as a pattern instead of reading that file. Move or link the archive to a path without these characters, then re-run.`,
      );
    }
  }
}

/**
 * `CREATE VIEW` statements for every view in `VIEWS`, in order, over exactly the chain-covered
 * files in `files` (design §5.3). Every column is cast to its declared type, so a full view and
 * an empty stand-in describe the same.
 *
 * `timezone` is not emitted: `*_local` columns are TIMESTAMPTZ instants, which the query
 * plugin's renderer prints in `--timezone` (the session TimeZone itself is always UTC).
 * Converting here would yield a naive TIMESTAMP and lose the offset.
 */
export function compileDuckdbViews(input: { files: QueryFiles; timezone: string }): string[] {
  assertNoGlob(Object.values(input.files.bySource).flat());
  const labels = labelRelation(input.files.orgLabels);
  return VIEWS.map((view) => {
    const paths = [...new Set(view.sources.flatMap((s) => input.files.bySource[s] ?? []))].sort();
    if (paths.length === 0) return emptyView(view);
    const items = view.columns.map((c) => {
      const expr = c.expr.duckdb;
      if (expr === undefined) throw new Error(`View ${view.name} column ${c.name} has no duckdb expression.`);
      return `CAST(${expr} AS ${c.type}) AS ${c.name}`;
    });
    return `CREATE VIEW ${view.name} AS SELECT ${items.join(', ')} FROM ${stage(view, baseRelation(paths, labels))}`;
  });
}
