import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMetadataFiles } from '../../../src/archive/metadata.js';
import { LocalSink } from '../../../src/sinks/local.js';
import { runCollect } from '../../../src/pipeline/runCollect.js';
import { ORG_ID } from '../../../src/testing/specVectors.js';
import { ORG_INFO_QUERY, resolveOrgInfo } from '../../../src/salesforce.js';
import { buildExplanation } from '../../../src/lib/explainReport.js';
import type { SoqlClient } from '@cclabsnz/sf-core';

const INFO = {
  id: ORG_ID,
  name: 'Acme',
  edition: 'Enterprise Edition',
  instance: 'AP5',
  isSandbox: false,
};
const PRODUCER = { name: '@cclabsnz/sf-evidence', version: '0.1.0' };
const T1 = '2026-08-15T09:00:00.000Z';
const T2 = '2026-08-16T09:00:00.000Z';

const args = (over: Partial<Parameters<typeof buildMetadataFiles>[0]> = {}) => ({
  orgInfo: INFO,
  instanceUrl: 'https://acme.my.salesforce.com',
  apiVersion: '67.0',
  producer: PRODUCER,
  existing: { archive: null, org: null },
  now: T1,
  ...over,
});

const text = (b: Buffer) => JSON.parse(b.toString('utf8')) as Record<string, unknown>;

describe('buildMetadataFiles', () => {
  it('writes archive.json once and never rewrites it', () => {
    const first = buildMetadataFiles(args());
    const archive = first.find((f) => f.relPath === 'archive.json')!;
    expect(text(archive.bytes)).toEqual({
      format: 'sf-evidence/archive/v1',
      created_at: T1,
      producer: PRODUCER,
    });

    const again = buildMetadataFiles(
      args({
        now: T2,
        producer: { name: PRODUCER.name, version: '9.9.9' },
        existing: { archive: archive.bytes.toString('utf8'), org: null },
      }),
    );
    expect(again.find((f) => f.relPath === 'archive.json')).toBeUndefined();
  });

  it('writes org.json under the org partition with the specified fields', () => {
    const org = buildMetadataFiles(args()).find((f) => f.relPath === `org_id=${ORG_ID}/org.json`)!;
    expect(text(org.bytes)).toEqual({
      org_id: ORG_ID,
      name: 'Acme',
      edition: 'Enterprise Edition',
      instance: 'AP5',
      is_sandbox: false,
      instance_url: 'https://acme.my.salesforce.com',
      api_version: '67.0',
      first_seen: T1,
    });
    expect(org.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does not rewrite org.json when nothing but time has moved', () => {
    const org = buildMetadataFiles(args()).find((f) => f.relPath.endsWith('org.json'))!;
    const again = buildMetadataFiles(
      args({ now: T2, existing: { archive: null, org: org.bytes.toString('utf8') } }),
    );
    expect(again.find((f) => f.relPath.endsWith('org.json'))).toBeUndefined();
  });

  it('rewrites org.json when the org is renamed and keeps first_seen', () => {
    const org = buildMetadataFiles(args()).find((f) => f.relPath.endsWith('org.json'))!;
    const again = buildMetadataFiles(
      args({
        now: T2,
        orgInfo: { ...INFO, name: 'Acme Holdings' },
        existing: { archive: null, org: org.bytes.toString('utf8') },
      }),
    ).find((f) => f.relPath.endsWith('org.json'))!;
    expect(text(again.bytes)).toMatchObject({ name: 'Acme Holdings', first_seen: T1 });
  });
});

describe('resolveOrgInfo and explain', () => {
  const soql = (rows: unknown[], seen: string[] = []) =>
    ({
      query: async (q: string) => {
        seen.push(q);
        return { totalSize: rows.length, done: true, records: rows };
      },
      queryAll: (async () => []) as SoqlClient['queryAll'],
    }) as unknown as SoqlClient;

  it('maps the Organization row', async () => {
    const seen: string[] = [];
    const info = await resolveOrgInfo(
      soql(
        [{ Id: ORG_ID, Name: 'Acme', OrganizationType: 'Enterprise Edition', InstanceName: 'AP5', IsSandbox: false }],
        seen,
      ),
    );
    expect(info).toEqual(INFO);
    expect(seen).toEqual([ORG_INFO_QUERY.soql]);
  });

  it('is listed by explain as a plugin-scope query', () => {
    const e = buildExplanation({
      sources: ['audit-trail'],
      sinks: [new LocalSink('/tmp/archive')],
      instanceUrl: 'https://example.my.salesforce.com',
    });
    expect(e.queries.find((q) => q.soql === ORG_INFO_QUERY.soql)?.scope).toBe('plugin');
  });
});

describe('runCollect metadata', () => {
  let root: string;
  let sink: LocalSink;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-meta-'));
    sink = new LocalSink(root);
    await sink.init();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const orgRow = (name: string) => ({
    Id: ORG_ID, Name: name, OrganizationType: 'Enterprise Edition', InstanceName: 'AP5', IsSandbox: false,
  });
  const client = (name: string, fail = false) =>
    ({
      query: async () => {
        if (fail) throw new Error('boom');
        return { totalSize: 1, done: true, records: [orgRow(name)] };
      },
      queryAll: (async () => []) as SoqlClient['queryAll'],
    }) as unknown as SoqlClient;
  const run = (name: string, now: string, fail = false) =>
    runCollect({
      orgId: ORG_ID,
      sources: ['audit-trail'],
      sinks: [sink],
      soql: client(name, fail),
      instanceUrl: 'https://acme.my.salesforce.com',
      now: new Date(now),
    });

  it('writes both files on the first run, lists them in the manifest, and reports no orphans', async () => {
    const result = await run('Acme', T1);
    const manifest = (await sink.readManifest(ORG_ID, 1))!;
    expect(manifest.metadata?.map((m) => m.path).sort()).toEqual([
      'archive.json',
      `org_id=${ORG_ID}/org.json`,
    ]);
    expect((await sink.listOrphans(ORG_ID)).map((o) => o.relPath)).toEqual([]);
    expect(result.metadata.written.sort()).toEqual(['archive.json', `org_id=${ORG_ID}/org.json`]);
  });

  it('writes nothing new on an unchanged second run, and omits the metadata key', async () => {
    await run('Acme', T1);
    await run('Acme', T2);
    const second = (await sink.readManifest(ORG_ID, 2))!;
    expect(second.metadata).toBeUndefined();
  });

  it('rewrites org.json after a rename and keeps first_seen', async () => {
    await run('Acme', T1);
    await run('Acme Holdings', T2);
    const org = JSON.parse(await readFile(join(root, `org_id=${ORG_ID}`, 'org.json'), 'utf8'));
    expect(org).toMatchObject({ name: 'Acme Holdings', first_seen: T1 });
    expect((await sink.readManifest(ORG_ID, 2))!.metadata?.map((m) => m.path)).toEqual([
      `org_id=${ORG_ID}/org.json`,
    ]);
  });

  it('still archives evidence and says so when the org record cannot be read', async () => {
    const result = await run('Acme', T1, true);
    expect(result.manifest.seq).toBe(1);
    expect(result.metadata.written).toEqual([]);
    expect(result.metadata.error).toMatch(/boom/);
    expect((await sink.readManifest(ORG_ID, 1))!.metadata).toBeUndefined();
  });

  it('writes nothing on a dry run and does not say it did', async () => {
    const result = await runCollect({
      orgId: ORG_ID, sources: ['audit-trail'], sinks: [sink], soql: client('Acme'),
      instanceUrl: 'https://acme.my.salesforce.com', now: new Date(T1), dryRun: true,
    });
    expect(result.metadata.written).toEqual([]);
    expect(result.metadata.prepared.sort()).toEqual(['archive.json', `org_id=${ORG_ID}/org.json`]);
    await expect(readFile(join(root, 'archive.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives a second canonical sink that starts empty the same metadata files', async () => {
    const root2 = await mkdtemp(join(tmpdir(), 'sf-evidence-meta2-'));
    try {
      await run('Acme', T1);
      const sink2 = new LocalSink(root2);
      await sink2.init();
      await runCollect({
        orgId: ORG_ID, sources: ['audit-trail'], sinks: [sink, sink2], soql: client('Acme'),
        instanceUrl: 'https://acme.my.salesforce.com', now: new Date(T2),
      });
      for (const rel of ['archive.json', `org_id=${ORG_ID}/org.json`]) {
        const a = await readFile(join(root, ...rel.split('/')));
        const b = await readFile(join(root2, ...rel.split('/')));
        expect(b.equals(a)).toBe(true);
      }
      expect(JSON.parse(await readFile(join(root2, 'archive.json'), 'utf8')).created_at).toBe(T1);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });
});

