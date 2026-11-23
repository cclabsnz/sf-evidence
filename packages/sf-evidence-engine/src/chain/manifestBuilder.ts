import { canonicalBytes } from './canonical.js';
import { sha256Hex, merkleRoot } from './hash.js';
import { recordFilePath } from '../sinks/layout.js';
import { monthKey } from '../lib/time.js';
import { uncoveredIntervals } from '../archive/coverage.js';
import type { NormalisedRecord, SourceId } from '../types/record.js';
import type {
  Degradation,
  Manifest,
  SourceOutcomeEntry,
  SourceStatus,
  TimeWindow,
  FileEntry,
} from '../types/manifest.js';
import type { PreparedBatch, PreparedFile } from '../types/sink.js';

export const PRODUCER = { name: '@cclabsnz/sf-evidence', version: '0.1.0' } as const;

/**
 * SHA-256 over the manifest's canonical form, `sha256:` prefixed (SPEC.md §6.2).
 *
 * A manifest never contains its own hash — the value lives only in the next manifest's
 * `prev_manifest_hash` and in head.json.
 */
export function manifestHash(manifest: Manifest): string {
  return `sha256:${sha256Hex(canonicalBytes(manifest))}`;
}

export interface SourceBatchInput {
  source: SourceId;
  status: SourceStatus;
  window: TimeWindow;
  achieved: TimeWindow[];
  records: NormalisedRecord[];
}

export interface BuildBatchArgs {
  orgId: string;
  runId: string;
  createdAt: string;
  collectedAt: string;
  prevManifestHash: string;
  seq: number;
  outcomes: SourceBatchInput[];
  degradations: Degradation[];
  /** archive.json / org.json to write with this batch; they ride in `files` and the manifest. */
  metadata?: PreparedFile[];
  /** Record file name suffix for a run's later commit rounds; see `RecordPathArgs.part`. */
  part?: string;
}

/** Deterministic ordering: this is what makes the Merkle root reproducible. */
function byOccurrence(a: NormalisedRecord, b: NormalisedRecord): number {
  if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
  if (a.source_id !== b.source_id) return a.source_id < b.source_id ? -1 : 1;
  return 0;
}

export function buildBatch(args: BuildBatchArgs): PreparedBatch {
  const files: PreparedFile[] = [];
  const sources: SourceOutcomeEntry[] = [];

  for (const outcome of args.outcomes) {
    const sorted = [...outcome.records].sort(byOccurrence);

    // Partition by the UTC month of occurred_at, so one batch can span several months.
    const byMonth = new Map<string, NormalisedRecord[]>();
    for (const rec of sorted) {
      const { year, month } = monthKey(rec.occurred_at);
      const key = `${year}-${month}`;
      const bucket = byMonth.get(key);
      if (bucket) bucket.push(rec);
      else byMonth.set(key, [rec]);
    }

    const fileEntries: FileEntry[] = [];
    const leafHashes: string[] = [];

    for (const monthRecords of [...byMonth.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, v]) => v)) {
      const lines: Buffer[] = [];
      for (const rec of monthRecords) {
        const bytes = canonicalBytes(rec);
        leafHashes.push(sha256Hex(bytes));
        lines.push(bytes, Buffer.from('\n', 'utf8'));
      }
      const content = Buffer.concat(lines);
      const relPath = recordFilePath({
        orgId: args.orgId,
        source: outcome.source,
        occurredAt: monthRecords[0]!.occurred_at,
        collectedAt: args.collectedAt,
        runId: args.runId,
        part: args.part,
      });
      const digest = `sha256:${sha256Hex(content)}`;
      files.push({ relPath, bytes: content, sha256: digest });
      fileEntries.push({ path: relPath, bytes: content.length, sha256: digest });
    }

    sources.push({
      source: outcome.source,
      window: outcome.window,
      status: outcome.status,
      record_count: sorted.length,
      records_root: `sha256:${merkleRoot(leafHashes)}`,
      files: fileEntries,
      // A complete outcome that achieved its whole window omits `achieved`, which `achievedOf`
      // infers; that keeps such entries byte-identical to legacy manifests and the SPEC §6.4
      // vector. A complete outcome spanning several planned windows (gap repair plus the
      // incremental window) did not query the ranges between them, so it must say so.
      ...(outcome.status === 'complete' &&
      uncoveredIntervals(outcome.achieved, outcome.window.from, outcome.window.to).length === 0
        ? {}
        : { achieved: outcome.achieved }),
    });
  }

  const metadata: FileEntry[] = (args.metadata ?? []).map((f) => ({
    path: f.relPath,
    bytes: f.bytes.length,
    sha256: f.sha256,
  }));

  const manifest: Manifest = {
    schema: 'sf-evidence/manifest/v1',
    seq: args.seq,
    org_id: args.orgId,
    run_id: args.runId,
    created_at: args.createdAt,
    producer: { name: PRODUCER.name, version: PRODUCER.version },
    prev_manifest_hash: args.prevManifestHash,
    sources,
    degradations: args.degradations,
    // Omitted when empty, so a run that wrote no metadata stays byte-identical to a legacy manifest.
    ...(metadata.length > 0 ? { metadata } : {}),
  };

  return { orgId: args.orgId, manifest, files: [...files, ...(args.metadata ?? [])] };
}
