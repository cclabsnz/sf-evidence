import { DAY_MS } from '../archive/coverage.js';
import { toIsoMs } from '../lib/time.js';
import type { TimeWindow } from '../types/manifest.js';
import type { SourceId } from '../types/record.js';

/** How much event time one commit round collects: one manifest per round. */
export const ROUND_MS = 7 * DAY_MS;

export interface RoundPlanInput {
  source: SourceId;
  kind: 'event' | 'snapshot';
  windows: TimeWindow[];
}

export interface RoundEntry {
  source: SourceId;
  windows: TimeWindow[];
}

/**
 * Splits one run's plan into commit rounds, in chain order.
 *
 * The origin is the earliest `from` across every event window of this run (not a calendar
 * boundary). Round k covers `[origin + k·ROUND_MS, origin + (k+1)·ROUND_MS)`; each event
 * window is cut at those boundaries and each piece goes to its round. Rounds no piece falls in
 * are dropped. A zero-length window (planned when there is nothing left to query) goes to the
 * round that ends at or contains its instant, so it never opens a round of its own past the
 * others. Snapshot sources, which can only sample now, go in the last round; with no event
 * windows at all there is one round holding them. Within a round, sources keep input order.
 */
export function planRounds(plans: RoundPlanInput[]): RoundEntry[][] {
  const events = plans.filter((p) => p.kind === 'event');
  const snapshots = plans.filter((p) => p.kind === 'snapshot');
  const eventWindows = events.flatMap((p) => p.windows);
  if (eventWindows.length === 0) {
    return [snapshots.map((p) => ({ source: p.source, windows: p.windows }))];
  }

  const origin = Math.min(...eventWindows.map((w) => Date.parse(w.from)));
  const byRound = new Map<number, Map<SourceId, TimeWindow[]>>();
  const add = (k: number, source: SourceId, w: TimeWindow): void => {
    let round = byRound.get(k);
    if (!round) byRound.set(k, (round = new Map()));
    const list = round.get(source);
    if (list) list.push(w);
    else round.set(source, [w]);
  };

  for (const plan of events) {
    for (const w of plan.windows) {
      const from = Date.parse(w.from);
      const to = Date.parse(w.to);
      if (to <= from) {
        add(Math.max(0, Math.ceil((from - origin) / ROUND_MS) - 1), plan.source, w);
        continue;
      }
      for (let k = Math.floor((from - origin) / ROUND_MS); origin + k * ROUND_MS < to; k += 1) {
        const start = origin + k * ROUND_MS;
        const end = start + ROUND_MS;
        add(k, plan.source, {
          from: from >= start ? w.from : toIsoMs(new Date(start)),
          to: to <= end ? w.to : toIsoMs(new Date(end)),
        });
      }
    }
  }

  const order = new Map(plans.map((p, i) => [p.source, i]));
  const rounds = [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, round]) =>
      [...round.entries()]
        .map(([source, windows]) => ({ source, windows }))
        .sort((a, b) => order.get(a.source)! - order.get(b.source)!),
    );
  rounds.at(-1)!.push(...snapshots.map((p) => ({ source: p.source, windows: p.windows })));
  return rounds;
}
