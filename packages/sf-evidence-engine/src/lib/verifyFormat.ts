import { type AnchorMode } from '../chain/anchorStatements.js';
import { isGitSink } from '../sinks/git.js';
import { EXIT, type ExitCode } from './exit.js';
import type { VerifyOptions, VerifyReport } from '../chain/verifier.js';
import type { Sink } from '../types/sink.js';

/**
 * Pure logic for `sf evidence verify`, kept out of `commands/evidence/verify.ts` on purpose:
 * every decision `verify`'s `run()` makes lives here, not just formatting, so each one is
 * reachable by a unit test without constructing an oclif command.
 *
 * (Historically this split was forced: importing `@salesforce/sf-plugins-core` under this
 * repo's Jest+swc+vm-modules harness threw `Cannot access 'supportsColor' before
 * initialization` from chalk 5. That is now fixed by a `moduleNameMapper` chalk stub in
 * `jest.config.ts`, and `test/unit/commands/commands.test.ts` drives the real commands. The
 * split stays because it is the better structure, not because the harness demands it.)
 */

export function verifyExitCode(report: VerifyReport): ExitCode {
  // Ordered by severity, and the order is load-bearing. An integrity break outranks
  // everything; a run that verified nothing must never fall through to OK; recorded
  // degradations are the SPEC.md §8.3 exit-4 case and outrank a clean OK.
  if (report.breaks.length > 0) return EXIT.INTEGRITY;
  if (report.chain.state === 'empty') return EXIT.ERROR;
  if (hasRecordedDegradation(report)) return EXIT.DEGRADED;
  if (report.chain.headCheck === 'absent') return EXIT.DEGRADED;
  return EXIT.OK;
}

/**
 * Why a missing `head.json` exits 4 rather than 0, while still not being a break.
 *
 * It is correctly not a break: SPEC.md §6.3 makes head.json a pointer, not evidence, and the
 * chain is reconstructible without it — recording a break would assert the chain is broken
 * when nothing about it is.
 *
 * But exiting 0 was wrong. `LocalSink.putBatch` writes head.json last on every single batch,
 * so its absence over a non-empty chain is anomalous by construction: either an interrupted
 * first run, or deletion. And "delete the tail manifests *and* head.json" is the cheapest
 * competent form of the truncation attack this check exists to catch — every surviving link
 * verifies, and the only artifact naming the newest sequence is gone. That is the
 * configuration a motivated tamperer would actually choose, and it must not return green on
 * the channel CI reads. The README this release ships defines exit 0 as "success, full
 * coverage", which this state is not.
 *
 * Exit 4 is the honest code: the run completed, the chain it could see is intact, and a human
 * has to look. `--to` (headCheck 'not-checked') is deliberately excluded — the user asked for
 * a subrange, so head.json is not expected to describe its end.
 */

/** Whether the manifests themselves admit reduced coverage (SPEC.md §8.3, exit 4). */
export function hasRecordedDegradation(report: VerifyReport): boolean {
  return (
    report.coverage.degradedSources.length > 0 || report.coverage.degradations.length > 0
  );
}

/**
 * Decides whether `verify` can evaluate the requested anchor at all, and wires up the
 * GitSink's evaluator when it can.
 *
 * `GitSink.anchorOrgId` MUST be set before `evaluateAnchor` runs (it throws otherwise), so
 * that assignment happens here, at the point the decision to use it is made.
 *
 * Returns undefined whenever git anchoring cannot proceed (mode is not 'git', or the
 * resolved sink is not a GitSink): `verifyChain` treats a missing evaluator as "anchor
 * requested but not evaluable" and reports it as an anchor break, which is the correct
 * outcome — never silently falling back to unanchored verification.
 */
export function resolveEvaluateAnchor(
  anchor: AnchorMode,
  sink: Sink,
  orgId: string,
): VerifyOptions['evaluateAnchor'] {
  if (anchor === 'git' && isGitSink(sink)) {
    sink.anchorOrgId = orgId;
    return (seqs) => sink.evaluateAnchor(seqs);
  }
  return undefined;
}

/**
 * Human-readable verification output.
 *
 * The `Does not prove` line is mandatory and unconditional (SPEC.md §6.5). Verification
 * output that states only what it proves is the exact overclaim this product exists to be
 * the opposite of: a hash chain alone is recomputable by whoever holds the archive, so this
 * line prints on every success as well as every failure, for every anchor mode.
 *
 * Three things here exist because a green line was previously printed over an unchecked
 * condition: the `NOTHING VERIFIED` state (zero manifests is not a pass), the range line
 * (a subrange must not print an unqualified VALID), and the coverage block (a clean chain
 * over an archive that is missing a month is not an all-clear).
 */
export function formatVerifyReport(report: VerifyReport): string[] {
  const out: string[] = [];
  out.push(`org ${report.orgId}`);
  out.push(`manifests checked: ${report.manifestsChecked}`);
  if (report.recordsChecked > 0) out.push(`records checked:   ${report.recordsChecked}`);

  if (report.range && !report.fullChain) {
    out.push(
      `range checked:     seq ${report.range.from}–${report.range.to}  ` +
        '(a subrange, not the whole chain)',
    );
  }

  out.push(`chain: ${chainLabel(report)}`);
  if (report.chain.state === 'empty') {
    out.push(
      '  No manifests were found for this org in this archive. Nothing was checked, so ' +
        'nothing was verified. Confirm --org-id and --archive (and --from/--to if you ' +
        'passed them) name an archive that actually holds data.',
    );
  }

  for (const line of headLines(report)) out.push(`  ${line}`);

  out.push(`anchor: ${report.anchor.mode} — ${report.anchor.valid ? 'valid' : 'INVALID'}`);
  for (const line of anchorDetailLines(report)) out.push(`  ${line}`);

  out.push('');
  out.push(`Proves:         ${report.anchor.proves}`);
  out.push(`Does not prove: ${report.anchor.doesNotProve}`);

  for (const line of coverageLines(report)) out.push(line);

  if (report.breaks.length > 0) {
    out.push('');
    out.push('Breaks:');
    for (const b of report.breaks) {
      const where = b.file ? ` ${b.file}` : '';
      const detail = b.expected ? ` expected ${b.expected} got ${b.actual}` : '';
      out.push(`  seq ${b.seq}  ${b.kind}${where}${detail}`);
    }
  }

  if (report.notes.length > 0) {
    out.push('');
    for (const n of report.notes) {
      out.push(
        `note: ${n.file} differs from the manifest at seq ${n.seq} (metadata changed; ` +
          'metadata is not evidence and this does not break the chain).',
      );
    }
  }

  if (report.orphans.length > 0) {
    out.push('');
    out.push(
      `${report.orphans.length} orphan file(s) present — not referenced by any manifest, ` +
        'most likely from an interrupted run. Orphans are not evidence and do not break the chain.',
    );
  }

  return out;
}

function chainLabel(report: VerifyReport): string {
  switch (report.chain.state) {
    case 'verified':
      return 'VALID';
    case 'broken':
      return 'BROKEN';
    default:
      return 'NOTHING VERIFIED';
  }
}

/** What the head pointer did or did not establish. Never silent when it established nothing. */
function headLines(report: VerifyReport): string[] {
  switch (report.chain.headCheck) {
    case 'matched':
      return [`head.json matches the newest manifest checked (seq ${report.chain.head?.seq}).`];
    case 'mismatch':
      return [
        'head.json does NOT match the chain on disk — see the head-mismatch break below. ' +
          'Manifests may have been removed from the end of the chain.',
      ];
    case 'absent':
      return [
        'head.json is absent, so the end of the chain is unverified: truncation of the ' +
          'newest manifests cannot be ruled out by this run.',
      ];
    case 'not-checked':
      return [
        '--to bounded this walk, so head.json was not compared against it: truncation of ' +
          'the newest manifests is outside what this run checked.',
      ];
    default:
      return [];
  }
}

/**
 * Signature counts and remote presence, rendered rather than discarded.
 *
 * `GitSink` computes all four of these and `--json` already carries them; printing only
 * `anchor: git — valid` while the guarantee's whole strength turns on "signed?" and
 * "remote?" is how the text output came to claim more than the run established.
 */
function anchorDetailLines(report: VerifyReport): string[] {
  const lines: string[] = [];
  if (report.anchor.detail) lines.push(report.anchor.detail);
  if (report.anchor.mode !== 'git') return lines;

  const signed = report.anchor.signedCommits;
  const unsigned = report.anchor.unsignedCommits;
  const bad = report.anchor.badSignatures;

  if (signed !== undefined || unsigned !== undefined || bad !== undefined) {
    lines.push(
      `commits: ${signed ?? 0} signed, ${unsigned ?? 0} unsigned, ` +
        `${bad ?? 0} with a signature git rejected`,
    );
  }

  if (report.anchor.remote !== undefined) {
    lines.push(
      report.anchor.remote
        ? 'remote:  configured — history rewrites are visible to the git host'
        : 'remote:  NONE — this repository is local only; nothing outside this machine ' +
            'has seen these commits',
    );
  }

  return lines;
}

/**
 * Coverage the manifests themselves record as reduced (SPEC.md §8.3, exit 4).
 *
 * `collect` warns and exits 4 into terminal scrollback. A week later the auditor runs
 * `verify`; without this block they would see `chain: VALID` and exit 0 with nothing
 * hinting that a month was never collected.
 */
function coverageLines(report: VerifyReport): string[] {
  if (!hasRecordedDegradation(report)) return [];

  const out: string[] = ['', 'COVERAGE — the manifests record reduced coverage:'];

  for (const s of report.coverage.degradedSources) {
    out.push(`  seq ${s.seq}  ${s.source}: ${s.status}`);
  }
  for (const d of report.coverage.degradations) {
    out.push(`  seq ${d.seq}  ${d.source}: ${d.code} — ${d.detail}`);
    out.push(`           → ${d.remediation}`);
  }

  out.push(
    '  The chain over this data may be intact while the data itself is incomplete. An ' +
      'intact chain proves nothing about what was never collected.',
  );
  return out;
}

export const ALGORITHM = `sf-evidence hash chain (SPEC.md §6.2)

  record_hash   = SHA-256( JCS(record) )
  records_root  = Merkle root over record_hash values, in leaf order,
                  binary tree, last node duplicated when a level has odd length
  file_sha256   = SHA-256( raw bytes of the .ndjson file )
  manifest_hash = SHA-256( JCS(manifest) )

Leaf order for records_root is defined across the whole source entry, not per file: take
the files of sources[i].files in that array's order, and within each file its records in
line order, then concatenate. One source entry therefore has exactly one root even when a
run wrote several monthly files — which the default first run does, because it backfills
180 days and partitions by calendar month.

A source that produced no records has an empty leaf list, and its records_root is the
SHA-256 of the empty byte string:
  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

JCS is RFC 8785 JSON Canonicalization. Each NDJSON line is already canonical, so a record
can be hashed directly from the file with no re-serialisation.

A manifest never contains its own hash: it appears only in the next manifest's
prev_manifest_hash, and in head.json. The genesis manifest's prev_manifest_hash is
"sha256:" followed by 64 zeros.

head.json is { seq, manifest_hash, updated_at } and is a pointer, not evidence — but it is
the only artifact naming the newest sequence, so a verifier that never compares it against
the manifests it walked cannot detect manifests removed from the end of the chain.

Verifying this archive requires only a JCS implementation and SHA-256. No CloudCounsel
software, and no network.`;

/**
 * `--explain-algorithm` runs no verification at all, so its return value must not be able to
 * be mistaken for one. It deliberately carries no `chain`, `anchor`, `breaks` or `orphans`
 * fields — a discriminated variant, not a `VerifyReport` with a marker flag — so a `--json`
 * consumer whose natural check is `breaks.length === 0` cannot read "no breaks" as "verified
 * clean" for a run that verified nothing. See EvidenceVerify.run in ../commands/evidence/
 * verify.ts, which returns this instead of a VerifyReport on the --explain-algorithm path,
 * and never calls verifyExitCode for it.
 */
export interface AlgorithmExplanation {
  mode: 'explain-algorithm';
  algorithm: string;
}

export const ALGORITHM_EXPLANATION: AlgorithmExplanation = {
  mode: 'explain-algorithm',
  algorithm: ALGORITHM,
};
