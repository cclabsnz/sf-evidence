import type { ChainHead, Manifest } from './manifest.js';

export type SinkId = 'local' | 'git' | 's3' | 'azure' | 'siem';
export type AnchorKind = 'git' | 'object-lock';

export interface SinkCapabilities {
  /** May hold the authoritative archive. A SIEM mirror may not. */
  canonical: boolean;
  readable: boolean;
  queryable: boolean;
  supportsObjectLock: boolean;
  anchors: AnchorKind[];
}

export interface SinkDescription {
  id: SinkId;
  /**
   * The machine-usable destination and nothing else: a filesystem root for `local`/`git`, a
   * host or bucket URI for a network sink. Never a secret, and never prose.
   *
   * Split from `note` deliberately. `explain` renders this two ways — concatenated with
   * archive sub-paths under FILE WRITES, and as a host under NETWORK DESTINATIONS — and a
   * field that sometimes carried a parenthetical produced paths like
   * `/tmp/archive (git repository, local commits only)/org_id=<org>/_chain/head.json`
   * in the one artifact a security reviewer reads instead of the source.
   */
  location: string;
  /** Human-readable qualifier about the destination, for display only. Never a secret. */
  note?: string;
  /** Where the credential comes from, e.g. "sf CLI session" or "AWS SDK default chain". */
  credentialSource: string;
  anchors: AnchorKind[];
}

export interface PreparedFile {
  /** Archive-root-relative, forward slashes. */
  relPath: string;
  bytes: Buffer;
  /** `sha256:` prefixed. */
  sha256: string;
}

export interface PreparedBatch {
  orgId: string;
  manifest: Manifest;
  files: PreparedFile[];
}

export interface PutOutcome {
  written: boolean;
  manifestSeq: number;
  manifestHash: string;
  /** Git sink only. */
  commit?: string;
  /** Git sink only: true when a remote is configured and the commit has not been pushed. */
  pushPending?: boolean;
  /**
   * Git sink only: the batch was archived, but the anchoring commit failed.
   *
   * `written` stays true, and that is the point. `GitSink.putBatch` writes through
   * `LocalSink` first — record files, manifest, head — and only then commits. A failure
   * after that write (no `user.email` configured, `-S` with no usable key) leaves the
   * evidence on disk and verifiable. Reporting it as an unwritten sink would send an
   * operator hunting for data that is already there, and would make `runCollect` announce
   * that nothing was archived when a complete batch was.
   */
  anchorError?: string;
}

export interface OrphanFile {
  relPath: string;
  bytes: number;
}

export interface Sink {
  readonly id: SinkId;
  readonly capabilities: SinkCapabilities;

  /** Human-readable destination and credential provenance. Never returns a secret. */
  describe(): SinkDescription;

  /**
   * Verify the target exists and is writable.
   *
   * MUST NOT create it (C5). A sink that provisions its own storage is a sink that could
   * provision the wrong storage, silently, in a customer's account.
   */
  init(): Promise<void>;

  /**
   * Verify the target exists and can be read, without asking for write access, for commands
   * that only read (`query`). The same "create it yourself" refusal as `init` when it is
   * missing, and likewise MUST NOT create it (C5).
   */
  checkReadable(): Promise<void>;

  head(orgId: string): Promise<ChainHead | null>;
  readManifest(orgId: string, seq: number): Promise<Manifest | null>;
  /** Sequence numbers present in the chain directory, ascending. */
  listManifests(orgId: string): Promise<number[]>;
  /** Raw bytes of an archive-relative path, for verification. */
  readFile(relPath: string): Promise<Buffer>;
  /** Record files present but referenced by no manifest (SPEC.md §10.5). */
  listOrphans(orgId: string): Promise<OrphanFile[]>;

  /** Writes a batch honouring the ordering invariant in SPEC.md §7.3. */
  putBatch(batch: PreparedBatch): Promise<PutOutcome>;

  /**
   * A derived state file under the org's `_state/` directory (SPEC.md §5.4), or null when it
   * does not exist. State is disposable: callers treat any problem reading it as a cache miss.
   */
  readState(orgId: string, name: string): Promise<string | null>;
  /**
   * Replace a derived state file atomically. State is never part of the chain, never
   * anchored, and never read by `verify`.
   */
  writeState(orgId: string, name: string, json: string): Promise<void>;

  /**
   * The absolute filesystem root of the archive for sinks that live on local disk, or null
   * for network sinks. The `query` command uses a non-null root to expose the archive to
   * DuckDB read-only; null means "not queryable in place", never "empty".
   */
  queryRoot(): string | null;
  /**
   * Org ids that have a partition in this sink, sorted ascending. Entries that are not
   * `org_id=<18 alphanumerics>` directories are ignored; an absent root yields `[]`.
   */
  listOrgs(): Promise<string[]>;
}
