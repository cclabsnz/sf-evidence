/**
 * Public API of the engine: everything behind `sf evidence` that does not need oclif or
 * @salesforce/core (SPEC.md §3.1; AWS-EDITION-SPEC.md §6.3).
 *
 * Two kinds of consumer use it. Read-only consumers (the licensed add-on, an auditor's own
 * tooling) read archives and verify chains; they normally take these names through
 * `@cclabsnz/sf-evidence`, which re-exports exactly that subset. Hosts that write archives
 * (the `sf` CLI itself, the AWS edition's Lambda) also need the collection path, which is
 * exported here and only here. Both kinds share one copy of the layout, hashing and
 * verification code, so what a host writes is what `verify` checks.
 */

// Archive reading — the only component permitted to assume the archive's on-disk layout
// (SPEC.md §3.1, §5.1).
export { ArchiveReader, type SourceSummary } from './archive/reader.js';
export { resolveQueryFiles, type QueryFiles } from './archive/queryFiles.js';
export { formatStatus } from './lib/statusFormat.js';
export {
  assessStatus,
  type StatusRow,
  type StatusAssessment,
  type AssessStatusOptions,
} from './archive/status.js';

// Coverage assessment: gaps, pending and lost time, retention headroom, and the exit code
// `status` derives from them (SPEC.md §8.4, §10.4).
export {
  assessCoverage,
  statusExit,
  type CoverageAssessment,
  type CoverageInput,
  type Gap,
} from './archive/coverage.js';

// Verification, and everything that decides how its result is presented, including the
// mandatory "does not prove" wording (SPEC.md §6.5).
export {
  verifyChain,
  type VerifyReport,
  type VerifyBreak,
  type VerifyNote,
  type AnchorResult,
  type BreakKind,
  type VerifyOptions,
  type HeadCheck,
  type CoverageReport,
  type DegradedSource,
} from './chain/verifier.js';
export {
  ANCHOR_STATEMENTS,
  anchorStatementsFor,
  type AnchorMode,
  type AnchorStatementPair,
  type AnchorStatementContext,
} from './chain/anchorStatements.js';
export {
  verifyExitCode,
  hasRecordedDegradation,
  resolveEvaluateAnchor,
  formatVerifyReport,
  ALGORITHM,
  type AlgorithmExplanation,
  ALGORITHM_EXPLANATION,
} from './lib/verifyFormat.js';

// Hashing and canonicalisation primitives (SPEC.md §6.1, §6.2).
export { canonicalize, canonicalBytes, UnsupportedValueError } from './chain/canonical.js';
export { sha256Hex, merkleRoot } from './chain/hash.js';
export {
  manifestHash,
  buildBatch,
  type BuildBatchArgs,
  type SourceBatchInput,
} from './chain/manifestBuilder.js';

// Sinks. `GitSink` is a class export, not just a type, because `resolveEvaluateAnchor`
// decides whether to evaluate the git anchor with `instanceof GitSink`.
export { LocalSink } from './sinks/local.js';
export { GitSink, type GitSinkOptions } from './sinks/git.js';
// `--archive` / `--sink` resolution lives here, not in the CLI, so every plugin that takes
// those flags (`collect`, `query`) resolves them identically.
export { DEFAULT_ARCHIVE, resolveSink, resolveSinks, type SinkResolveOptions } from './sinks/resolve.js';

// Collection path, for hosts that write archives.
export {
  runCollect,
  type RunCollectArgs,
  type CollectResult,
  type SourceResult,
  type SinkResult,
} from './pipeline/runCollect.js';
export { collectionClock, type CollectionClock, type CollectionClockSource } from './pipeline/collectionClock.js';
export { resolveCollectBounds, resolveSince } from './lib/duration.js';
export { COLLECTORS, getCollector } from './collectors/registry.js';
export { API_VERSION, ORG_ID_QUERY, ORG_INFO_QUERY, resolveOrgId, resolveOrgInfo } from './salesforce.js';
export { classifyDegradation } from './lib/errors.js';
export {
  buildExplanation,
  type Explanation,
  type ExplainArgs,
  type Destination,
  type Assertion,
} from './lib/explainReport.js';

// Exit codes are uniform across every `sf evidence` command and every host (SPEC.md §8.0).
export { EXIT, setExitCode, type ExitCode } from './lib/exit.js';
export {
  runChecks,
  doctorExitCode,
  formatChecks,
  type Check,
  type CheckLevel,
  type DoctorEnv,
} from './lib/doctor.js';

// Contract types.
export type {
  Collector,
  CollectorContext,
  CollectOptions,
  CollectionOutcome,
  QueryDescription,
} from './types/collector.js';
export type { NormalisedRecord, SourceId } from './types/record.js';
export {
  GENESIS_PREV,
  type Manifest,
  type ChainHead,
  type Degradation,
  type SourceOutcomeEntry,
  type SourceStatus,
  type TimeWindow,
  type FileEntry,
} from './types/manifest.js';
export type {
  Sink,
  SinkId,
  AnchorKind,
  SinkCapabilities,
  SinkDescription,
  PreparedFile,
  PreparedBatch,
  PutOutcome,
  OrphanFile,
} from './types/sink.js';
