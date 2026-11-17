import { sha256Hex } from '../chain/hash.js';
import { orgPrefix } from '../sinks/layout.js';
import type { OrgInfo } from '../salesforce.js';
import type { PreparedFile } from '../types/sink.js';

export const ARCHIVE_FORMAT = 'sf-evidence/archive/v1';
export const ARCHIVE_JSON_PATH = 'archive.json';

export function orgJsonPath(orgId: string): string {
  return `${orgPrefix(orgId)}/org.json`;
}

export interface BuildMetadataArgs {
  orgInfo: OrgInfo;
  instanceUrl?: string;
  apiVersion: string;
  producer: { name: string; version: string };
  /** The files as they stand in the archive now, or null when absent. */
  existing: { archive: string | null; org: string | null };
  now: string;
}

function file(relPath: string, value: unknown): PreparedFile {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  return { relPath, bytes, sha256: `sha256:${sha256Hex(bytes)}` };
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The metadata files this run must write, possibly none (SPEC.md §5.3).
 *
 * `archive.json` is written only when absent: the format version describes how the archive was
 * first laid out, and a later producer must not rewrite it. `org.json` is written when absent
 * or when any field except `first_seen` differs, so a rename is recorded and an unchanged org
 * costs nothing. An existing `org.json` that cannot be parsed is replaced, with `first_seen`
 * restarting at `now`: its original value is not recoverable.
 */
export function buildMetadataFiles(args: BuildMetadataArgs): PreparedFile[] {
  const out: PreparedFile[] = [];

  if (args.existing.archive === null) {
    out.push(
      file(ARCHIVE_JSON_PATH, {
        format: ARCHIVE_FORMAT,
        created_at: args.now,
        producer: { name: args.producer.name, version: args.producer.version },
      }),
    );
  }

  const prior = args.existing.org === null ? null : parse(args.existing.org);
  const next = {
    org_id: args.orgInfo.id,
    name: args.orgInfo.name,
    edition: args.orgInfo.edition,
    instance: args.orgInfo.instance,
    is_sandbox: args.orgInfo.isSandbox,
    instance_url: args.instanceUrl ?? null,
    api_version: args.apiVersion,
  };
  const unchanged =
    prior !== null && (Object.keys(next) as Array<keyof typeof next>).every((k) => prior[k] === next[k]);
  if (!unchanged) {
    const firstSeen = typeof prior?.first_seen === 'string' ? prior.first_seen : args.now;
    out.push(file(orgJsonPath(args.orgInfo.id), { ...next, first_seen: firstSeen }));
  }

  return out;
}
