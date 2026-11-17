import { newRunId } from '../../../src/lib/ulid.js';

describe('newRunId', () => {
  it('is 26 characters of Crockford base32', () => {
    expect(newRunId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexically by creation time', () => {
    const a = newRunId(1_786_867_200_000);
    const b = newRunId(1_786_867_200_001);
    expect(a < b).toBe(true);
  });

  it('produces distinct ids within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRunId(1_786_867_200_000)));
    expect(ids.size).toBe(200);
  });
});
