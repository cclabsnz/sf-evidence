export type AnchorMode = 'none' | 'git' | 'object-lock';

export interface AnchorStatementPair {
  proves: string;
  doesNotProve: string;
}

/**
 * What each verification mode proves, and what it does not (SPEC.md §6.5).
 *
 * A hash chain alone is recomputable by whoever holds the archive: an adversary with write
 * access can edit a record, re-hash it, rebuild every subsequent manifest, and present a
 * perfectly self-consistent chain. Chain-only verification detects careless tampering, not
 * competent tampering. `verify` prints the matching pair for whichever mode ran, so the
 * output can never overstate the guarantee.
 *
 * These are the *baseline* statements — the strongest form of each claim, true only of the
 * strongest configuration of that mode. They are not what `verify` prints. `verify` prints
 * `anchorStatementsFor()`, which weakens `proves` to match what the run actually established:
 *
 * - `none` only detects truncation of the newest manifests if it compared `head.json` against
 *   the chain it walked. A `--to`-bounded subrange, or a missing `head.json`, cannot.
 * - `git` only earns the force-push clause if the repository has a remote whose host enforces
 *   and logs branch protection, and only earns the signing-key clause if commits are signed.
 *   A local-only repository of unsigned commits is rewritten with nothing but local write
 *   access — which the adversary who can edit the archive already has.
 */
export const ANCHOR_STATEMENTS: Record<AnchorMode, AnchorStatementPair> = {
  none: {
    proves:
      'Internal consistency. Any single-point edit, truncation, or reordering of the archive is detected.',
    doesNotProve:
      'Anything against an adversary who can rewrite the whole chain. Whoever holds the archive can edit a record, re-hash it, and rebuild every later manifest.',
  },
  git: {
    proves:
      'Each manifest was committed at a point in the repository history, and — where commits are signed — that a holder of the signing key committed it. Rewriting history requires the key and a force-push past branch protection, which the git host logs independently.',
    doesNotProve:
      'That the signer was honest. This protects against third parties and after-the-fact edits, not against the key holder at the time of writing.',
  },
  'object-lock': {
    proves:
      'Each manifest object carries a storage-side retention lock in COMPLIANCE mode with a future retain-until date. Rewriting it requires the storage provider to break its own retention guarantee.',
    doesNotProve:
      'That the object was written when it claims. Object Lock proves immutability from the moment of write, not the time of collection.',
  },
};

/**
 * What `verify` actually checked, as far as it changes what the run can claim.
 *
 * Every field is optional and every default is the *weaker* reading: a caller who supplies
 * nothing gets the statement for a run that verified the least, never the most.
 */
export interface AnchorStatementContext {
  /**
   * `none` / every mode: `head.json` was actually compared against the last manifest walked —
   * true whether that comparison agreed (`'matched'`) or disagreed (`'mismatch'`); a mismatch
   * is the check succeeding at its purpose, not the check being skipped. False only when the
   * comparison never ran at all: the head pointer was absent, or was deliberately not
   * consulted because a `--to`-bounded subrange was requested.
   */
  headVerified?: boolean;
  /** `git`: the repository has at least one remote configured. */
  remote?: boolean;
  /** `git`: manifest commits carrying a signature git accepted. */
  signedCommits?: number;
  /** `git`: manifest commits carrying no signature at all. */
  unsignedCommits?: number;
  /**
   * Whether the anchor was actually evaluated and passed.
   *
   * `false` means this run established nothing about the anchor — either the sink could not
   * evaluate it (`verify --sink local --anchor git`) or the evaluation failed. The
   * statements must then describe an unanchored archive, not the guarantee the anchor would
   * have provided if it had held. Undefined is read as "valid": it is the shape a caller
   * uses when describing what a passing anchor of this mode means.
   */
  valid?: boolean;
}

const TRUNCATION_CAVEAT =
  ' Truncation of the newest manifests is NOT detected by this run: head.json was not ' +
  'compared against the chain that was walked, and the newest manifest is bound by nothing ' +
  '— no later manifest carries its hash.';

/**
 * The statements `verify` prints, weakened to match what this particular run established.
 *
 * The point of the product is that no sentence it emits is stronger than what it computed.
 * These strings are therefore assembled from what the run found, not selected from a table
 * of best-case wordings.
 */
export function anchorStatementsFor(
  mode: AnchorMode,
  ctx: AnchorStatementContext = {},
): AnchorStatementPair {
  if (mode === 'none') return noneStatements(ctx);
  if (ctx.valid === false) return unestablishedStatements(mode);
  if (mode === 'git') return gitStatements(ctx);
  return ANCHOR_STATEMENTS['object-lock'];
}

/**
 * What an anchor that was never established proves: nothing.
 *
 * The git text used to open "Each manifest was committed at a point in this repository
 * history" on every path, including the ones where no commit was found or no evaluator
 * existed at all. `verify --sink local --anchor git` therefore printed
 * "The configured sink cannot evaluate the 'git' anchor." and, two lines later, an
 * assertion that every manifest had been committed. A report that contradicts itself
 * within one screen is worse than one that says less.
 */
function unestablishedStatements(mode: AnchorMode): AnchorStatementPair {
  return {
    proves: `Nothing about the '${mode}' anchor — this run did not establish it. See the anchor line above for why. Only the chain result printed above applies.`,
    doesNotProve: `Anything the '${mode}' anchor would have added. No external constraint on an adversary was demonstrated, so treat this as an unanchored archive: whoever holds it can edit a record, re-hash it, and rebuild every later manifest.`,
  };
}

function noneStatements(ctx: AnchorStatementContext): AnchorStatementPair {
  if (ctx.headVerified) return ANCHOR_STATEMENTS.none;
  return {
    proves:
      'Internal consistency of the manifests that were checked. Any single-point edit or ' +
      'reordering within that range is detected.' +
      TRUNCATION_CAVEAT,
    doesNotProve: ANCHOR_STATEMENTS.none.doesNotProve,
  };
}

function gitStatements(ctx: AnchorStatementContext): AnchorStatementPair {
  const signed = ctx.signedCommits ?? 0;
  const unsigned = ctx.unsignedCommits ?? 0;
  const remote = ctx.remote === true;

  const parts: string[] = ['Each manifest was committed at a point in this repository history'];

  if (signed > 0 && unsigned === 0) {
    parts.push(
      `, and every one of the ${signed} manifest commit(s) carries a signature git accepted, ` +
        'so a holder of the signing key committed it',
    );
  } else if (signed > 0) {
    parts.push(
      `, and ${signed} of ${signed + unsigned} manifest commit(s) carry a signature git ` +
        `accepted; the remaining ${unsigned} are unsigned and their authorship is ` +
        'self-asserted metadata',
    );
  } else {
    parts.push(
      '. No manifest commit is signed, so commit authorship here is self-asserted metadata ' +
        'that anyone with write access to this repository can set',
    );
  }

  if (remote) {
    parts.push(
      signed > 0
        ? '. Rewriting that history requires the signing key and a force-push past the remote ' +
            "host's branch protection, which the host logs independently"
        : ". Rewriting that history requires a force-push past the remote host's branch " +
            'protection, which the host logs independently — but nothing here binds a rewritten ' +
            'commit to any particular author',
    );
  } else {
    parts.push(
      '. This repository has NO remote configured, so rewriting its history requires only ' +
        'local write access to the archive directory — the same access an adversary who can ' +
        'edit the archive already has. Push it to a host that enforces and logs branch ' +
        'protection before treating this as an external anchor',
    );
  }

  const proves = `${parts.join('')}.`;

  const doesNotProve =
    signed > 0
      ? ANCHOR_STATEMENTS.git.doesNotProve +
        (remote
          ? ''
          : ' And with no remote, it establishes nothing a holder of the archive directory could not manufacture.')
      : 'That any particular person produced these commits, or that they existed before now. ' +
        'With no signatures' +
        (remote ? '' : ' and no remote') +
        ', commit author, committer and date are all values the writer chose.';

  return { proves, doesNotProve };
}
