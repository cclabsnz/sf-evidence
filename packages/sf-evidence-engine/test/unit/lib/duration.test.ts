import { resolveCollectBounds, resolveSince } from '../../../src/lib/duration.js';

const NOW = new Date('2026-08-15T09:30:00.000Z');

describe('resolveSince', () => {
  it('P30D resolves to 30 days before now', () => {
    expect(resolveSince('P30D', NOW)).toBe('2026-07-16T09:30:00.000Z');
  });

  it('PT12H resolves to 12 hours before now', () => {
    expect(resolveSince('PT12H', NOW)).toBe('2026-08-14T21:30:00.000Z');
  });

  it('accepts days and hours together', () => {
    expect(resolveSince('P1DT12H', NOW)).toBe('2026-08-13T21:30:00.000Z');
  });

  it('rejects P1M (months are ambiguous)', () => {
    expect(() => resolveSince('P1M', NOW)).toThrow(/months/i);
  });

  it.each(['P1Y', 'P1W', 'PT30M', 'PT10S', 'P', 'PT', 'P1DT', 'P-1D', 'P1.5D', 'p30d', '30D'])(
    'rejects %s',
    (v) => {
      expect(() => resolveSince(v, NOW)).toThrow(/--since/);
    },
  );

  it('passes an ISO date through as UTC midnight with milliseconds', () => {
    expect(resolveSince('2026-01-01', NOW)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('normalises an ISO datetime with an offset to UTC', () => {
    expect(resolveSince('2026-01-01T12:00:00+13:00', NOW)).toBe('2025-12-31T23:00:00.000Z');
  });

  it('rejects a datetime with no zone, which would read as the machine\'s local time', () => {
    expect(() => resolveSince('2026-01-01T12:00:00', NOW)).toThrow(/--since/);
  });

  it.each(['yesterday', '', '2026-13-01', '2026-02-31', '1'])('rejects %j', (v) => {
    expect(() => resolveSince(v, NOW)).toThrow(/--since/);
  });
});

describe('resolveCollectBounds', () => {
  it('resolves --since and --until with the same rules', () => {
    expect(resolveCollectBounds({ since: 'P2D', until: 'PT12H' }, NOW)).toEqual({
      since: '2026-08-13T09:30:00.000Z',
      until: '2026-08-14T21:30:00.000Z',
    });
    expect(resolveCollectBounds({}, NOW)).toEqual({ since: undefined, until: undefined });
  });

  it('rejects a bad --until, naming --until', () => {
    expect(() => resolveCollectBounds({ until: '2026-08-01T00:00:00' }, NOW)).toThrow(/Invalid --until/);
    expect(() => resolveCollectBounds({ until: 'P1M' }, NOW)).toThrow(/--until/);
  });

  it('rejects a --since or --until later than now', () => {
    expect(() => resolveCollectBounds({ since: '2026-08-16' }, NOW)).toThrow(/--since .*later than now/);
    expect(() => resolveCollectBounds({ until: '2026-08-15T10:00:00Z' }, NOW)).toThrow(/--until .*later than now/);
  });

  it('accepts --until exactly now', () => {
    expect(resolveCollectBounds({ until: '2026-08-15T09:30:00Z' }, NOW).until).toBe('2026-08-15T09:30:00.000Z');
  });

  it('rejects --since after --until', () => {
    expect(() => resolveCollectBounds({ since: '2026-08-10', until: '2026-08-01' }, NOW)).toThrow(/--since .*after --until/);
  });
});
