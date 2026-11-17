/** Which clock ended a run's collection windows (SPEC.md §10.8). */
export type CollectionClockSource = 'org' | 'local';

export interface CollectionClock {
  /** Pass to `runCollect` as `now`: the earlier of the local and org clocks when the org's was read. */
  now: Date;
  /** `org` when the org clock was read (whichever clock was earlier), `local` when it could not be. */
  clock: CollectionClockSource;
  /** Why the org clock could not be read; present exactly when `clock` is `local`. */
  clockNote?: string;
}

/**
 * The instant a run's collection windows end at.
 *
 * A local clock that runs ahead of the org would end a window at an instant the org has not
 * reached, and the next run, overlapping by only 15 minutes, would never query the events in
 * between. So the window ends at the earlier of the two clocks. A clock behind the org only
 * delays coverage, which the next run's overlap absorbs.
 *
 * Never throws: when the org clock cannot be read, the local clock is used and `clock: 'local'`
 * says so, for the host to surface.
 */
export async function collectionClock(
  localNow: Date,
  readOrgNow: (() => Promise<Date>) | undefined,
): Promise<CollectionClock> {
  if (!readOrgNow) return { now: localNow, clock: 'local', clockNote: 'no org clock reader was supplied.' };
  let orgNow: Date;
  try {
    orgNow = await readOrgNow();
  } catch (err) {
    return { now: localNow, clock: 'local', clockNote: err instanceof Error ? err.message : String(err) };
  }
  if (!(orgNow instanceof Date) || Number.isNaN(orgNow.getTime())) {
    return { now: localNow, clock: 'local', clockNote: 'the org clock reading was not a valid date.' };
  }
  return { now: orgNow < localNow ? orgNow : localNow, clock: 'org' };
}
