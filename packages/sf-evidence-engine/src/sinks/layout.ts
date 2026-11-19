import { join } from 'node:path';
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

/**
 * Whether `s` is an org id this archive accepts as a partition name. Exported so a command can
 * refuse a malformed `--org-id` as a usage error before it touches the archive, by the same
 * rule `orgPrefix` would later throw on.
 */
export function isOrgId(s: string): boolean {
  return ORG_ID_RE.test(s);
}

export function orgPrefix(orgId: string): string {
  if (!isOrgId(orgId)) {
    throw new Error(`Invalid org id: ${orgId} (expected 18 alphanumeric characters).`);
  }
  return `org_id=${orgId}`;
}

/**
 * Inverse of `orgPrefix` for a directory name: the org id, or null for anything that is not
 * an `org_id=<18 alphanumerics>` partition. Null rather than a throw because callers scan
 * directory listings, where `_tmp`, stray files and malformed names are expected noise and
 * must be skipped, not fatal. Lives here so this module stays the only one that knows the
 * Hive spelling.
 */
export function parseOrgDir(name: string): string | null {
  const prefix = 'org_id=';
  if (!name.startsWith(prefix)) return null;
  const id = name.slice(prefix.length);
  return ORG_ID_RE.test(id) ? id : null;
}

/**
 * An archive-relative path (always forward slashes, as manifests record it) joined onto an
 * absolute root with the platform's separator. Splitting then joining, rather than string
 * concatenation, keeps Windows roots correct and `join` normalises any stray `..` segments.
 */
export function absoluteRecordPath(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'));
}

const YEAR_RE = /^year=\d{4}$/;
const MONTH_RE = /^month=(0[1-9]|1[0-2])$/;
/** A plain `.ndjson` file name: no separator of either kind, no leading dot, so never `.` or `..`. */
const RECORD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ndjson$/;

/**
 * Whether an archive-relative path has the shape `recordFilePath` writes for this org and
 * source: `org_id=<orgId>/source=<source>/year=YYYY/month=MM/<name>.ndjson`. Segment by segment,
 * so a manifest entry naming another org, another source, `_state/`, an absolute path or any
 * `..` fails. `query` uses it to refuse manifest paths it would otherwise hand to DuckDB's
 * `allowed_paths`: the chain says which files are evidence, but an edited manifest must not be
 * able to say a file outside the record layout is.
 */
export function isRecordPath(relPath: string, orgId: string, source: SourceId): boolean {
  const seg = relPath.split('/');
  return (
    seg.length === 5 &&
    isOrgId(orgId) &&
    seg[0] === `org_id=${orgId}` &&
    seg[1] === `source=${source}` &&
    YEAR_RE.test(seg[2]!) &&
    MONTH_RE.test(seg[3]!) &&
    RECORD_NAME_RE.test(seg[4]!)
  );
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
