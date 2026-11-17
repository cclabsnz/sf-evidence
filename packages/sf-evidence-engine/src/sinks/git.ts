import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalSink } from './local.js';
import { manifestPath, headPath, isStatePath } from './layout.js';
import type { PreparedBatch, PutOutcome, Sink, SinkCapabilities, SinkDescription, SinkId } from '../types/sink.js';

const run = promisify(execFile);

export interface GitSinkOptions {
  /** Sign commits with the customer's key. We never generate or hold a key. */
  sign?: boolean;
  /** Anchor verification fails on any unsigned commit. */
  requireSigned?: boolean;
}

/**
 * LocalSink plus a commit per batch (SPEC.md §7.4).
 *
 * The commit chain is a second chain over the same data — but only as independent as the
 * repository's configuration makes it. Signed commits pushed to a host that enforces and
 * logs branch protection cost an attacker the key *and* a force-push the host records; an
 * unsigned, remote-less repository — what this sink produces by default — costs an attacker
 * nothing beyond the local write access they already needed to edit the archive.
 * `evaluateAnchor` therefore reports signature counts and remote presence, and
 * `anchorStatementsFor` narrows what `verify --anchor git` claims to whichever of those two
 * situations actually holds.
 *
 * Pushing is never automatic. `collect` commits locally and reports that a push is pending,
 * because an automatic push is an egress action the operator did not necessarily authorise.
 */
export class GitSink extends LocalSink {
  public override readonly id: SinkId = 'git';

  public override readonly capabilities: SinkCapabilities = {
    canonical: true,
    readable: true,
    queryable: true,
    supportsObjectLock: false,
    anchors: ['git'],
  };

  /** The chain is per-org; verification is invoked per-org, so this is set by the caller. */
  public anchorOrgId = '';

  public constructor(root: string, private readonly opts: GitSinkOptions = {}) {
    super(root);
  }

  public override describe(): SinkDescription {
    return {
      id: this.id,
      location: this.root,
      note: 'git repository, local commits only',
      credentialSource: 'none (no push is performed)',
      anchors: this.capabilities.anchors,
    };
  }

  public override async init(): Promise<void> {
    await super.init();
    try {
      await this.git(['rev-parse', '--git-dir']);
    } catch {
      // C5: `git init` would be provisioning. We instruct instead.
      throw new Error(
        `Archive root is not a git repository: ${this.root}\n` +
          `Run git init yourself and re-run this command:  git -C ${this.root} init -b main`,
      );
    }
  }

  public override async putBatch(batch: PreparedBatch): Promise<PutOutcome> {
    // The LocalSink write IS the archiving step: record files, then manifest, then head.
    // Everything below is the *anchor* step, and it runs after the evidence is already on
    // disk. Letting a commit failure propagate made the caller report a total sink failure
    // — and, with no other canonical sink, made `runCollect` tell the operator that nothing
    // was archived — for a batch that had been written in full. The two failures are
    // different and are now reported differently.
    const out = await super.putBatch(batch);

    try {
      // Named paths only, never `git add -A`, and never `_state/`: state is a derived,
      // disposable cache (SPEC.md §5.4) and must not enter the anchor chain looking like
      // evidence. The filter is a guard; no batch file should ever be a state path.
      const paths = [
        ...batch.files.map((f) => f.relPath),
        manifestPath(batch.orgId, batch.manifest.seq),
        headPath(batch.orgId),
      ].filter((p) => !isStatePath(p));
      await this.git(['add', '--', ...paths]);

      const source = batch.manifest.sources[0];
      const subject =
        `evidence: seq ${batch.manifest.seq} ${source?.source ?? 'none'} ` +
        `${source?.record_count ?? 0} records`;
      const body =
        `manifest: ${out.manifestHash}\n` +
        `prev:     ${batch.manifest.prev_manifest_hash}\n` +
        `org:      ${batch.orgId}`;

      const commitArgs = ['commit', '-m', subject, '-m', body];
      if (this.opts.sign) commitArgs.splice(1, 0, '-S');
      await this.git(commitArgs);

      const commit = (await this.git(['rev-parse', 'HEAD'])).trim();
      return { ...out, commit, pushPending: await this.hasRemote() };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ...out,
        anchorError:
          `the batch was archived, but the git anchor commit failed: ${detail.trim()}. ` +
          `Sequence ${batch.manifest.seq} is on disk and verifies; it is not committed, so ` +
          '`verify --anchor git` will report it as uncommitted until you commit it yourself.',
      };
    }
  }

  /** Matches VerifyOptions['evaluateAnchor']. */
  public async evaluateAnchor(seqs: number[]): Promise<{
    mode: 'git';
    valid: boolean;
    detail?: string;
    signedCommits: number;
    unsignedCommits: number;
    /**
     * Commits where git itself rejected the signature (`B`), or reported a status this sink
     * does not recognise. Distinct from `unsignedCommits`: unsigned is a policy choice an
     * organisation may make deliberately (gated behind `requireSigned`); a bad signature is
     * evidence that the commit was altered or the signature forged, which is never
     * acceptable for an anchor whose whole purpose is tamper-evidence. Unrecognised statuses
     * are counted here too — failing closed, not assuming "unsigned" for something unknown.
     */
    badSignatures: number;
    /**
     * Whether this repository has a remote configured.
     *
     * Reported because the anchor's headline claim turns on it. "Rewriting history requires
     * a force-push past branch protection, which the git host logs independently" is only
     * true when there is a host: in a local-only repository, rewriting requires nothing but
     * write access to the archive directory — exactly the access the adversary this anchor
     * is supposed to constrain already has. `anchorStatementsFor` consumes this to choose
     * the wording, so the claim can never outrun the configuration.
     */
    remote: boolean;
  }> {
    if (!this.anchorOrgId) {
      throw new Error('GitSink.anchorOrgId must be set before evaluating the git anchor.');
    }

    const remote = await this.hasRemote();

    let signed = 0;
    let unsigned = 0;
    let bad = 0;
    const missing: number[] = [];

    for (const seq of seqs) {
      // %G? is G (good), U (good, untrusted), B (bad), N (no signature).
      const log = await this.git([
        'log',
        '--format=%G?',
        '-1',
        '--',
        manifestPath(this.anchorOrgId, seq),
      ]).catch(() => '');

      const status = log.trim();
      if (status === '') missing.push(seq);
      else if (status === 'G' || status === 'U') signed += 1;
      else if (status === 'N') unsigned += 1;
      else bad += 1; // 'B', or anything unrecognised — fail closed rather than call it unsigned.
    }

    // Ordering matters: a forged/invalid signature is the most serious signal this sink can
    // report, so it takes precedence over a missing-commit or unsigned-commit message even
    // when both conditions hold for the same evaluation.
    if (bad > 0) {
      return {
        mode: 'git',
        valid: false,
        detail:
          `${bad} manifest commit(s) failed git signature verification — git itself rejected ` +
          `the signature. This indicates the commit was altered or the signature forged.`,
        signedCommits: signed,
        unsignedCommits: unsigned,
        badSignatures: bad,
        remote,
      };
    }

    if (missing.length > 0) {
      return {
        mode: 'git',
        valid: false,
        detail: `Manifest(s) not committed to git: ${missing.map((s) => `seq ${s}`).join(', ')}.`,
        signedCommits: signed,
        unsignedCommits: unsigned,
        badSignatures: bad,
        remote,
      };
    }

    if (this.opts.requireSigned && unsigned > 0) {
      return {
        mode: 'git',
        valid: false,
        detail: `${unsigned} manifest commit(s) are unsigned; signatures are required by configuration.`,
        signedCommits: signed,
        unsignedCommits: unsigned,
        badSignatures: bad,
        remote,
      };
    }

    return {
      mode: 'git',
      valid: true,
      signedCommits: signed,
      unsignedCommits: unsigned,
      badSignatures: bad,
      remote,
    };
  }

  private async hasRemote(): Promise<boolean> {
    return (await this.git(['remote'])).trim().length > 0;
  }

  /** execFile, never a shell: arguments are passed as an array so nothing is interpolated. */
  private async git(args: string[]): Promise<string> {
    const { stdout } = await run('git', ['-C', this.root, ...args]);
    return stdout;
  }
}

/**
 * Whether a sink is a git sink, judged by shape rather than class identity.
 *
 * `instanceof GitSink` fails for a GitSink built by a second installed copy of this package,
 * which happens when a host depends on the engine directly and also on
 * @cclabsnz/sf-evidence, and the two ranges don't dedupe. Callers use this to decide whether
 * to evaluate the git anchor, so a false negative would silently skip anchor evaluation.
 */
export function isGitSink(sink: Sink): sink is GitSink {
  return sink.id === 'git' && typeof (sink as Partial<GitSink>).evaluateAnchor === 'function';
}

