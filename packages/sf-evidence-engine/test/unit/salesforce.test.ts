import { resolveOrgId, ORG_ID_QUERY, API_VERSION } from '../../src/salesforce.js';
import { buildExplanation } from '../../src/lib/explainReport.js';
import { LocalSink } from '../../src/sinks/local.js';
import type { SoqlClient } from '@cclabsnz/sf-core';

function soqlReturning(rows: Array<{ Id: string }>, seen: string[]): SoqlClient {
  return {
    query: async (soql: string) => {
      seen.push(soql);
      return { totalSize: rows.length, done: true, records: rows };
    },
    queryAll: (async () => []) as SoqlClient['queryAll'],
  } as unknown as SoqlClient;
}

describe('resolveOrgId', () => {
  it('issues its query through the SoqlClient, not around it', async () => {
    // It used to go direct to the raw Connection, which meant a reviewer who audited with
    // `explain` and then watched the org's API log saw an undisclosed query — and made the
    // "every collector shares one SoqlClient constructed in wire.ts" assertion false of
    // wire.ts itself.
    const seen: string[] = [];
    const id = await resolveOrgId(soqlReturning([{ Id: '00D5j000000AbCdEAK' }], seen));

    expect(id).toBe('00D5j000000AbCdEAK');
    expect(seen).toEqual([ORG_ID_QUERY.soql]);
  });

  it('fails loudly rather than partitioning the archive under an empty org id', async () => {
    await expect(resolveOrgId(soqlReturning([], []))).rejects.toThrow(/Organization record/i);
  });

  it('is listed by explain as a plugin-level query', () => {
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    const match = e.queries.find((q) => q.soql === ORG_ID_QUERY.soql);
    expect(match).toBeDefined();
    expect(match!.scope).toBe('plugin');
  });
});

describe('API_VERSION', () => {
  it('is pinned, never floated', () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
