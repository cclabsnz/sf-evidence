import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectSourceFiles } from '@cclabsnz/sf-core/testing';

/**
 * DuckDB is a ~50MB native dependency and the sandbox lives in one place. Every other module
 * goes through `src/duckdb/session.ts`, so the settings that lock the engine down cannot be
 * bypassed by opening a second instance. Type-only imports count too.
 */
const ALLOWED = 'src/duckdb/session.ts';
const DUCKDB_IMPORT = /(from|import)\s*\(?\s*['"]@duckdb\/node-api['"]/;

const ROOT = process.cwd();

describe('query plugin dependency boundary', () => {
  it('imports @duckdb/node-api only from src/duckdb/session.ts', () => {
    const offending = collectSourceFiles(join(ROOT, 'src'))
      .filter((file) => relative(ROOT, file) !== ALLOWED)
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, i) => (DUCKDB_IMPORT.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(offending).toEqual([]);
  });
});
