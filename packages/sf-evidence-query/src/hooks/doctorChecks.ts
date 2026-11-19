import type { Check, QueryFiles } from '@cclabsnz/sf-evidence-engine';
import { openQuerySession, type QuerySession } from '../duckdb/session.js';
import { errorMessage } from '../duckdb/guard.js';

/**
 * The `sf-evidence:doctor-checks` hook (declared in package.json `oclif.hooks`): how this plugin
 * contributes the "Query engine" row to the main plugin's `sf evidence doctor`. The main plugin
 * never imports DuckDB; it only runs the hook and reads `successes[].result`.
 *
 * oclif fixes a hook's signature and `@oclif/core`'s `Hooks` interface does not know this custom
 * event, so the default export takes an untyped options bag (unused) and returns the rows; the
 * logic lives in `queryEngineCheck`, which tests call directly with an injectable loader.
 */
const NAME = 'Query engine';

/** `allowed_paths=[]` denies all file access, so a session over no files is all the check needs. */
const NO_FILES: QueryFiles = {
  bySource: {} as QueryFiles['bySource'],
  orphanCount: 0,
  orgLabels: {},
  missingOrgs: [],
  rejectedPaths: 0,
};

export async function queryEngineCheck(load?: Parameters<typeof openQuerySession>[0]['load']): Promise<Check[]> {
  let session: QuerySession | undefined;
  try {
    session = await openQuerySession({ files: NO_FILES, timezone: 'UTC', load });
    const version = await session.version();
    return [{ name: NAME, level: 'ok', detail: `DuckDB ${version} (in-process, sandboxed)`, checked: true }];
  } catch (err) {
    return [
      {
        name: NAME,
        level: 'warn',
        // Structural, not `instanceof Error`: DuckDB's errors can come from another realm.
        detail: `could not load: ${errorMessage(err)}`,
        remediation: 'Reinstall the query plugin with `sf plugins install @cclabsnz/sf-evidence-query`.',
        checked: true,
      },
    ];
  } finally {
    session?.close();
  }
}

export default async function doctorChecks(_options?: unknown): Promise<Check[]> {
  return queryEngineCheck();
}
