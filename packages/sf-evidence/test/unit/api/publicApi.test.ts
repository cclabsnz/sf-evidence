import * as api from '../../../src/index.js';

/**
 * The runtime export surface the licensed add-on consumes (SPEC.md §11.1). Pinned before the
 * engine split moved the code behind it, so a dropped name, or a value export that quietly
 * became type-only, fails here rather than in a consumer's build.
 */
describe('public API', () => {
  it('exports exactly the runtime names the add-on depends on', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ALGORITHM', 'ALGORITHM_EXPLANATION', 'ANCHOR_STATEMENTS', 'ArchiveReader', 'EXIT',
      'GENESIS_PREV', 'GitSink', 'LocalSink', 'UnsupportedValueError',
      'anchorStatementsFor', 'assessStatus', 'canonicalBytes', 'canonicalize', 'formatStatus',
      'formatVerifyReport', 'hasRecordedDegradation', 'manifestHash',
      'merkleRoot', 'resolveEvaluateAnchor', 'setExitCode', 'sha256Hex', 'verifyChain',
      'verifyExitCode',
    ]);
  });
});
