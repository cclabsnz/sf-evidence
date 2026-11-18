import type { Sink } from '../types/sink.js';
import type { SourceId } from '../types/record.js';
import { absoluteRecordPath } from '../sinks/layout.js';
import { orgJsonPath } from './metadata.js';

export interface QueryFiles {
  /** Absolute, deduplicated, sorted record files the chain covers, per source. */
  bySource: Record<SourceId, string[]>;
  /** Record files present on disk but referenced by no manifest, across the requested orgs. */
  orphanCount: number;
  /** `org.json` `name` per org id; null when `org.json` is missing or unreadable. */
  orgLabels: Record<string, string | null>;
}

async function orgLabel(sink: Sink, orgId: string): Promise<string | null> {
  try {
    const v: unknown = JSON.parse((await sink.readFile(orgJsonPath(orgId))).toString('utf8'));
    const name = typeof v === 'object' && v !== null ? (v as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * The record files `query` may read: exactly those some manifest in the org's chain
 * references, so a file the chain does not cover (an interrupted write's orphan) is never
 * queried as if it were evidence. Manifests are read straight from the sink, never through
 * `ArchiveReader.summarise()`, because that persists `_state/coverage.json` and a query must
 * leave the archive untouched. Only `sources[].files` count; `metadata[]` (archive.json,
 * org.json) is not record data.
 */
export async function resolveQueryFiles(sink: Sink, orgIds: string[]): Promise<QueryFiles> {
  const root = sink.queryRoot();
  if (root === null) {
    throw new Error(`The ${sink.id} sink has no local root, so its archive cannot be queried in place.`);
  }
  const sets = new Map<SourceId, Set<string>>();
  const orgLabels: Record<string, string | null> = {};
  let orphanCount = 0;
  for (const orgId of orgIds) {
    for (const seq of await sink.listManifests(orgId)) {
      const manifest = await sink.readManifest(orgId, seq);
      for (const entry of manifest?.sources ?? []) {
        let set = sets.get(entry.source);
        if (!set) sets.set(entry.source, (set = new Set()));
        for (const f of entry.files) set.add(absoluteRecordPath(root, f.path));
      }
    }
    orphanCount += (await sink.listOrphans(orgId)).length;
    orgLabels[orgId] = await orgLabel(sink, orgId);
  }
  const bySource = {} as Record<SourceId, string[]>;
  for (const [source, set] of sets) bySource[source] = [...set].sort();
  return { bySource, orphanCount, orgLabels };
}
