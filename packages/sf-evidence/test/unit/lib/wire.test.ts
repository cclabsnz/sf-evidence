import type { Connection } from '@salesforce/core';
import type { CountedSoqlClient } from '@cclabsnz/sf-evidence-engine';
import { buildClients } from '../../../src/lib/wire.js';

/** A Connection stand-in that answers autoFetchQuery the way jsforce does past maxFetch. */
function conn(result: { totalSize: number; records: unknown[] }, calls: unknown[][]): Connection {
  return {
    autoFetchQuery: async (...args: unknown[]) => {
      calls.push(args);
      return { done: true, ...result };
    },
    query: async () => ({ done: true, ...result }),
  } as unknown as Connection;
}

describe('buildClients', () => {
  it('gives collectors a SOQL client that reports totalSize alongside the rows', async () => {
    const calls: unknown[][] = [];
    const { soql } = buildClients(conn({ totalSize: 12_000, records: [{ Id: 'a' }, { Id: 'b' }] }, calls));
    const counted = soql as CountedSoqlClient;

    expect(typeof counted.queryAllCounted).toBe('function');
    await expect(counted.queryAllCounted('SELECT Id FROM LoginHistory')).resolves.toEqual({
      records: [{ Id: 'a' }, { Id: 'b' }],
      totalSize: 12_000,
    });
    expect(calls[0]![0]).toBe('SELECT Id FROM LoginHistory');
    // Above the 10,000 default, so a busy slice is split less often; totalSize still decides.
    expect((calls[0]![1] as { maxFetch: number }).maxFetch).toBeGreaterThan(10_000);
  });

  it('keeps queryAll returning the rows alone', async () => {
    const { soql } = buildClients(conn({ totalSize: 1, records: [{ Id: 'a' }] }, []));
    await expect(soql.queryAll('SELECT Id FROM Organization')).resolves.toEqual([{ Id: 'a' }]);
  });
});
