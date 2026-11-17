import { DAY_MS } from '../archive/coverage.js';
import type { StatusRow } from '../archive/status.js';
import type { TimeWindow } from '../types/manifest.js';

/**
 * Text rendering for `sf evidence status` (SPEC.md §8.4), kept out of the command so every
 * line it prints is reachable by a unit test without constructing an oclif command.
 *
 * It renders only what the rows carry. Rows come from `assessStatus`, which makes every
 * decision; nothing here recomputes or rounds a value in a way that would claim more coverage
 * than was assessed.
 */

const NAME_WIDTH = 16;
const INDENT = ' '.repeat(NAME_WIDTH);
const HOUR_MS = 3_600_000;

/**
 * An instant, as short as it can be without losing anything: the date alone at midnight UTC,
 * `HH:MMZ` on a whole minute, otherwise the full time. Truncating `09:00:12Z` to `09:00Z` on
 * a coverage line would claim twelve seconds no run covered.
 */
export function formatInstant(iso: string): string {
  const [date, time = ''] = iso.split('T');
  if (/^00:00:00(\.0+)?Z$/.test(time)) return date!;
  if (/^\d\d:\d\d:00(\.0+)?Z$/.test(time)) return `${date} ${time.slice(0, 5)}Z`;
  return `${date} ${time}`;
}

const interval = (w: TimeWindow): string => `${formatInstant(w.from)} → ${formatInstant(w.to)}`;

/** `15d 8h`. Floored to the hour, so headroom is never overstated. */
function formatHeadroom(seconds: number): string {
  const hours = Math.floor((seconds * 1000) / HOUR_MS);
  const sign = hours < 0 ? '-' : '';
  const abs = Math.abs(hours);
  return `${sign}${Math.floor(abs / 24)}d ${abs % 24}h`;
}

/** A span rounded up, so time not yet collected is never understated. */
function formatSpan(w: TimeWindow): string {
  const ms = Date.parse(w.to) - Date.parse(w.from);
  if (ms >= DAY_MS) return `${Math.ceil(ms / DAY_MS)}d`;
  if (ms >= HOUR_MS) return `${Math.ceil(ms / HOUR_MS)}h`;
  return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
}

/** Column the right-hand note starts at: past the widest interval two minute-precision instants make. */
const NOTE_COLUMN = 64;

/** `label` padded into the detail column, then the value, then an optional right-hand note. */
function detail(label: string, value: string, note = ''): string {
  const head = `${INDENT}${label.padEnd(8)} ${value}`;
  return note === '' ? head : `${head.padEnd(NOTE_COLUMN - 1)} ${note}`;
}

function headerLine(row: StatusRow): string {
  const unit = row.kind === 'snapshot' ? 'samples' : 'records';
  const lastRun = row.lastRun === null ? 'never' : formatInstant(row.lastRun);
  const count = `${row.recordCount.toLocaleString('en-NZ')} ${unit}`;
  return `${row.source.padEnd(NAME_WIDTH - 1)} last run ${lastRun}   ${count}`;
}

/**
 * The coverage line for a source with no coverage in the evaluated window. "Nothing collected
 * yet" only when no run recorded a `complete` or `partial` entry, the only statuses the collect
 * pipeline writes achieved coverage on; otherwise what it holds lies outside the window.
 */
function noCoverage(row: StatusRow): string {
  const everCovered = row.statuses.complete + row.statuses.partial > 0;
  return everCovered ? 'NONE inside the evaluated window' : 'NONE: nothing collected yet';
}

function renderUnassessed(row: StatusRow & { kind: null }): string[] {
  const out: string[] = [];
  for (const w of row.coverage) out.push(detail('coverage', interval(w)));
  if (row.coverage.length === 0) out.push(detail('coverage', noCoverage(row)));
  out.push(
    `${INDENT}not assessed: no collector for this source in this release, so its retention ` +
      'window is unknown and gaps and headroom were not computed.',
  );
  return out;
}

function renderSnapshot(row: StatusRow & { kind: 'snapshot' }): string[] {
  const out: string[] = [];
  // A snapshot is a point reading: samples held and the newest one, never a covered range.
  const newest = row.lastWritten === null ? 'none' : formatInstant(row.lastWritten);
  out.push(detail('samples', `${row.recordCount.toLocaleString('en-NZ')}   newest ${newest}`, '(snapshot source; no backfill possible)'));
  out.push(detail('headroom', 'n/a', row.stale ? 'STALE' : 'OK'));
  return out;
}

function renderEvent(row: StatusRow & { kind: 'event' }, windowDays: number): string[] {
  const out: string[] = [];

  if (row.coverage.length === 0) {
    // Never a tidy pending line: with no coverage at all there is no "last covered instant"
    // for the uncollected time to be pending from.
    out.push(detail('coverage', noCoverage(row)));
  } else {
    // Coverage and gaps interleaved in time order, one line each: a gap is shown where it is,
    // and two intervals are never collapsed into one span.
    const lines: Array<{ at: string; text: string }> = [];
    const complete = row.gaps.length === 0 && row.pending === null && row.lost.length === 0;
    for (const w of row.coverage) {
      const note = complete ? `(${windowDays}d window: complete)` : '';
      lines.push({ at: w.from, text: detail('coverage', interval(w), note) });
    }
    for (const g of row.gaps) {
      lines.push({ at: g.from, text: detail('GAP', interval(g), `(${g.days}d)`) });
    }
    lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    for (const l of lines) out.push(l.text);
    if (row.pending) {
      out.push(detail('pending', interval(row.pending), `(${formatSpan(row.pending)} not yet collected)`));
    }
  }

  for (const w of row.lost) {
    out.push(detail('lost', interval(w), '(destroyed by Salesforce; not recoverable)'));
  }

  out.push(detail('headroom', formatHeadroom(row.headroomSeconds!), row.atRisk ? 'AT RISK' : 'OK'));
  if (row.atRisk && row.destroyedAfter !== null) {
    const oldest = new Date(Date.parse(row.destroyedAfter) - row.retentionDays * DAY_MS).toISOString();
    out.push(
      `${INDENT}→ the ${oldest.slice(0, 10)} window is destroyed on ${row.destroyedAfter.slice(0, 10)}. Collect now.`,
    );
  }
  return out;
}

/**
 * `windowDays` is the evaluation window the rows were assessed over (`status --window`); it
 * defaults to each source's retention, as `assessCoverage` does, and is only ever used to name
 * the window a source is complete for. `orgId` and `archive` name what an empty report looked
 * in, so a mistyped one is visible.
 */
export function formatStatus(
  rows: readonly StatusRow[],
  opts: { windowDays?: number; orgId?: string; archive?: string } = {},
): string[] {
  if (rows.length === 0) {
    const where = opts.orgId === undefined ? 'for this org' : `for ${opts.orgId}`;
    const archive = opts.archive === undefined ? '' : ` in ${opts.archive}`;
    return [
      `No data archived ${where}${archive}. Confirm --org-id and --archive, or run \`sf evidence collect\` to start.`,
    ];
  }

  const out: string[] = [];
  for (const row of rows) {
    out.push(headerLine(row));
    if (row.kind === null) out.push(...renderUnassessed(row));
    else if (row.kind === 'snapshot') out.push(...renderSnapshot(row));
    else out.push(...renderEvent(row, opts.windowDays ?? row.retentionDays));
    out.push('');
  }
  return out;
}
