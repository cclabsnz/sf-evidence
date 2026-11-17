import { describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../../../..');

describe('docs/security-statement.md', () => {
  it('the committed security statement matches what explain generates', async () => {
    const committed = await readFile(resolve(repoRoot, 'docs/security-statement.md'), 'utf8');
    const { stdout } = await run('node', [resolve(repoRoot, 'scripts/gen-security-statement.mjs'), '--stdout']);
    expect(committed).toBe(stdout);
  });
});
