import type { SourceId } from './record.js';

export type SourceStatus = 'complete' | 'partial' | 'degraded' | 'failed';

export interface FileEntry {
  /** Archive-root-relative path, forward slashes on every platform. */
  path: string;
  bytes: number;
  /** `sha256:` prefixed. */
  sha256: string;
}

export interface TimeWindow {
  from: string;
  to: string;
}

export interface SourceOutcomeEntry {
  source: SourceId;
  /** What this run attempted to cover — not what it achieved, unless status is `complete`. */
  window: TimeWindow;
  status: SourceStatus;
  record_count: number;
  /** `sha256:` prefixed Merkle root over this source's record hashes. */
  records_root: string;
  files: FileEntry[];
  /**
   * Sub-ranges of `window` this run actually covered, sorted and merged. Absent on manifests
   * written before it existed; read through `achievedOf`, never directly.
   */
  achieved?: TimeWindow[];
}

/**
 * A reduction in coverage that did not abort the run (C6). Recorded in the manifest so the
 * degradation is part of the evidence, not just a line of terminal output that scrolled past.
 */
export interface Degradation {
  source: SourceId;
  /** Salesforce error code, or a synthetic one such as `NO_CANONICAL_SINK`. */
  code: string;
  detail: string;
  /** Fields dropped because the org's API version does not expose them. */
  fieldsDropped?: string[];
  remediation: string;
  /** The slice this degradation applies to. Absent when it applies to the whole source. */
  window?: TimeWindow;
}

export interface Manifest {
  schema: 'sf-evidence/manifest/v1';
  /** Monotonic, per org, starts at 1. */
  seq: number;
  org_id: string;
  run_id: string;
  created_at: string;
  producer: { name: string; version: string };
  /** `sha256:` prefixed. GENESIS_PREV for seq 1. */
  prev_manifest_hash: string;
  sources: SourceOutcomeEntry[];
  degradations: Degradation[];
  /** `archive.json` and `org.json`, when the batch wrote them. */
  metadata?: FileEntry[];
}

export interface ChainHead {
  seq: number;
  manifest_hash: string;
  updated_at: string;
}

/** `prev_manifest_hash` for the genesis manifest (SPEC.md §6.3). */
export const GENESIS_PREV = `sha256:${'0'.repeat(64)}`;
