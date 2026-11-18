import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSink } from '../../../src/sinks/local.js';
import { verifyChain } from '../../../src/chain/verifier.js';
import { orgJsonPath } from '../../../src/archive/metadata.js';
import { FIXTURE, writeQueryFixture } from '../../../src/testing/queryFixture.js';

describe('query fixture', () => {
  let root: string;
  let sink: LocalSink;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-fx-'));
    await writeQueryFixture(root);
    sink = new LocalSink(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fixture chain verifies', async () => {
    for (const org of [FIXTURE.orgA, FIXTURE.orgB]) {
      const report = await verifyChain(sink, org, { anchor: 'none', deep: true });
      expect(report.breaks).toEqual([]);
      expect(report.chain.valid).toBe(true);
    }
  });

  it('fixture has exactly one orphan', async () => {
    const orphans = await sink.listOrphans(FIXTURE.orgA);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.relPath).toBe(FIXTURE.orphanRelPath);
    expect(await sink.listOrphans(FIXTURE.orgB)).toEqual([]);
  });

  it('writes org.json with the fixture names', async () => {
    const a = JSON.parse(await readFile(join(root, orgJsonPath(FIXTURE.orgA)), 'utf8')) as { name: string };
    const b = JSON.parse(await readFile(join(root, orgJsonPath(FIXTURE.orgB)), 'utf8')) as { name: string };
    expect([a.name, b.name]).toEqual(['Fixture Prod', 'Fixture UAT']);
  });
});
