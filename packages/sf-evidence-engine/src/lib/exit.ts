/**
 * Process exit codes, uniform across every `sf evidence` command (SPEC.md §8.0).
 *
 * DEGRADED (4) is the code that makes the no-silent-gaps constraint enforceable in CI:
 * a scheduled job treating non-zero as failure surfaces reduced coverage on the day it
 * starts, not the day an auditor asks.
 */
export const EXIT = Object.freeze({
  /** Success, full coverage. */
  OK: 0,
  /** Unexpected error. */
  ERROR: 1,
  /** Usage error (oclif default). */
  USAGE: 2,
  /** Chain broken, anchor invalid, or coverage at risk of breaching retention. */
  INTEGRITY: 3,
  /** Completed, but coverage was reduced. Data written; a human must look. */
  DEGRADED: 4,
  /** Licence required, missing, invalid or expired. Reserved; unused in Phase 0. */
  LICENCE: 5,
});

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Set the process exit code without throwing.
 *
 * `SfCommand.exit()` throws, which turns the `--json` envelope into the error form and
 * discards `result` — exactly when it matters most: `collect`'s degradation detail on the
 * degraded run, `verify`'s `breaks[]` when there are breaks. SPEC.md §8.2's worked JSON
 * example shows a degraded source *inside* `result`, so the payload has to survive a
 * non-zero exit.
 *
 * Assigning `process.exitCode` is the non-throwing path: oclif does not force `process.exit(0)`
 * on the success path, and `SfCommand`'s JSON envelope reads `status` from `process.exitCode`,
 * so the envelope reports the right code *and* keeps the payload.
 */
export function setExitCode(code: ExitCode): void {
  if (code !== EXIT.OK) process.exitCode = code;
}
