/**
 * Resolves a `--since` (or `--until`) value to an absolute UTC timestamp.
 *
 * Two shapes are accepted, and only these: an ISO date or datetime, and an ISO-8601 duration
 * counted in days and/or hours (`P30D`, `PT12H`, `P1DT12H`). Months and years are refused
 * because they have no fixed length, and minutes and seconds because nothing here collects
 * at that grain. A datetime must carry a zone: without one it would be read in the machine's
 * local time, and the same command would collect a different window on a different host.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DURATION = /^P(?:(\d+)D)?(?:T(\d+)H)?$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function bad(value: string, why: string, flag: string): Error {
  return new Error(
    `Invalid ${flag} '${value}': ${why} Use an ISO date or datetime with a zone (2026-01-01, ` +
      '2026-01-01T00:00:00Z) or a duration in days or hours (P30D, PT12H).',
  );
}

export function resolveSince(value: string, now: Date, flag = '--since'): string {
  if (/^P/.test(value)) {
    if (/^P[\d.]*[MY]/.test(value) || /^P\d+W/.test(value)) {
      throw bad(value, 'months, years and weeks are ambiguous or unsupported; only days and hours are accepted.', flag);
    }
    const m = DURATION.exec(value);
    if (!m || (m[1] === undefined && m[2] === undefined)) {
      throw bad(value, 'not a duration of days and/or hours.', flag);
    }
    const ms = Number(m[1] ?? 0) * DAY_MS + Number(m[2] ?? 0) * HOUR_MS;
    return new Date(now.getTime() - ms).toISOString();
  }

  if (DATE.test(value) || DATETIME.test(value)) {
    const d = new Date(value);
    // V8 rolls 2026-02-31 over to March 3rd instead of rejecting it; a typo must not move the window.
    const [y, mo, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
    const calendar = new Date(Date.UTC(y, mo - 1, day));
    const real = calendar.getUTCFullYear() === y && calendar.getUTCMonth() === mo - 1 && calendar.getUTCDate() === day;
    if (real && !Number.isNaN(d.getTime())) return d.toISOString();
  }
  throw bad(value, 'not an ISO date, a zoned ISO datetime or a duration.', flag);
}

/**
 * `collect --since` and `--until`, resolved by the same rules and checked against `now`.
 *
 * Throws on a value `resolveSince` will not interpret, on either bound later than `now` (a
 * window into the future would be recorded as coverage of time that has not happened), and on
 * `since` after `until`. Every message names the flag, so a host can report it as a usage error.
 */
export function resolveCollectBounds(
  flags: { since?: string; until?: string },
  now: Date,
): { since: string | undefined; until: string | undefined } {
  const nowIso = now.toISOString();
  const resolve = (flag: '--since' | '--until', value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const iso = resolveSince(value, now, flag);
    if (iso > nowIso) throw new Error(`${flag} '${value}' is later than now (${nowIso}); nothing after now can be collected.`);
    return iso;
  };
  const since = resolve('--since', flags.since);
  const until = resolve('--until', flags.until);
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error(`--since '${flags.since}' is after --until '${flags.until}'; the window would be empty.`);
  }
  return { since, until };
}
