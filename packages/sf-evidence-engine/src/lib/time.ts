/**
 * Timestamp normalisation. Every timestamp in the archive is UTC, ISO-8601, millisecond
 * precision, `Z`-suffixed (SPEC.md §4.1) — so that lexical string ordering equals
 * chronological ordering and no consumer has to parse an offset.
 */

/** Normalise any parseable timestamp to `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export function toIsoMs(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable timestamp: ${String(value)}`);
  }
  return d.toISOString();
}

/**
 * Render an ISO timestamp as a SOQL dateTime literal.
 *
 * Salesforce documents exactly three accepted WHERE-clause dateTime formats —
 * `YYYY-MM-DDThh:mm:ss+hh:mm`, `YYYY-MM-DDThh:mm:ss-hh:mm`, and `YYYY-MM-DDThh:mm:ssZ`.
 * None includes milliseconds, so the archive's millisecond-precision timestamps must be
 * trimmed before they reach a query. Literals are unquoted.
 */
export function toSoqlDateTime(iso: string): string {
  return toIsoMs(iso).replace(/\.\d{3}Z$/, 'Z');
}

/** Hive partition components for an ISO timestamp, in UTC. */
export function monthKey(iso: string): { year: string; month: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable timestamp: ${iso}`);
  }
  return {
    year: String(d.getUTCFullYear()).padStart(4, '0'),
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
  };
}

const HOUR_MS = 3_600_000;

/** The UTC hour containing `value`, as the half-open window `[hourStart, hourStart + 1h)`. */
export function hourWindow(value: string | Date): { from: string; to: string } {
  const ms = new Date(toIsoMs(value)).getTime();
  const start = ms - (ms % HOUR_MS);
  return { from: new Date(start).toISOString(), to: new Date(start + HOUR_MS).toISOString() };
}
