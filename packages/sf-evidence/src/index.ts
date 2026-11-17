/**
 * Public programmatic API.
 *
 * The licensed add-on (Phase 6, `@cclabsnz/sf-evidence-assurance`) consumes this as a peer
 * dependency and never reimplements archive layout, hashing or verification — a divergence
 * between what the OSS `verify` proves and what a paid `report`/`score` claims would be a
 * credibility failure, not just a bug (SPEC.md §11.1).
 *
 * Scope is deliberately narrower than "everything exported from src/": only what a
 * read-only consumer of an existing archive needs — reading it, verifying its chain, and
 * reproducing its hashes — is exported. The collection *path* (`runCollect`, the collector
 * registry, batch-building) writes new data and the licensed add-on never does that, so
 * this package does not export it. Hosts that write archives take it from
 * `@cclabsnz/sf-evidence-engine`, where all of this code now lives; every name below is
 * re-exported from there unchanged. The collector *types* are exported anyway — see the
 * comment above the collector-types export below for why that's a different question.
 * See the Task 16 report for the full inclusion/exclusion rationale.
 */

// Archive reading — the only component permitted to assume the archive's on-disk layout
// (SPEC.md §3.1, §5.1). A consumer that wants coverage or record data goes through this,
// never through its own glob over the sink.
export { ArchiveReader, type SourceSummary } from '@cclabsnz/sf-evidence-engine';
// `status`'s decisions and rendering: `assessStatus` builds the rows `formatStatus` prints, so a
// consumer reaches the same verdict and exit code the CLI does.
export { assessStatus, formatStatus, type StatusRow } from '@cclabsnz/sf-evidence-engine';

// Verification — the chain-check algorithm and everything that decides how its result is
// presented, including the mandatory "does not prove" wording (SPEC.md §6.5) a report must
// carry verbatim rather than re-author.
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
} from '@cclabsnz/sf-evidence-engine';
export {
  ANCHOR_STATEMENTS,
  anchorStatementsFor,
  type AnchorMode,
  type AnchorStatementPair,
  type AnchorStatementContext,
} from '@cclabsnz/sf-evidence-engine';
export {
  verifyExitCode,
  hasRecordedDegradation,
  resolveEvaluateAnchor,
  formatVerifyReport,
  ALGORITHM,
  type AlgorithmExplanation,
  ALGORITHM_EXPLANATION,
} from '@cclabsnz/sf-evidence-engine';

// Hashing / canonicalisation primitives (SPEC.md §6.1, §6.2) — the four formulas a third
// party needs to reproduce verification independently, and the same ones `verifyChain` and
// the collect pipeline use internally. Exporting them is what keeps "no CloudCounsel
// software, no network" true for a consumer of this package too, not only for an outside
// auditor with their own JCS implementation.
export { canonicalize, canonicalBytes, UnsupportedValueError } from '@cclabsnz/sf-evidence-engine';
export { sha256Hex, merkleRoot } from '@cclabsnz/sf-evidence-engine';
export { manifestHash } from '@cclabsnz/sf-evidence-engine';

// Archive access. `ArchiveReader` and `verifyChain` both take a `Sink`; a consumer needs a
// concrete implementation to construct one against a real archive. `GitSink` is exported
// (not just `Sink`) because `resolveEvaluateAnchor` does an `instanceof GitSink` check —
// wiring the git anchor correctly requires the real class, not just the interface.
export { LocalSink } from '@cclabsnz/sf-evidence-engine';
export { GitSink, type GitSinkOptions } from '@cclabsnz/sf-evidence-engine';

// Exit codes are uniform across every `sf evidence` command, licensed ones included
// (SPEC.md §8.0), so the add-on maps its own outcomes onto the same scale rather than
// inventing parallel numbers.
export { EXIT, setExitCode, type ExitCode } from '@cclabsnz/sf-evidence-engine';

// Collector contract types — not the collection functions. SPEC.md §11.1 also specifies
// third-party collectors as an extension mechanism: a plugin declares one in its
// package.json and the core dynamically imports it. A third-party collector plugin has to
// implement `Collector` to be discoverable at all, so this is a read/write distinction that
// does not apply here — the type is a contract a plugin author implements against, not a
// code path the licensed add-on would run. `runCollect`, `COLLECTORS` and `getCollector`
// are exported only from the engine package; here, only the shapes they operate on are.
export type {
  Collector,
  CollectorContext,
  CollectionOutcome,
  QueryDescription,
} from '@cclabsnz/sf-evidence-engine';

// Shared types
export type { NormalisedRecord, SourceId } from '@cclabsnz/sf-evidence-engine';
export {
  GENESIS_PREV,
  type Manifest,
  type ChainHead,
  type Degradation,
  type SourceOutcomeEntry,
  type SourceStatus,
  type TimeWindow,
  type FileEntry,
} from '@cclabsnz/sf-evidence-engine';
export type { Sink, SinkCapabilities, SinkDescription, OrphanFile } from '@cclabsnz/sf-evidence-engine';
