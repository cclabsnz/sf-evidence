import { classifyDegradation } from '../lib/errors.js';
import { toIsoMs } from '../lib/time.js';
import { mergeWindows } from '../lib/windows.js';
import type { Degradation, TimeWindow } from '../types/manifest.js';
import type { SourceId } from '../types/record.js';

/** Spec-pinned (SPEC §10.3): below one hour a timed-out slice is recorded, not retried. */
const DEFAULT_FLOOR_MS = 3_600_000;

/**
 * Split a window into calendar-month slices.
 *
 * SetupAuditTrail supports no aggregate queries, so the collector cannot size a window
 * before fetching it. Month slices are the starting grain; `collectSliced` halves any that
 * time out.
 */
export function monthSlices(window: TimeWindow): TimeWindow[] {
  const start = new Date(window.from);
  const end = new Date(window.to);
  const slices: TimeWindow[] = [];

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  if (cursor < start) cursor = start;

  while (cursor < end) {
    const next = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    );
    const sliceEnd = next < end ? next : end;
    slices.push({ from: toIsoMs(cursor), to: toIsoMs(sliceEnd) });
    cursor = sliceEnd;
  }

  return slices;
}

function isQueryTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { errorCode?: unknown }).errorCode === 'QUERY_TIMEOUT'
  );
}

/**
 * Fetch a window month by month, halving any slice that hits QUERY_TIMEOUT (SPEC §10.3).
 *
 * Halves are split at the millisecond midpoint and retried independently. A slice whose
 * halves would be shorter than the floor is recorded as a QUERY_TIMEOUT degradation with its
 * exact bounds, so the gap is explicit and re-collectable. Other recognised errors are
 * recorded against the slice without retry; unrecognised errors propagate.
 *
 * `achieved` is built only from slices whose fetch returned.
 */
export async function collectSliced<T>(
  window: TimeWindow,
  fetchSlice: (slice: TimeWindow) => Promise<T[]>,
  opts: { source: SourceId; floorMs?: number },
): Promise<{ rows: T[]; achieved: TimeWindow[]; degradations: Degradation[] }> {
  const floorMs = opts.floorMs ?? DEFAULT_FLOOR_MS;
  const rows: T[] = [];
  const succeeded: TimeWindow[] = [];
  const degradations: Degradation[] = [];

  const run = async (slice: TimeWindow): Promise<void> => {
    try {
      // A loop, not push(...rows): spreading a large slice as call arguments overflows the stack.
      for (const row of await fetchSlice(slice)) rows.push(row);
      succeeded.push(slice);
      return;
    } catch (err) {
      const d = classifyDegradation(err, opts.source);
      // An unrecognised failure must not be recorded as reduced coverage.
      if (!d) throw err;

      if (isQueryTimeout(err)) {
        const from = Date.parse(slice.from);
        const half = Math.floor((Date.parse(slice.to) - from) / 2);
        if (half >= floorMs) {
          const mid = toIsoMs(new Date(from + half));
          await run({ from: slice.from, to: mid });
          await run({ from: mid, to: slice.to });
          return;
        }
      }
      degradations.push({ ...d, window: slice });
    }
  };

  for (const slice of monthSlices(window)) await run(slice);

  return { rows, achieved: mergeWindows(succeeded), degradations };
}
