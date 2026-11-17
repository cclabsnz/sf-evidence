import { ANCHOR_STATEMENTS, anchorStatementsFor } from '../../../src/chain/anchorStatements.js';

/**
 * These strings are the product's honesty requirement in code form (SPEC.md §6.5). Selling
 * "tamper-evident" while shipping chain-only verification would be exactly the claim this
 * product exists to be the opposite of, so the caveat is data, not formatting, and it is
 * tested.
 */
describe('ANCHOR_STATEMENTS', () => {
  it('covers every anchor mode', () => {
    expect(Object.keys(ANCHOR_STATEMENTS).sort()).toEqual(['git', 'none', 'object-lock']);
  });

  it('states plainly that chain-only verification does not stop a full rewrite', () => {
    expect(ANCHOR_STATEMENTS.none.doesNotProve).toMatch(/rewrite the whole chain/i);
  });

  it('never leaves a doesNotProve empty', () => {
    for (const [mode, s] of Object.entries(ANCHOR_STATEMENTS)) {
      expect(s.proves.length).toBeGreaterThan(20);
      expect(s.doesNotProve.length).toBeGreaterThan(20);
      expect(mode).toBeTruthy();
    }
  });
});

/**
 * `ANCHOR_STATEMENTS` is the baseline wording — the strongest form of each claim, true only
 * of the strongest configuration. What `verify` actually prints comes from
 * `anchorStatementsFor`, which weakens it to whatever the run established.
 */
describe('anchorStatementsFor — none', () => {
  it('claims truncation detection only when head.json was compared', () => {
    expect(anchorStatementsFor('none', { headVerified: true }).proves).toBe(
      ANCHOR_STATEMENTS.none.proves,
    );
  });

  it('drops the truncation claim when head.json was not compared', () => {
    const s = anchorStatementsFor('none', { headVerified: false });
    expect(s.proves).not.toMatch(/edit, truncation, or reordering/);
    expect(s.proves).toMatch(/Truncation of the newest manifests is NOT detected/);
  });

  it('defaults to the weaker reading when the caller says nothing', () => {
    // A caller who supplies no context must never be handed the stronger claim by accident.
    expect(anchorStatementsFor('none').proves).toMatch(/NOT detected/);
  });

  it('keeps the doesNotProve caveat unconditional', () => {
    for (const headVerified of [true, false]) {
      expect(anchorStatementsFor('none', { headVerified }).doesNotProve).toBe(
        ANCHOR_STATEMENTS.none.doesNotProve,
      );
    }
  });
});

describe('anchorStatementsFor — git', () => {
  const local = { remote: false, signedCommits: 0, unsignedCommits: 5 };

  it('does not claim a force-push past branch protection when there is no remote', () => {
    // This is the only configuration Phase 0 produces by default. The unconditional claim
    // was false for it: rewriting an unsigned, remote-less repository takes only the local
    // write access the adversary already needed to edit the archive.
    const s = anchorStatementsFor('git', local);
    expect(s.proves).not.toMatch(/force-push/);
    expect(s.proves).not.toMatch(/host logs independently/);
    expect(s.proves).toMatch(/NO remote configured/);
    expect(s.proves).toMatch(/only local write access/);
  });

  it('does not claim a signing key when no commit is signed', () => {
    const s = anchorStatementsFor('git', local);
    expect(s.proves).toMatch(/No manifest commit is signed/);
    expect(s.proves).toMatch(/self-asserted metadata/);
    expect(s.doesNotProve).toMatch(/That any particular person produced these commits/);
  });

  it('earns the force-push clause once a remote is configured', () => {
    const s = anchorStatementsFor('git', { remote: true, signedCommits: 5, unsignedCommits: 0 });
    expect(s.proves).toMatch(/force-push past the remote host's branch protection/);
    expect(s.proves).toMatch(/signing key/);
    expect(s.doesNotProve).toBe(ANCHOR_STATEMENTS.git.doesNotProve);
  });

  it('reports a mixed signed/unsigned repository as mixed, not as signed', () => {
    const s = anchorStatementsFor('git', { remote: true, signedCommits: 3, unsignedCommits: 2 });
    expect(s.proves).toMatch(/3 of 5 manifest commit\(s\)/);
    expect(s.proves).toMatch(/remaining 2 are unsigned/);
  });

  it('qualifies the signed claim when the repository has no remote', () => {
    const s = anchorStatementsFor('git', { remote: false, signedCommits: 5, unsignedCommits: 0 });
    expect(s.doesNotProve).toMatch(/with no remote/i);
  });

  it('defaults to the weakest git reading when the caller says nothing', () => {
    const s = anchorStatementsFor('git');
    expect(s.proves).toMatch(/NO remote configured/);
    expect(s.proves).toMatch(/No manifest commit is signed/);
  });
});

describe('anchorStatementsFor — an anchor that was never established', () => {
  it('claims nothing about git when the evaluation failed', () => {
    // The git text used to open "Each manifest was committed at a point in this repository
    // history" on every path, so a report saying "Manifest(s) not committed to git: seq 3."
    // asserted the opposite two lines later.
    const s = anchorStatementsFor('git', { valid: false, remote: true, signedCommits: 3 });
    expect(s.proves).not.toMatch(/Each manifest was committed/);
    expect(s.proves).toMatch(/did not establish it/);
    expect(s.proves).toMatch(/'git'/);
  });

  it('tells the reader to treat the archive as unanchored', () => {
    const s = anchorStatementsFor('git', { valid: false });
    expect(s.doesNotProve).toMatch(/unanchored archive/);
    expect(s.doesNotProve).toMatch(/rebuild every later manifest/);
  });

  it('does not leak the remote or signing clauses into a failed evaluation', () => {
    const s = anchorStatementsFor('git', { valid: false, remote: false, unsignedCommits: 5 });
    expect(s.proves).not.toMatch(/NO remote configured/);
    expect(s.proves).not.toMatch(/No manifest commit is signed/);
  });

  it('applies to every non-none mode, not just git', () => {
    const s = anchorStatementsFor('object-lock', { valid: false });
    expect(s.proves).not.toMatch(/carries a storage-side retention lock/);
    expect(s.proves).toMatch(/'object-lock'/);
  });

  it('leaves the valid case alone — an omitted valid is not read as a failure', () => {
    // The conditional remote/signing logic must not regress: a caller describing what a
    // passing anchor means still gets the assembled wording.
    expect(anchorStatementsFor('git', { remote: true, signedCommits: 5 }).proves).toMatch(
      /Each manifest was committed/,
    );
    expect(anchorStatementsFor('git', { valid: true, remote: false }).proves).toMatch(
      /NO remote configured/,
    );
  });
});

describe('anchorStatementsFor — object-lock', () => {
  it('passes the baseline through unchanged, since nothing here narrows it yet', () => {
    expect(anchorStatementsFor('object-lock')).toEqual(ANCHOR_STATEMENTS['object-lock']);
  });
});
