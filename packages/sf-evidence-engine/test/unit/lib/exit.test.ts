import { EXIT } from '../../../src/lib/exit.js';

describe('EXIT', () => {
  it('matches the exit-code table in SPEC.md §8.0', () => {
    expect(EXIT).toEqual({
      OK: 0,
      ERROR: 1,
      USAGE: 2,
      INTEGRITY: 3,
      DEGRADED: 4,
      LICENCE: 5,
    });
  });

  it('is frozen so a command cannot mutate the contract at runtime', () => {
    expect(Object.isFrozen(EXIT)).toBe(true);
  });
});
