import { canonicalBytes } from './canonical.js';
import { sha256Hex, merkleRoot } from './hash.js';
import { manifestHash } from './manifestBuilder.js';
import { anchorStatementsFor, type AnchorMode } from './anchorStatements.js';
import { GENESIS_PREV, type ChainHead, type Degradation, type SourceStatus } from '../types/manifest.js';
import type { SourceId } from '../types/record.js';
import type { OrphanFile, Sink } from '../types/sink.js';

export type BreakKind =
  | 'prev-hash-mismatch'
  | 'seq-gap'
  | 'missing-manifest'
  | 'missing-file'
  | 'unreadable-file'
  | 'file-hash-mismatch'
  | 'records-root-mismatch'
  | 'malformed-record'
  | 'head-mismatch'
  | 'anchor';

export type NoteKind = 'metadata-changed';

/**
 * Something the reader should know that is not evidence of tampering. Never a break, never
 * changes `chain.state` or the exit code. archive.json and org.json are metadata (SPEC.md
 * §5.3): an edit to them is worth saying, not worth accusing.
 */
export interface VerifyNote {
  seq: number;
  kind: NoteKind;
  file: string;
  expected: string;
  /** The file's hash on disk, or `missing` / the read error code. */
  actual: string;
}

export interface VerifyBreak {
  seq: number;
  kind: BreakKind;
  file?: string;
  expected?: string;
  actual?: string;
}

export interface AnchorResult {
  mode: AnchorMode;
  valid: boolean;
  detail?: string;
  signedCommits?: number;
  unsignedCommits?: number;
  /**
   * Commits whose signature git itself rejected, or whose status this build does not
   * recognise. Distinct from `unsignedCommits`: unsigned can be a deliberate policy choice,
   * a bad signature is evidence the commit was altered or the signature forged. Declared
   * here because `GitSink.evaluateAnchor` returns it and it is spread into `--json` output —
   * a public type that omits an emitted field is a type that lies about the payload.
   */
  badSignatures?: number;
  /**
   * Whether the anchoring repository has a remote configured. Load-bearing, not cosmetic:
   * the git anchor's force-past-branch-protection claim is only true when there is a host to
   * force past. See `anchorStatementsFor`.
   */
  remote?: boolean;
  proves: string;
  doesNotProve: string;
}

/**
 * Outcome of comparing `head.json` against the chain that was actually walked.
 *
 * `head.json` is the only thing that binds the *newest* manifest: no later manifest carries
 * its hash, so without this comparison, deleting the newest N manifests and their record
 * files leaves a shorter chain whose every remaining link still verifies (SPEC.md §6.3).
 */
export type HeadCheck =
  /** head.json agreed with the last manifest walked. Tail truncation is ruled out. */
  | 'matched'
  /** head.json disagreed — a `head-mismatch` break is recorded. */
  | 'mismatch'
  /** No head.json at all. Not a break, but tail truncation cannot be ruled out. */
  | 'absent'
  /** `--to` bounded the walk, so head.json is not expected to match the last manifest. */
  | 'not-checked'
  /** Nothing was walked, so there is nothing to compare head.json against. */
  | 'no-manifests';

export interface DegradedSource {
  seq: number;
  source: SourceId;
  status: SourceStatus;
}

/**
 * What the manifests themselves record about coverage, aggregated across the walked range.
 *
 * A chain can be perfectly intact over an archive that is missing a month. SPEC.md §8.3
 * gives that its own exit code (4) precisely so `chain: VALID` on a degraded archive cannot
 * be read as an all-clear a week after the `collect` warning scrolled out of the terminal.
 */
export interface CoverageReport {
  degradedSources: DegradedSource[];
  degradations: Array<Degradation & { seq: number }>;
}

export interface VerifyReport {
  orgId: string;
  manifestsChecked: number;
  recordsChecked: number;
  chain: {
    /**
     * True only when manifests were walked and every non-anchor check passed. A failed
     * anchor is reported by `anchor.valid`, not here: `verify --anchor git` against a
     * non-git sink says nothing about the chain, and rendering that as `chain: BROKEN`
     * would be a false accusation against intact evidence.
     */
    valid: boolean;
    /** `empty` is its own state: verifying nothing is not verifying successfully. */
    state: 'verified' | 'broken' | 'empty';
    head: ChainHead | null;
    headCheck: HeadCheck;
  };
  /** The sequence range actually walked, or null when nothing was. */
  range: { from: number; to: number } | null;
  /** Whether `range` covered every manifest present for this org. */
  fullChain: boolean;
  coverage: CoverageReport;
  anchor: AnchorResult;
  breaks: VerifyBreak[];
  notes: VerifyNote[];
  orphans: OrphanFile[];
}

export interface VerifyOptions {
  anchor: AnchorMode;
  /** Re-read every record and recompute records_root, not just file hashes. */
  deep?: boolean;
  from?: number;
  to?: number;
  /** Supplied by the git sink; absent means the anchor cannot be evaluated. */
  evaluateAnchor?: (seqs: number[]) => Promise<Omit<AnchorResult, 'proves' | 'doesNotProve'>>;
}

export async function verifyChain(
  sink: Sink,
  orgId: string,
  opts: VerifyOptions,
): Promise<VerifyReport> {
  const breaks: VerifyBreak[] = [];
  const degradedSources: DegradedSource[] = [];
  const degradations: Array<Degradation & { seq: number }> = [];
  let recordsChecked = 0;

  const all = await sink.listManifests(orgId);
  const seqs = all.filter((s) => s >= (opts.from ?? 1) && s <= (opts.to ?? Number.MAX_SAFE_INTEGER));

  let expectedPrev = opts.from && opts.from > 1 ? null : GENESIS_PREV;
  let previousSeq: number | null = null;
  let lastManifestHash: string | null = null;
  // Newest manifest's entry per metadata path; older entries are superseded and never compared.
  const newestMetadata = new Map<string, { seq: number; sha256: string }>();

  for (const seq of seqs) {
    if (previousSeq !== null && seq !== previousSeq + 1) {
      breaks.push({
        seq,
        kind: 'seq-gap',
        expected: String(previousSeq + 1),
        actual: String(seq),
      });
    }
    previousSeq = seq;

    const manifest = await sink.readManifest(orgId, seq);
    if (!manifest) {
      breaks.push({ seq, kind: 'missing-manifest' });
      expectedPrev = null;
      lastManifestHash = null;
      continue;
    }

    if (expectedPrev !== null && manifest.prev_manifest_hash !== expectedPrev) {
      breaks.push({
        seq,
        kind: 'prev-hash-mismatch',
        expected: expectedPrev,
        actual: manifest.prev_manifest_hash,
      });
    }

    for (const source of manifest.sources) {
      // Coverage the manifest itself admits it did not achieve. Read, not merely present:
      // this is the field that turns a clean chain over an incomplete archive into exit 4.
      if (source.status !== 'complete') {
        degradedSources.push({ seq, source: source.source, status: source.status });
      }

      const leafHashes: string[] = [];

      for (const entry of source.files) {
        let bytes: Buffer;
        try {
          bytes = await sink.readFile(entry.path);
        } catch (err) {
          // "We could not look" and "it is gone" are different findings, and reporting the
          // first as the second is the inversion this product exists to prevent. Only
          // ENOENT is evidence of deletion; EACCES, EIO and friends are evidence of nothing
          // except that verification was incomplete here.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            breaks.push({ seq, kind: 'missing-file', file: entry.path });
          } else {
            breaks.push({
              seq,
              kind: 'unreadable-file',
              file: entry.path,
              actual: code ?? (err as Error).message,
            });
          }
          continue;
        }

        const actual = `sha256:${sha256Hex(bytes)}`;
        if (actual !== entry.sha256) {
          breaks.push({
            seq,
            kind: 'file-hash-mismatch',
            file: entry.path,
            expected: entry.sha256,
            actual,
          });
        }

        if (opts.deep) {
          for (const line of bytes.toString('utf8').split('\n')) {
            if (line.length === 0) continue;
            recordsChecked += 1;
            // Re-canonicalise rather than trusting the stored line: a file whose bytes are
            // canonical by construction should round-trip identically, and a line that does
            // not is itself evidence of tampering. A verifier's job is to report tampering,
            // not to crash on it — a line that fails to parse is itself a break, not an
            // uncaught exception, and we keep checking the rest of the archive.
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              breaks.push({ seq, kind: 'malformed-record', file: entry.path });
              continue;
            }
            leafHashes.push(sha256Hex(canonicalBytes(parsed)));
          }
        }
      }

      if (opts.deep) {
        const actualRoot = `sha256:${merkleRoot(leafHashes)}`;
        if (actualRoot !== source.records_root) {
          breaks.push({
            seq,
            kind: 'records-root-mismatch',
            expected: source.records_root,
            actual: actualRoot,
          });
        }
      }
    }

    for (const d of manifest.degradations) degradations.push({ ...d, seq });
    for (const m of manifest.metadata ?? []) newestMetadata.set(m.path, { seq, sha256: m.sha256 });

    expectedPrev = manifestHash(manifest);
    lastManifestHash = expectedPrev;
  }

  const head = await sink.head(orgId);
  const headCheck = checkHead({
    head,
    breaks,
    seqs,
    lastSeq: previousSeq,
    lastManifestHash,
    toBounded: opts.to !== undefined,
  });

  const anchor = await evaluateAnchorResult(opts, seqs, !headComparisonSkipped(headCheck));
  if (!anchor.valid) breaks.push({ seq: 0, kind: 'anchor', actual: anchor.detail });

  // A failed anchor is not a broken chain (and vice versa). `verify --anchor git` against a
  // LocalSink must not print `chain: BROKEN` when nothing at all is wrong with the chain.
  const nonAnchorBreaks = breaks.filter((b) => b.kind !== 'anchor');
  const state: VerifyReport['chain']['state'] =
    seqs.length === 0 ? 'empty' : nonAnchorBreaks.length > 0 ? 'broken' : 'verified';

  return {
    orgId,
    manifestsChecked: seqs.length,
    recordsChecked,
    chain: { valid: state === 'verified', state, head, headCheck },
    range: seqs.length > 0 ? { from: seqs[0]!, to: seqs[seqs.length - 1]! } : null,
    fullChain: all.length > 0 && seqs.length === all.length,
    coverage: { degradedSources, degradations },
    anchor,
    breaks,
    notes: await metadataNotes(sink, newestMetadata),
    orphans: await sink.listOrphans(orgId),
  };
}

async function metadataNotes(
  sink: Sink,
  newest: Map<string, { seq: number; sha256: string }>,
): Promise<VerifyNote[]> {
  const notes: VerifyNote[] = [];
  for (const [file, { seq, sha256 }] of newest) {
    let actual: string;
    try {
      actual = `sha256:${sha256Hex(await sink.readFile(file))}`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      actual = code === 'ENOENT' ? 'missing' : (code ?? (err as Error).message);
    }
    if (actual !== sha256) notes.push({ seq, kind: 'metadata-changed', file, expected: sha256, actual });
  }
  return notes;
}

/**
 * Compare `head.json` against the chain that was walked, and record a break on disagreement.
 *
 * Without this, tail truncation is invisible: the newest manifest is referenced by no later
 * manifest, so deleting it and its record files leaves a shorter chain whose every remaining
 * link verifies clean. `head.json` is the only artifact that names the newest sequence.
 *
 * It is deliberately skipped when `--to` bounded the walk — the user asked for a subrange and
 * head.json is not expected to describe its end — and its absence is reported as its own
 * state rather than as a break, since `head.json` is a pointer, not evidence (SPEC.md §6.3).
 * Either way `anchorStatementsFor` drops the truncation clause from what the run claims.
 */
function checkHead(args: {
  head: ChainHead | null;
  breaks: VerifyBreak[];
  seqs: number[];
  lastSeq: number | null;
  lastManifestHash: string | null;
  toBounded: boolean;
}): HeadCheck {
  if (args.seqs.length === 0) return 'no-manifests';
  if (args.toBounded) return 'not-checked';
  if (!args.head) return 'absent';

  const seqMismatch = args.lastSeq !== null && args.head.seq !== args.lastSeq;
  const hashMismatch =
    args.lastManifestHash !== null && args.head.manifest_hash !== args.lastManifestHash;

  if (!seqMismatch && !hashMismatch) return 'matched';

  args.breaks.push({
    seq: args.head.seq,
    kind: 'head-mismatch',
    expected: `head.json: seq ${args.head.seq} ${args.head.manifest_hash}`,
    actual: `walked chain: seq ${args.lastSeq ?? 'none'} ${args.lastManifestHash ?? 'unknown'}`,
  });
  return 'mismatch';
}

/**
 * `HeadCheck` states in which the head-to-chain comparison never ran, so the caveat that
 * truncation of the newest manifests is not detected must survive in the printed statement.
 *
 * `'mismatch'` is deliberately absent from this set. A mismatch means the comparison ran and
 * caught something — head.json disagreeing with the chain that was walked is exactly the
 * evidence of truncation the caveat says was not looked for. Lumping it in with the states
 * where nothing ran is what produced a report that printed a `head-mismatch` break and, two
 * lines later, claimed head.json was never compared.
 */
function headComparisonSkipped(headCheck: HeadCheck): boolean {
  return headCheck === 'absent' || headCheck === 'not-checked' || headCheck === 'no-manifests';
}

async function evaluateAnchorResult(
  opts: VerifyOptions,
  seqs: number[],
  headVerified: boolean,
): Promise<AnchorResult> {
  if (opts.anchor === 'none') {
    return {
      mode: 'none',
      valid: true,
      ...anchorStatementsFor('none', { headVerified }),
    };
  }

  if (!opts.evaluateAnchor) {
    const detail = `The configured sink cannot evaluate the '${opts.anchor}' anchor.`;
    return {
      mode: opts.anchor,
      valid: false,
      detail,
      ...anchorStatementsFor(opts.anchor, { headVerified, valid: false }),
    };
  }

  const result = await opts.evaluateAnchor(seqs);
  return {
    ...result,
    // `valid` is passed through so the statements describe what this run established, not
    // what a passing anchor of this mode would have. A failed anchor proves nothing, and
    // must not print a sentence asserting the commits it just said were missing.
    ...anchorStatementsFor(opts.anchor, {
      headVerified,
      valid: result.valid,
      remote: result.remote,
      signedCommits: result.signedCommits,
      unsignedCommits: result.unsignedCommits,
    }),
  };
}
