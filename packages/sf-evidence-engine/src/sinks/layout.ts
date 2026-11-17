import { monthKey } from '../lib/time.js';
import type { SourceId } from '../types/record.js';

export const CHAIN_DIR = '_chain';
export const STATE_DIR = '_state';

/**
 * Exactly 18 alphanumeric characters. Validated because org ids become filesystem path
 * segments, so an unvalidated value is a traversal risk. 18-only is deliberate: the
 * 15-character form of the same id would partition one org's archive under two directory
 * names.
 */
const ORG_ID_RE = /^[a-zA-Z0-9]{18}$/;

export function orgPrefix(orgId: string): string {
  if (!ORG_ID_RE.test(orgId)) {
    throw new Error(`Invalid org id: ${orgId} (expected 18 alphanumeric characters).`);
  }
  return `org_id=${orgId}`;
}

export interface RecordPathArgs {
  orgId: string;
  source: SourceId;
  /** Determines the partition — an event belongs to the month it happened, not the month we fetched it. */
  occurredAt: string;
  /** Determines the filename. */
  collectedAt: string;
  runId: string;
}

/** Compact `YYYYMMDDThhmmssZ` for filenames. */
function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function recordFilePath(args: RecordPathArgs): string {
  const { year, month } = monthKey(args.occurredAt);
  const name = `part-${stamp(args.collectedAt)}-${args.runId.slice(0, 8)}.ndjson`;
  return `${orgPrefix(args.orgId)}/source=${args.source}/year=${year}/month=${month}/${name}`;
}

export function manifestPath(orgId: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`Invalid manifest sequence: ${seq} (expected a positive integer).`);
  }
  return `${orgPrefix(orgId)}/${CHAIN_DIR}/${String(seq).padStart(8, '0')}.manifest.json`;
}

export function headPath(orgId: string): string {
  return `${orgPrefix(orgId)}/${CHAIN_DIR}/head.json`;
}

export function statePath(orgId: string, source: SourceId): string {
  return `${orgPrefix(orgId)}/${STATE_DIR}/${source}.json`;
}

/** A plain file name: no separators, no leading dot, so it cannot leave `_state/`. */
const STATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `org_id=<id>/_state/<name>`, for derived and disposable state (SPEC.md §5.4). */
export function stateFilePath(orgId: string, name: string): string {
  if (!STATE_NAME_RE.test(name)) {
    throw new Error(`Invalid state file name: ${JSON.stringify(name)} (expected a plain file name).`);
  }
  return `${orgPrefix(orgId)}/${STATE_DIR}/${name}`;
}

/** Whether an archive-relative path lies under an org's `_state/` directory. */
export function isStatePath(relPath: string): boolean {
  return relPath.split('/')[1] === STATE_DIR;
}
