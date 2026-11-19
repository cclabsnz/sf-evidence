import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSourceFiles } from '@cclabsnz/sf-core/testing';

/**
 * The engine exists so a host that never loads the sf CLI (the AWS edition's Lambda) can
 * collect and verify archives. That only holds while nothing here reaches for oclif or
 * @salesforce/core, which are large, slow to load, and expect a writable home directory.
 * Type-only imports count too: they are how a runtime dependency starts.
 */
const FORBIDDEN_PACKAGE = /^(@oclif\/|@salesforce\/core$|@salesforce\/sf-plugins-core$|chalk$)/;
const FORBIDDEN_IMPORT =
  /from\s+['"](@oclif\/[^'"]*|@salesforce\/core|@salesforce\/sf-plugins-core|chalk)['"]/;

const ROOT = process.cwd();

describe('engine dependency boundary', () => {
  it('declares no CLI or Salesforce-CLI dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
      (field) => Object.keys(pkg[field] ?? {}),
    );
    expect(declared.filter((name) => FORBIDDEN_PACKAGE.test(name))).toEqual([]);
  });

  it('declares no @duckdb/ dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
      (field) => Object.keys(pkg[field] ?? {}),
    );
    expect(declared.filter((name) => name.startsWith('@duckdb/'))).toEqual([]);
  });

  it('imports no CLI or Salesforce-CLI module, not even as a type', () => {
    const offending = collectSourceFiles(join(ROOT, 'src')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (FORBIDDEN_IMPORT.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offending).toEqual([]);
  });
});
