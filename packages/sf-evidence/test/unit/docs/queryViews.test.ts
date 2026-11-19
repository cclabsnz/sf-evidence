import { describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../../../..');

describe('docs/query-views.md', () => {
  it('query-views.md matches the definitions', async () => {
    const committed = await readFile(resolve(repoRoot, 'docs/query-views.md'), 'utf8');
    const { stdout } = await run('node', [resolve(repoRoot, 'scripts/gen-query-views.mjs'), '--stdout']);
    expect(committed).toBe(stdout);
  });
});
