import type { QueryResult, SoqlClient } from '@cclabsnz/sf-core';

const HOUR = 3_600_000;

/** The `[from, to)` of a SOQL query's time filter, as epoch ms. */
function boundsOf(soql: string): { from: number; to: number } {
  const m = /(?:CreatedDate|LoginTime) >= (\S+) AND (?:CreatedDate|LoginTime) < (\S+)/.exec(soql);
  if (!m) throw new Error(`no time filter in ${soql}`);
  return { from: Date.parse(m[1]!), to: Date.parse(m[2]!) };
}

export interface CappedOrg {
  soql: SoqlClient;
  /** Every query issued, in order, as its window length in hours. */
  asked: number[];
}

/**
 * A fake org that holds `perHour` rows in every hour and, like jsforce's autoFetch with
 * maxFetch, returns at most `cap` of a query's rows while still reporting the full totalSize.
 *
 * `counted: true` gives the client the engine's `queryAllCounted`, as the sf CLI wiring does;
 * `false` gives only sf-core's plain `SoqlClient`, whose `query` reports `totalSize`.
 */
export function cappedOrg(opts: {
  cap: number;
  perHour?: number;
  counted: boolean;
  row: (id: string, at: string) => Record<string, unknown>;
}): CappedOrg {
  const perHour = opts.perHour ?? 1;
  const asked: number[] = [];
  const all = (soql: string): Array<Record<string, unknown>> => {
    const { from, to } = boundsOf(soql);
    const out: Array<Record<string, unknown>> = [];
    for (let h = Math.ceil(from / HOUR) * HOUR; h < to; h += HOUR) {
      for (let i = 0; i < perHour; i += 1) {
        const n = (h / HOUR) * perHour + i;
        const id = `0Ym${String(n).padStart(12, '0')}AAA`;
        out.push(opts.row(id, new Date(h + i * 1000).toISOString().replace('Z', '+0000')));
      }
    }
    return out;
  };
  const queryAll = async <T>(soql: string): Promise<T[]> => {
    const rows = all(soql);
    asked.push((boundsOf(soql).to - boundsOf(soql).from) / HOUR);
    return rows.slice(0, opts.cap) as T[];
  };
  const query = async <T>(soql: string): Promise<QueryResult<T>> => {
    const rows = all(soql);
    return { totalSize: rows.length, done: rows.length <= 2000, records: rows.slice(0, 2000) as T[] };
  };
  const base = { query, queryAll };
  const soql = opts.counted
    ? {
        ...base,
        queryAllCounted: async <T>(q: string): Promise<{ records: T[]; totalSize: number }> => ({
          records: await queryAll<T>(q),
          totalSize: all(q).length,
        }),
      }
    : base;
  return { soql: soql as SoqlClient, asked };
}
