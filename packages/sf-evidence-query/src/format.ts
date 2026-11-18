/**
 * Output rendering for `sf evidence query` (design §5.2): JSON value conversion, and the
 * table, CSV and NDJSON line formats. Pure functions over what `QuerySession.run` returns; the
 * command decides which rows reach them.
 */

export interface Column {
  name: string;
  /** DuckDB's type text, e.g. `BIGINT`, `DECIMAL(18,3)`, `BIGINT[]`. */
  type: string;
}

export type OutputFormat = 'table' | 'json' | 'csv' | 'ndjson';

/** The DuckDB integer types `getRowObjectsJson` renders as strings, because they can exceed 2^53. */
const WIDE_INTEGER = new Set(['BIGINT', 'UBIGINT', 'HUGEINT', 'UHUGEINT']);
const DECIMAL = /^DECIMAL\(\d+,\d+\)$/;
/** A LIST (`T[]`) or fixed-size ARRAY (`T[n]`) of `T`. */
const LIST = /^(.*)\[\d*\]$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function integerValue(s: string): number | string {
  if (!/^-?\d+$/.test(s)) return s;
  const n = BigInt(s);
  return n <= MAX_SAFE && n >= -MAX_SAFE ? Number(n) : s;
}

/**
 * A DECIMAL becomes a number only when nothing is lost: the number's shortest decimal text is
 * the same value as DuckDB's text (trailing fractional zeros aside). `0.1` round-trips and
 * converts; `12345678901234567.89` would print back as `12345678901234568` and stays a string.
 * Values JS would print in exponent form stay strings too, which errs on the side of exactness.
 */
function decimalValue(s: string): number | string {
  const m = /^(-?)(\d+)(?:\.(\d*?)0*)?$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac] = m;
  const canonical = `${int === '0' && !frac ? '' : sign}${int}${frac ? `.${frac}` : ''}`;
  const n = Number(s);
  return String(n) === canonical ? n : s;
}

/** One value as JSON should carry it, chosen by the column's declared type, never by the string's shape. */
function jsonValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (WIDE_INTEGER.has(type)) return typeof value === 'string' ? integerValue(value) : value;
  if (DECIMAL.test(type)) return typeof value === 'string' ? decimalValue(value) : value;
  const list = LIST.exec(type);
  if (list && Array.isArray(value)) return value.map((v) => jsonValue(list[1]!, v));
  // STRUCT and MAP members are left as DuckDB rendered them (wide integers stay strings there).
  return value;
}

/**
 * Rows with wide integers and decimals converted to numbers where that is exact (design §5.2:
 * "BIGINT values become numbers when safe and strings otherwise"). Timestamps are already
 * ISO-8601 text from the session.
 */
export function toJsonRows(columns: Column[], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const c of columns) out[c.name] = jsonValue(c.type, row[c.name]);
    return out;
  });
}

/** A value as cell text: NULL is empty, nested values are their JSON. */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** RFC 4180: a field holding a comma, a quote, CR or LF is quoted, with quotes doubled. */
function csvField(value: unknown): string {
  const s = text(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV lines, header first, even for zero rows, so "no rows" is distinguishable from "no output".
 * Records are joined by the caller's line output (LF), not RFC 4180's CRLF; a quoted field may
 * itself contain line breaks.
 */
export function csvLines(columns: Column[], rows: Record<string, unknown>[]): string[] {
  return [
    columns.map((c) => csvField(c.name)).join(','),
    ...rows.map((row) => columns.map((c) => csvField(row[c.name])).join(',')),
  ];
}

export function ndjsonLines(rows: Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row));
}

/**
 * An aligned plain-text table: header, rule, rows. Not `SfCommand.table`, which writes to
 * stdout past `this.log`. Line breaks inside a cell are shown as `\n` so one row stays one line.
 */
export function tableLines(columns: Column[], rows: Record<string, unknown>[]): string[] {
  const cell = (v: unknown): string => text(v).replace(/\r?\n/g, '\\n');
  const body = rows.map((row) => columns.map((c) => cell(row[c.name])));
  const widths = columns.map((c, i) => Math.max(c.name.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((s, i) => s.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(columns.map((c) => c.name)), line(widths.map((w) => '─'.repeat(w))), ...body.map(line)];
}
