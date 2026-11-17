import type { RestClient } from '@cclabsnz/sf-core';
import { limitFigures, readLimitsBody } from '../lib/limits.js';

/** Below this many remaining daily API requests a long collection is refused (R8). */
const MIN_FLOOR = 5000;
const FLOOR_FRACTION = 0.1;

export type ApiBudgetCheck = { ok: true } | { ok: false; remaining: number; floor: number };

/**
 * A floor must be a finite number of requests, zero or more. `remaining < NaN` is always false,
 * so an unvalidated NaN would pass the guard and be reported as a budget that was checked.
 */
export function assertValidFloor(floor: number | undefined): void {
  if (floor !== undefined && (!Number.isFinite(floor) || floor < 0)) {
    throw new Error(`The API budget floor must be a finite number of requests, 0 or more; got ${String(floor)}.`);
  }
}

/**
 * Whether the org has enough daily API budget left to start a long collection (SPEC.md §10.3).
 *
 * The default floor is `max(5000, 0.1 × Max)`; `floor` overrides it. With no REST client there
 * is nothing to read, so it returns `{ ok: true }` and the caller records that the budget was
 * not checked. A floor that is not a finite number of 0 or more throws. If `GET /limits/`
 * fails, or the body has no usable `DailyApiRequests`, this throws: it cannot say whether the
 * budget is fine, and `{ ok: true }` would claim it is.
 */
export async function checkApiBudget(rest: RestClient | undefined, floor?: number): Promise<ApiBudgetCheck> {
  assertValidFloor(floor);
  if (!rest) return { ok: true };
  const figures = limitFigures(await readLimitsBody(rest), 'DailyApiRequests');
  if (!figures) {
    throw new Error('GET /limits/ has no numeric DailyApiRequests.Max and .Remaining; the API budget cannot be checked.');
  }
  const effective = floor ?? Math.max(MIN_FLOOR, FLOOR_FRACTION * figures.max);
  return figures.remaining < effective ? { ok: false, remaining: figures.remaining, floor: effective } : { ok: true };
}
