import { mkdtemp, rm, writeFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { LocalSink } from '../../../src/sinks/local.js';
import { resolveQueryFiles } from '../../../src/archive/queryFiles.js';
import { orgJsonPath } from '../../../src/archive/metadata.js';
import { absoluteRecordPath, manifestPath } from '../../../src/sinks/layout.js';
import { buildBatch } from '../../../src/chain/manifestBuilder.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import { RECORD_0, RECORD_1, ORG_ID } from '../../../src/testing/specVectors.js';
import type { NormalisedRecord } from '../../../src/types/record.js';
import type { Manifest } from '../../../src/types/manifest.js';

const records = [RECORD_0, RECORD_1] as unknown as NormalisedRecord[];
const WINDOW = { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' };

/** Every path under the root with size and mtime, so "writes nothing" is a whole-tree comparison. */
async function snapshot(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`;
    const s = await stat(join(dir, p));
    out.push(`${p}|${s.size}|${s.mtimeMs}`);
    if (e.isDirectory()) out.push(...(await snapshot(dir, p)));
  }
  return out.sort();
}

describe('resolveQueryFiles', () => {
  let root: string;
  let sink: LocalSink;
  let seq = 0;
  let prev = GENESIS_PREV;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-qf-'));
    sink = new LocalSink(root);
    await sink.init();
    seq = 0;
    prev = GENESIS_PREV;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(recs: NormalisedRecord[], collectedAt: string) {
    seq += 1;
    const batch = buildBatch({
      orgId: ORG_ID,
      runId: `01K3QF8H2N000000000000000${seq}`,
      createdAt: collectedAt,
      collectedAt,
      prevManifestHash: prev,
      seq,
      outcomes: [{ source: 'audit-trail', status: 'complete', window: WINDOW, achieved: [WINDOW], records: recs }],
      degradations: [],
    });
    const out = await sink.putBatch(batch);
    prev = out.manifestHash;
    return batch;
  }

  it('lists every file referenced by the chain, per source', async () => {
    const b1 = await seed([RECORD_0 as unknown as NormalisedRecord], '2026-08-15T09:00:12.482Z');
    const b2 = await seed([RECORD_1 as unknown as NormalisedRecord], '2026-08-16T09:00:12.482Z');
    const expected = [...b1.manifest.sources, ...b2.manifest.sources]
      .flatMap((s) => s.files.map((f) => absoluteRecordPath(root, f.path)))
      .sort();
    expect(expected.length).toBeGreaterThanOrEqual(2);
    const res = await resolveQueryFiles(sink, [ORG_ID]);
    expect(res.bySource['audit-trail']).toEqual(expected);
    expect(res.orphanCount).toBe(0);
  });

  it('excludes and counts orphans', async () => {
    const b = await seed(records, '2026-08-15T09:00:12.482Z');
    const monthDir = join(root, ...b.manifest.sources[0]!.files[0]!.path.split('/').slice(0, -1));
    await writeFile(join(monthDir, 'part-orphan.ndjson'), '{}\n');
    const res = await resolveQueryFiles(sink, [ORG_ID]);
    expect(res.orphanCount).toBe(1);
    expect(res.bySource['audit-trail']!.some((p) => p.endsWith('part-orphan.ndjson'))).toBe(false);
    expect(res.bySource['audit-trail']).toHaveLength(b.manifest.sources[0]!.files.length);
  });

  it('writes nothing', async () => {
    await seed(records, '2026-08-15T09:00:12.482Z');
    await mkdir(join(root, `org_id=${ORG_ID}`, '_state'), { recursive: true });
    await writeFile(join(root, `org_id=${ORG_ID}`, '_state', 'x.json'), '{}');
    const before = await snapshot(root);
    await resolveQueryFiles(sink, [ORG_ID]);
    expect(await snapshot(root)).toEqual(before);
  });

  it('org with no chain yields empty lists', async () => {
    const res = await resolveQueryFiles(sink, [ORG_ID]);
    expect(res.bySource).toEqual({});
    expect(res.orphanCount).toBe(0);
    expect(res.orgLabels).toEqual({ [ORG_ID]: null });
    expect(res.missingOrgs).toEqual([ORG_ID]);
  });

  it('missingOrgs names only the requested orgs that have no manifests', async () => {
    await seed(records, '2026-08-15T09:00:12.482Z');
    const other = '00D000000000002AAA';
    const res = await resolveQueryFiles(sink, [ORG_ID, other]);
    expect(res.missingOrgs).toEqual([other]);
    expect(res.rejectedPaths).toBe(0);
  });

  describe('a tampered manifest cannot widen the file set', () => {
    /** Rewrite manifest 1's record file paths in place, as someone with write access could. */
    async function tamper(paths: (original: string, i: number) => string): Promise<void> {
      const file = join(root, ...manifestPath(ORG_ID, 1).split('/'));
      const m = JSON.parse(await readFile(file, 'utf8')) as Manifest;
      let i = 0;
      for (const src of m.sources) for (const f of src.files) f.path = paths(f.path, i++);
      await writeFile(file, JSON.stringify(m));
    }

    const inside = (p: string): boolean => p.startsWith(root + sep);

    it.each([
      ['a path that climbs out with ..', (p: string) => `${p.split('/').slice(0, 4).join('/')}/../../../../../../etc/passwd.ndjson`],
      ['an absolute path', () => '/etc/passwd.ndjson'],
      ['another org\'s partition', (p: string) => p.replace(`org_id=${ORG_ID}`, 'org_id=00D000000000002AAA')],
      ['a path outside the record layout', (p: string) => `org_id=${ORG_ID}/_state/${p.split('/').at(-1)}`],
    ])('excludes and counts %s', async (_name, rewrite) => {
      // Two manifests; only manifest 1's first file is tampered with, the rest must still resolve.
      const b1 = await seed([RECORD_0 as unknown as NormalisedRecord], '2026-08-15T09:00:12.482Z');
      const b2 = await seed([RECORD_1 as unknown as NormalisedRecord], '2026-08-16T09:00:12.482Z');
      const total = [b1, b2].flatMap((b) => b.manifest.sources.flatMap((x) => x.files)).length;
      expect(total).toBeGreaterThanOrEqual(2);
      await tamper((p, i) => (i === 0 ? rewrite(p) : p));
      const res = await resolveQueryFiles(sink, [ORG_ID]);
      expect(res.rejectedPaths).toBe(1);
      expect(res.bySource['audit-trail']).toHaveLength(total - 1);
      expect(res.bySource['audit-trail']!.every(inside)).toBe(true);
    });

    it('drops a source whose every file is rejected', async () => {
      const b = await seed(records, '2026-08-15T09:00:12.482Z');
      await tamper(() => '../outside.ndjson');
      const res = await resolveQueryFiles(sink, [ORG_ID]);
      expect(res.rejectedPaths).toBe(b.manifest.sources.flatMap((x) => x.files).length);
      expect(res.bySource).toEqual({});
      // The org has a chain, so it is not "missing"; its files were refused.
      expect(res.missingOrgs).toEqual([]);
    });
  });

  it('orgLabels reads org.json name', async () => {
    await mkdir(join(root, `org_id=${ORG_ID}`), { recursive: true });
    await writeFile(join(root, orgJsonPath(ORG_ID)), JSON.stringify({ name: 'Acme Prod' }));
    const res = await resolveQueryFiles(sink, [ORG_ID]);
    expect(res.orgLabels[ORG_ID]).toBe('Acme Prod');
  });

  it('orgLabels is null for unreadable org.json', async () => {
    await mkdir(join(root, `org_id=${ORG_ID}`), { recursive: true });
    await writeFile(join(root, orgJsonPath(ORG_ID)), '{not json');
    const res = await resolveQueryFiles(sink, [ORG_ID]);
    expect(res.orgLabels[ORG_ID]).toBeNull();
  });

  it('throws naming the sink when it has no queryable root', async () => {
    const fake = { id: 's3', queryRoot: () => null } as unknown as LocalSink;
    await expect(resolveQueryFiles(fake, [ORG_ID])).rejects.toThrow(/s3/);
  });
});
