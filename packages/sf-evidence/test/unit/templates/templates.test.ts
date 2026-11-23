import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const read = (p: string) => readFile(resolve(repoRoot, 'templates/scheduling', p), 'utf8');

describe('scheduling templates', () => {
  it('run-sf-evidence.sh defaults to audit-trail, login-history and limits', async () => {
    const sh = await read('run-sf-evidence.sh');
    expect(sh).toContain('sources="${SF_EVIDENCE_SOURCES:-audit-trail,login-history,limits}"');
    expect(sh).toContain('(default: audit-trail,login-history,limits)');
    expect(sh).not.toContain('audit-trail,limits');
  });

  describe('SF_Evidence_Reader permission set', () => {
    const file = 'salesforce/SF_Evidence_Reader.permissionset-meta.xml';

    it('grants MonitorLoginHistory and keeps ApiEnabled and ViewSetup', async () => {
      const xml = await read(file);
      expect(xml).toMatch(/<enabled>true<\/enabled>\s*<name>MonitorLoginHistory<\/name>/);
      expect(xml).toContain('<name>ApiEnabled</name>');
      expect(xml).toContain('<name>ViewSetup</name>');
    });

    it('does not grant ManageUsers, ViewAllData or ModifyAllData', async () => {
      const xml = await read(file);
      const granted = [...xml.matchAll(/<name>(\w+)<\/name>/g)].map((m) => m[1]);
      for (const p of ['ManageUsers', 'ViewAllData', 'ModifyAllData']) expect(granted).not.toContain(p);
    });

    it('mentions Login History in its description and header comment', async () => {
      const xml = await read(file);
      expect(xml.match(/<description>([\s\S]*?)<\/description>/)![1]).toMatch(/Login History/);
      expect(xml.match(/<!--([\s\S]*?)-->/)![1]).toMatch(/Login History/);
    });
  });

  describe('CI templates pin the plugin version this release ships', () => {
    const pluginVersion = async (): Promise<string> =>
      (JSON.parse(await readFile(resolve(repoRoot, 'packages/sf-evidence/package.json'), 'utf8')) as { version: string }).version;

    it.each([
      ['github-actions/sf-evidence.yml', /SF_EVIDENCE_VERSION:\s*(\S+)/],
      ['azure-devops/azure-pipelines.yml', /name: SF_EVIDENCE_VERSION\s*\n\s*value:\s*(\S+)/],
    ])('%s pins @cclabsnz/sf-evidence at the package version', async (file, pattern) => {
      const pinned = (await read(file)).match(pattern)?.[1];
      expect(pinned).toBe(await pluginVersion());
    });
  });
});
