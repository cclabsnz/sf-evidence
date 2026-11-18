import { describe, expect, it } from '@jest/globals';
import hook, { queryEngineCheck } from '../../../src/hooks/doctorChecks.js';

describe('doctor-checks hook', () => {
  it('hook reports ok with version', async () => {
    const [row, ...rest] = await queryEngineCheck();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ name: 'Query engine', level: 'ok', checked: true });
    expect(row?.detail).toMatch(/^DuckDB v?1\.5\.6/);
    expect(row?.detail).toMatch(/\(in-process, sandboxed\)$/);
  });

  it('hook reports warn on load failure', async () => {
    const [row] = await queryEngineCheck(async () => {
      throw new Error('dlopen failed: no prebuilt binary');
    });
    expect(row).toMatchObject({
      name: 'Query engine',
      level: 'warn',
      detail: 'could not load: dlopen failed: no prebuilt binary',
      checked: true,
    });
    expect(row?.remediation).toMatch(/sf plugins install @cclabsnz\/sf-evidence-query/);
  });

  it('the default export is the check, usable as an oclif hook', async () => {
    const rows = await (hook as unknown as (o: object) => Promise<unknown[]>)({});
    expect(rows).toHaveLength(1);
  });
});
