import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** DuckDB belongs to `@cclabsnz/sf-evidence-query` only; this plugin must stay installable without it. */
describe('plugin dependency boundary', () => {
  it('declares no @duckdb/ dependency', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
      (field) => Object.keys(pkg[field] ?? {}),
    );
    expect(declared.filter((name) => name.startsWith('@duckdb/'))).toEqual([]);
  });
});
