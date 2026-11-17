import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { verifyChain, type VerifyReport } from '@cclabsnz/sf-evidence-engine';
import { type AnchorMode } from '@cclabsnz/sf-evidence-engine';
import { DEFAULT_ARCHIVE, resolveSink } from '../../lib/flags.js';
import { setExitCode } from '@cclabsnz/sf-evidence-engine';
import {
  ALGORITHM,
  ALGORITHM_EXPLANATION,
  formatVerifyReport,
  resolveEvaluateAnchor,
  verifyExitCode,
  type AlgorithmExplanation,
} from '@cclabsnz/sf-evidence-engine';

// Re-exported so the module's public shape matches earlier callers/tests that expect these
// names on the command module itself. The actual logic — and everything this repo's test
// harness can import — lives in ../../lib/verifyFormat.js; see that file's header comment.
export {
  ALGORITHM,
  ALGORITHM_EXPLANATION,
  formatVerifyReport,
  resolveEvaluateAnchor,
  verifyExitCode,
};
export type { AlgorithmExplanation };

export default class EvidenceVerify extends SfCommand<VerifyReport | AlgorithmExplanation> {
  public static readonly summary = 'Validate the archive hash chain and its anchor';

  public static readonly description = `Walks every manifest, recomputes its hash, and checks it against the next manifest's
prev_manifest_hash. Verifies each referenced file's SHA-256; with --deep, re-hashes every
record and recomputes the Merkle root.

This command contacts no Salesforce org and no network.

A hash chain alone proves internal consistency only: whoever holds the archive can rewrite
every link. Use --anchor git to additionally require that each manifest was committed to a
repository whose history the git host protects. The output always names what the chosen
mode does and does not prove.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --org-id 00D5j000000AbCdEAK',
    '<%= config.bin %> <%= command.id %> --org-id 00D5j000000AbCdEAK --anchor git --deep',
    '<%= config.bin %> <%= command.id %> --explain-algorithm',
  ];

  public static readonly flags = {
    'org-id': Flags.string({ summary: 'Org id partition to verify.', required: false }),
    archive: Flags.string({ summary: 'Archive root directory.', default: DEFAULT_ARCHIVE }),
    sink: Flags.string({ summary: 'Sink holding the archive.', default: 'local' }),
    anchor: Flags.string({
      summary: 'Anchor to evaluate.',
      options: ['none', 'git'],
      default: 'none',
    }),
    deep: Flags.boolean({
      summary: 'Re-hash every record and recompute the Merkle root.',
      default: false,
    }),
    from: Flags.integer({ summary: 'First manifest sequence to check.' }),
    to: Flags.integer({
      summary:
        'Last manifest sequence to check. Suppresses the head.json comparison, so truncation of the newest manifests is not checked.',
    }),
    'require-signed': Flags.boolean({
      summary: 'git anchor: treat any unsigned manifest commit as an anchor failure.',
      default: false,
    }),
    'explain-algorithm': Flags.boolean({
      summary: 'Print the hashing formulas and exit, so the procedure is self-documenting.',
      default: false,
    }),
  };

  public async run(): Promise<VerifyReport | AlgorithmExplanation> {
    const { flags } = await this.parse(EvidenceVerify);

    if (flags['explain-algorithm']) {
      this.log(ALGORITHM);
      return ALGORITHM_EXPLANATION;
    }

    if (!flags['org-id']) {
      throw new Error('--org-id is required (or pass --explain-algorithm).');
    }

    const sink = resolveSink(flags.sink, flags.archive, {
      requireSigned: flags['require-signed'],
    });
    await sink.init();

    const anchor = flags.anchor as AnchorMode;
    const evaluateAnchor = resolveEvaluateAnchor(anchor, sink, flags['org-id']);

    const report = await verifyChain(sink, flags['org-id'], {
      anchor,
      deep: flags.deep,
      from: flags.from,
      to: flags.to,
      evaluateAnchor,
    });

    for (const line of formatVerifyReport(report)) this.log(line);

    // Non-throwing, so --json keeps `result`: `breaks[]` is the payload a consumer needs
    // precisely on the runs that exit non-zero.
    setExitCode(verifyExitCode(report));
    return report;
  }
}
