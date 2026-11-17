import { toIsoMs, monthKey, toSoqlDateTime } from '../../../src/lib/time.js';

describe('toIsoMs', () => {
  it('normalises a Salesforce timestamp to UTC ISO-8601 with millisecond precision', () => {
    expect(toIsoMs('2026-08-14T02:11:09.000+0000')).toBe('2026-08-14T02:11:09.000Z');
  });

  it('adds millisecond precision when the source omits it', () => {
    expect(toIsoMs('2026-08-14T02:11:09Z')).toBe('2026-08-14T02:11:09.000Z');
  });

  it('converts a non-UTC offset to UTC rather than preserving it', () => {
    expect(toIsoMs('2026-08-14T14:11:09.000+1200')).toBe('2026-08-14T02:11:09.000Z');
  });

  it('rejects an unparseable value rather than silently producing Invalid Date', () => {
    expect(() => toIsoMs('not a date')).toThrow(/unparseable timestamp/i);
  });
});

describe('toSoqlDateTime', () => {
  it('strips milliseconds, which SOQL dateTime literals do not accept', () => {
    // Salesforce documents exactly three WHERE-clause dateTime formats:
    // YYYY-MM-DDThh:mm:ss+hh:mm, -hh:mm, and Z. None carries .sss, and sending
    // milliseconds risks MALFORMED_QUERY. No unit test hits a live org, so this
    // helper is the only thing standing between the collector and a broken query.
    expect(toSoqlDateTime('2026-06-01T00:00:00.000Z')).toBe('2026-06-01T00:00:00Z');
  });

  it('leaves an already-secondless timestamp untouched', () => {
    expect(toSoqlDateTime('2026-06-01T00:00:00Z')).toBe('2026-06-01T00:00:00Z');
  });

  it('emits no quotes — SOQL dateTime literals are unquoted', () => {
    expect(toSoqlDateTime('2026-06-01T00:00:00.000Z')).not.toContain("'");
  });
});

describe('monthKey', () => {
  it('extracts zero-padded year and month for Hive partitioning', () => {
    expect(monthKey('2026-08-14T02:11:09.000Z')).toEqual({ year: '2026', month: '08' });
  });

  it('uses the UTC month, not the local one', () => {
    // 2026-08-31T23:30Z is 1 September in NZ. The archive partitions by UTC.
    expect(monthKey('2026-08-31T23:30:00.000Z')).toEqual({ year: '2026', month: '08' });
  });
});
