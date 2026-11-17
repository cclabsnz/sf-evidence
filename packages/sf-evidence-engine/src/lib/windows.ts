import type { TimeWindow } from '../types/manifest.js';

/** Sort by `from`, then merge windows that touch or overlap; leave gaps as separate entries. */
export function mergeWindows(windows: readonly TimeWindow[]): TimeWindow[] {
  const sorted = [...windows].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged: TimeWindow[] = [];

  for (const w of sorted) {
    const last = merged.at(-1);
    if (last && w.from <= last.to) {
      if (w.to > last.to) last.to = w.to;
    } else {
      merged.push({ ...w });
    }
  }

  return merged;
}
