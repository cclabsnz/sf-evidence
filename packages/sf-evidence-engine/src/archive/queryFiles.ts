import type { Sink } from '../types/sink.js';
import type { SourceId } from '../types/record.js';
import { sep } from 'node:path';
import { absoluteRecordPath, isRecordPath } from '../sinks/layout.js';
import { orgJsonPath } from './metadata.js';

export interface QueryFiles {
  /** Absolute, deduplicated, sorted record files the chain covers, per source. */
  bySource: Record<SourceId, string[]>;
  /** Record files present on disk but referenced by no manifest, across the requested orgs. */
  orphanCount: number;
  /** `org.json` `name` per org id; null when `org.json` is missing or unreadable. */
  orgLabels: Record<string, string | null>;
  /**
   * Requested org ids with no manifests at all, in request order. A well-formed id with no
   * archive would otherwise just yield zero rows, indistinguishable from an org with no events.
   */
  missingOrgs: string[];
  /**
   * Manifest file paths refused because they are not this org's and source's record layout, or
   * resolve outside the root. Only an edited manifest produces one; `verify` will say more.
   */
  rejectedPaths: number;
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
  const missingOrgs: string[] = [];
  const inside = root.endsWith(sep) ? root : root + sep;
  let orphanCount = 0;
  let rejectedPaths = 0;
  for (const orgId of orgIds) {
    const seqs = await sink.listManifests(orgId);
    if (seqs.length === 0) missingOrgs.push(orgId);
    for (const seq of seqs) {
      const manifest = await sink.readManifest(orgId, seq);
      for (const entry of manifest?.sources ?? []) {
        for (const f of entry.files) {
          // Both checks: the shape check refuses `..`, absolute and cross-org paths outright;
          // the containment check is the backstop that does not depend on the shape rules.
          const abs = absoluteRecordPath(root, f.path);
          if (!isRecordPath(f.path, orgId, entry.source) || !abs.startsWith(inside)) {
            rejectedPaths += 1;
            continue;
          }
          // Created on first accepted file, so a source whose every file is refused has no key.
          let set = sets.get(entry.source);
          if (!set) sets.set(entry.source, (set = new Set()));
          set.add(abs);
        }
      }
    }
    orphanCount += (await sink.listOrphans(orgId)).length;
    orgLabels[orgId] = await orgLabel(sink, orgId);
  }
  const bySource = {} as Record<SourceId, string[]>;
  for (const [source, set] of sets) bySource[source] = [...set].sort();
  return { bySource, orphanCount, orgLabels, missingOrgs, rejectedPaths };
}
