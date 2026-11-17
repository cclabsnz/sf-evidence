import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitConfig, readVersions } from '../../../src/lib/doctorEnv.js';

const run = promisify(execFile);

describe('doctor environment readers', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf evidence env '));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function pkg(dir: string, name: string, version: string): Promise<string> {
    await mkdir(join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }));
    const entry = join(dir, 'lib', 'index.js');
    await writeFile(entry, '');
    return entry;
  }

  it('reads versions from an install path containing spaces', async () => {
    const plugin = await pkg(join(root, 'my plugin'), '@cclabsnz/sf-evidence', '1.2.3');
    const engine = await pkg(join(root, 'my engine'), '@cclabsnz/sf-evidence-engine', '4.5.6');
    expect(await readVersions(plugin, engine)).toEqual({ plugin: '1.2.3', engine: '4.5.6' });
  });

  it('returns the reason instead of throwing when a package.json cannot be found', async () => {
    const result = await readVersions(join(root, 'nowhere', 'index.js'), join(root, 'nowhere', 'index.js'));
    expect(result).toEqual({ error: expect.stringMatching(/no package\.json named/) });
  });

  it('gitConfig is null for an unset key but throws when git could not look', async () => {
    await run('git', ['init', '-q', root]);
    expect(await gitConfig(root, 'sfevidence.nothing')).toBeNull();
    await expect(gitConfig(join(root, 'missing'), 'user.signingkey')).rejects.toBeDefined();
  });
});
