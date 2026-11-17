import { collectionClock } from '../../../src/pipeline/collectionClock.js';

/**
 * SPEC.md §10.8: a window ending at a local clock that runs ahead of the org claims coverage of
 * instants the org has not reached, and the next run's 15-minute overlap never re-queries them.
 */
describe('collectionClock', () => {
  const local = new Date('2026-08-15T09:00:00.000Z');

  it('ends at the org clock when the local clock runs ahead of it', async () => {
    const org = new Date('2026-08-15T08:50:00.000Z');
    expect(await collectionClock(local, async () => org)).toEqual({ now: org, clock: 'org' });
  });

  it('ends at the local clock when it is behind the org, and still says the org clock was read', async () => {
    const org = new Date('2026-08-15T09:10:00.000Z');
    expect(await collectionClock(local, async () => org)).toEqual({ now: local, clock: 'org' });
  });

  it('falls back to the local clock, and says why, when the org clock cannot be read', async () => {
    const out = await collectionClock(local, async () => {
      throw new Error('no Date header');
    });
    expect(out).toEqual({ now: local, clock: 'local', clockNote: 'no Date header' });
  });

  it('uses the local clock when the host has no way to read the org clock', async () => {
    const out = await collectionClock(local, undefined);
    expect(out.now).toBe(local);
    expect(out.clock).toBe('local');
    expect(out.clockNote).toMatch(/no org clock reader/i);
  });

  it('rejects an org clock that is not a valid date rather than ending a window at NaN', async () => {
    const out = await collectionClock(local, async () => new Date('nonsense'));
    expect(out.clock).toBe('local');
    expect(out.now).toBe(local);
  });
});
