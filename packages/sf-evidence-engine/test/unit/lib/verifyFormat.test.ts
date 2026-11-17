// The pure decisions and formatting `verify` makes. The command wrapper that calls them is
// exercised separately in test/unit/commands/commands.test.ts.
import { jest } from '@jest/globals';
import {
  formatVerifyReport,
  verifyExitCode,
  resolveEvaluateAnchor,
  ALGORITHM,
  ALGORITHM_EXPLANATION,
} from '../../../src/lib/verifyFormat.js';
import { ANCHOR_STATEMENTS } from '../../../src/chain/anchorStatements.js';
import { EXIT } from '../../../src/lib/exit.js';
import { GitSink } from '../../../src/sinks/git.js';
import { LocalSink } from '../../../src/sinks/local.js';
import type { VerifyReport } from '../../../src/chain/verifier.js';
import { foreignGitSink } from '../../fixtures/foreignGitSink.js';

const OK: VerifyReport = {
  orgId: '00D5j000000AbCdEAK',
  manifestsChecked: 42,
  recordsChecked: 0,
  chain: {
    valid: true,
    state: 'verified',
    head: { seq: 42, manifest_hash: 'sha256:abc', updated_at: 'x' },
    headCheck: 'matched',
  },
  range: { from: 1, to: 42 },
  fullChain: true,
  coverage: { degradedSources: [], degradations: [] },
  anchor: { mode: 'none', valid: true, ...ANCHOR_STATEMENTS.none },
  breaks: [],
  notes: [],
  orphans: [],
};

const DEGRADATION = {
  seq: 7,
  source: 'audit-trail' as const,
  code: 'INSUFFICIENT_ACCESS',
  detail: 'SetupAuditTrail requires View Setup and Configuration',
  remediation: 'sf evidence init --emit-permset',
};

describe('formatVerifyReport', () => {
  it('states the anchor mode', () => {
    expect(formatVerifyReport(OK).join('\n')).toContain('anchor: none');
  });

  it('always prints what the run does NOT prove', () => {
    // SPEC.md §6.5: the caveat is the honesty requirement, not optional formatting.
    const text = formatVerifyReport(OK).join('\n');
    expect(text).toContain('Does not prove');
    expect(text).toContain(ANCHOR_STATEMENTS.none.doesNotProve);
  });

  it('prints the does-not-prove caveat even for the git anchor', () => {
    const text = formatVerifyReport({
      ...OK,
      anchor: {
        mode: 'git',
        valid: true,
        signedCommits: 42,
        unsignedCommits: 0,
        badSignatures: 0,
        remote: true,
        ...ANCHOR_STATEMENTS.git,
      },
    }).join('\n');
    expect(text).toContain(ANCHOR_STATEMENTS.git.doesNotProve);
  });

  it('prints the does-not-prove caveat even when everything checked out perfectly', () => {
    // The caveat must not be conditioned on success — a clean run is exactly the case an
    // overclaiming tool would be tempted to stay silent on.
    const text = formatVerifyReport(OK).join('\n');
    expect(text).toContain('chain: VALID');
    expect(text).toContain('Does not prove');
  });

  it('lists each break with its sequence, kind and file', () => {
    const text = formatVerifyReport({
      ...OK,
      chain: { ...OK.chain, valid: false, state: 'broken' },
      breaks: [{ seq: 7, kind: 'file-hash-mismatch', file: 'a/b.ndjson', expected: 'x', actual: 'y' }],
    }).join('\n');
    expect(text).toContain('seq 7');
    expect(text).toContain('file-hash-mismatch');
    expect(text).toContain('a/b.ndjson');
  });

  it('renders a break kind generically, even one outside the currently known set', () => {
    // VerifyBreak['kind'] is not assumed to be a closed set here.
    const text = formatVerifyReport({
      ...OK,
      chain: { ...OK.chain, valid: false, state: 'broken' },
      breaks: [{ seq: 3, kind: 'some-future-break-kind' as never }],
    }).join('\n');
    expect(text).toContain('seq 3');
    expect(text).toContain('some-future-break-kind');
  });

  it('reports a metadata change as a note, not a failure', () => {
    const report = {
      ...OK,
      notes: [
        { seq: 3, kind: 'metadata-changed' as const, file: 'org_id=X/org.json', expected: 'sha256:a', actual: 'sha256:b' },
      ],
    };
    expect(formatVerifyReport(report).join('\n')).toMatch(/metadata changed/);
    expect(verifyExitCode(report)).toBe(0);
  });

  it('reports orphans as informational, not as a failure', () => {
    const text = formatVerifyReport({
      ...OK,
      orphans: [{ relPath: 'a/b.ndjson', bytes: 10 }],
    }).join('\n');
    expect(text).toMatch(/orphan/i);
    expect(text).toContain('not referenced by any manifest');
  });

  it('reports records checked only when a deep verify actually counted records', () => {
    expect(formatVerifyReport(OK).join('\n')).not.toContain('records checked');
    expect(formatVerifyReport({ ...OK, recordsChecked: 5 }).join('\n')).toContain(
      'records checked:   5',
    );
  });
});

describe('verifyExitCode', () => {
  it('is OK for a clean verify', () => {
    expect(verifyExitCode(OK)).toBe(EXIT.OK);
  });

  it('is INTEGRITY when the chain is broken', () => {
    expect(
      verifyExitCode({
        ...OK,
        chain: { ...OK.chain, valid: false, state: 'broken' },
        breaks: [{ seq: 1, kind: 'seq-gap' }],
      }),
    ).toBe(EXIT.INTEGRITY);
  });

  it('is INTEGRITY when the anchor fails even though the chain is intact', () => {
    // `chain.valid: true` alongside an anchor break is now a state verifyChain can actually
    // produce: an anchor failure is no longer counted against the chain (a LocalSink asked
    // for --anchor git has nothing wrong with its chain). The exit code must still be 3.
    expect(
      verifyExitCode({
        ...OK,
        chain: { ...OK.chain, valid: true, state: 'verified' },
        anchor: { mode: 'git', valid: false, ...ANCHOR_STATEMENTS.git },
        breaks: [{ seq: 0, kind: 'anchor' }],
      }),
    ).toBe(EXIT.INTEGRITY);
  });

  it('is ERROR when nothing was verified, never OK', () => {
    // SPEC.md §8.0: exit 0 means "success, full coverage". A run that walked zero manifests
    // — mistyped --org-id, wrong --archive, empty partition — has neither.
    expect(
      verifyExitCode({
        ...OK,
        manifestsChecked: 0,
        chain: { valid: false, state: 'empty', head: null, headCheck: 'no-manifests' },
        range: null,
        fullChain: false,
      }),
    ).toBe(EXIT.ERROR);
  });

  it('is DEGRADED when head.json is absent over a non-empty chain', () => {
    // Not a break — head.json is a pointer, not evidence (SPEC.md §6.3) — but not a pass
    // either. LocalSink writes head.json last on every batch, so its absence over a
    // non-empty chain is anomalous by construction, and "delete the tail manifests *and*
    // head.json" is the cheapest competent truncation: every surviving link verifies and
    // the only artifact naming the newest sequence is gone.
    expect(
      verifyExitCode({
        ...OK,
        chain: { ...OK.chain, head: null, headCheck: 'absent' },
      }),
    ).toBe(EXIT.DEGRADED);
  });

  it('is OK for a --to subrange, which is not expected to match head.json', () => {
    // headCheck 'not-checked' is a deliberate user request, not an anomaly.
    expect(
      verifyExitCode({
        ...OK,
        range: { from: 1, to: 20 },
        fullChain: false,
        chain: { ...OK.chain, headCheck: 'not-checked' },
      }),
    ).toBe(EXIT.OK);
  });

  it('lets an integrity break outrank a missing head.json', () => {
    expect(
      verifyExitCode({
        ...OK,
        chain: { ...OK.chain, valid: false, state: 'broken', head: null, headCheck: 'absent' },
        breaks: [{ seq: 1, kind: 'seq-gap' }],
      }),
    ).toBe(EXIT.INTEGRITY);
  });

  it('still returns ERROR, not DEGRADED, for an empty chain with no head.json', () => {
    expect(
      verifyExitCode({
        ...OK,
        manifestsChecked: 0,
        chain: { valid: false, state: 'empty', head: null, headCheck: 'no-manifests' },
        range: null,
        fullChain: false,
      }),
    ).toBe(EXIT.ERROR);
  });

  it('is DEGRADED when the chain is clean but the manifests record degradations', () => {
    // SPEC.md §8.3: "4 chain valid but manifests record degradations".
    expect(
      verifyExitCode({
        ...OK,
        coverage: { degradedSources: [], degradations: [DEGRADATION] },
      }),
    ).toBe(EXIT.DEGRADED);
  });

  it('is DEGRADED when a source entry is not complete, even with no degradation record', () => {
    expect(
      verifyExitCode({
        ...OK,
        coverage: {
          degradedSources: [{ seq: 4, source: 'audit-trail', status: 'partial' }],
          degradations: [],
        },
      }),
    ).toBe(EXIT.DEGRADED);
  });

  it('lets an integrity break outrank a degradation', () => {
    expect(
      verifyExitCode({
        ...OK,
        chain: { ...OK.chain, valid: false, state: 'broken' },
        breaks: [{ seq: 1, kind: 'seq-gap' }],
        coverage: { degradedSources: [], degradations: [DEGRADATION] },
      }),
    ).toBe(EXIT.INTEGRITY);
  });
});

describe('formatVerifyReport — states the tool used to print over', () => {
  it('renders a zero-manifest run as NOTHING VERIFIED with what to check', () => {
    const text = formatVerifyReport({
      ...OK,
      manifestsChecked: 0,
      chain: { valid: false, state: 'empty', head: null, headCheck: 'no-manifests' },
      range: null,
      fullChain: false,
    }).join('\n');
    expect(text).toContain('NOTHING VERIFIED');
    expect(text).not.toContain('chain: VALID');
    expect(text).toMatch(/--org-id and --archive/);
  });

  it('echoes the checked range whenever it is not the whole chain', () => {
    const text = formatVerifyReport({
      ...OK,
      manifestsChecked: 3,
      range: { from: 40, to: 42 },
      fullChain: false,
    }).join('\n');
    expect(text).toContain('range checked:     seq 40–42');
    expect(text).toMatch(/subrange, not the whole chain/);
  });

  it('says nothing about a range when the whole chain was walked', () => {
    expect(formatVerifyReport(OK).join('\n')).not.toContain('range checked');
  });

  it('prints a coverage block when the manifests record reduced coverage', () => {
    const text = formatVerifyReport({
      ...OK,
      coverage: {
        degradedSources: [{ seq: 7, source: 'audit-trail', status: 'degraded' }],
        degradations: [DEGRADATION],
      },
    }).join('\n');
    expect(text).toContain('COVERAGE');
    expect(text).toContain('INSUFFICIENT_ACCESS');
    expect(text).toContain('sf evidence init --emit-permset');
    expect(text).toMatch(/proves nothing about what was never collected/);
  });

  it('says nothing about coverage when every source completed', () => {
    expect(formatVerifyReport(OK).join('\n')).not.toContain('COVERAGE');
  });

  it('renders git signature counts and remote presence, rather than discarding them', () => {
    const text = formatVerifyReport({
      ...OK,
      anchor: {
        mode: 'git',
        valid: true,
        signedCommits: 0,
        unsignedCommits: 42,
        badSignatures: 0,
        remote: false,
        ...ANCHOR_STATEMENTS.git,
      },
    }).join('\n');
    expect(text).toContain('0 signed, 42 unsigned, 0 with a signature git rejected');
    expect(text).toMatch(/remote:\s+NONE/);
  });

  it('states when head.json was absent, so truncation was not ruled out', () => {
    const text = formatVerifyReport({
      ...OK,
      chain: { ...OK.chain, headCheck: 'absent', head: null },
    }).join('\n');
    expect(text).toMatch(/head\.json is absent/);
    expect(text).toMatch(/truncation of the\s+newest manifests cannot be ruled out/);
  });

  it('states when head.json matched', () => {
    expect(formatVerifyReport(OK).join('\n')).toMatch(/head\.json matches the newest manifest/);
  });
});

describe('resolveEvaluateAnchor', () => {
  it('returns undefined when the anchor mode is none, regardless of sink', () => {
    expect(resolveEvaluateAnchor('none', new GitSink('/tmp/does-not-matter'), 'org1')).toBeUndefined();
  });

  it('evaluates the git anchor for a GitSink from another installed copy of the engine', () => {
    const sink = foreignGitSink('/tmp/does-not-matter');
    expect(sink instanceof GitSink).toBe(false);
    expect(resolveEvaluateAnchor('git', sink, 'org1')).toBeDefined();
    expect(sink.anchorOrgId).toBe('org1');
  });

  it('returns undefined when git anchoring is requested against a non-GitSink', () => {
    expect(resolveEvaluateAnchor('git', new LocalSink('/tmp/does-not-matter'), 'org1')).toBeUndefined();
  });

  it('sets anchorOrgId and wires the GitSink evaluator when anchor is git and the sink is a GitSink', async () => {
    const sink = new GitSink('/tmp/does-not-matter');
    const spy = jest
      .spyOn(sink, 'evaluateAnchor')
      .mockResolvedValue({
        mode: 'git',
        valid: true,
        signedCommits: 1,
        unsignedCommits: 0,
        badSignatures: 0,
        remote: false,
      });

    const evaluateAnchor = resolveEvaluateAnchor('git', sink, 'org1');

    expect(sink.anchorOrgId).toBe('org1');
    expect(evaluateAnchor).toBeDefined();
    await evaluateAnchor!([1, 2]);
    expect(spy).toHaveBeenCalledWith([1, 2]);
  });
});

describe('ALGORITHM', () => {
  it('documents the hash formulas so the archive is verifiable without this software', () => {
    expect(ALGORITHM).toContain('SHA-256');
    expect(ALGORITHM).toMatch(/JCS/);
    expect(ALGORITHM).toMatch(/No CloudCounsel\s+software, and no network/);
  });
});

describe('ALGORITHM_EXPLANATION', () => {
  it('carries mode "explain-algorithm" and the algorithm text', () => {
    expect(ALGORITHM_EXPLANATION.mode).toBe('explain-algorithm');
    expect(ALGORITHM_EXPLANATION.algorithm).toBe(ALGORITHM);
  });

  it('has no breaks, chain, anchor or orphans fields, so a --json consumer cannot read it as a clean verification', () => {
    // This is the whole point of the discriminated variant: a consumer's natural check is
    // `breaks.length === 0`, and a run that verified nothing must not satisfy it.
    expect(ALGORITHM_EXPLANATION).not.toHaveProperty('breaks');
    expect(ALGORITHM_EXPLANATION).not.toHaveProperty('chain');
    expect(ALGORITHM_EXPLANATION).not.toHaveProperty('anchor');
    expect(ALGORITHM_EXPLANATION).not.toHaveProperty('orphans');
    expect(Object.keys(ALGORITHM_EXPLANATION).sort()).toEqual(['algorithm', 'mode']);
  });
});
