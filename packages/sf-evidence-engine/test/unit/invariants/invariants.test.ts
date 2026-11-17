import { join } from 'node:path';
import {
  ORG_WRITE_RULES,
  NETWORK_EGRESS_RULES,
  collectSourceFiles,
  filesUsingFetch,
  findInvariantViolations,
  formatViolations,
} from '@cclabsnz/sf-core/testing';

/**
 * The two promises this product is built on, as enforced CI gates rather than README claims:
 * it never writes to your org (C1), and nothing it produces phones home (C2).
 *
 * These scan this package's own `src/`, so a violation fails the build of the package that
 * introduced it.
 */
const SRC_DIR = join(process.cwd(), 'src');

describe('product invariants', () => {
  it('scans a non-trivial number of source files', () => {
    // Guards against the scan silently matching nothing and the suite passing vacuously.
    // 27 files at the engine split, so 20 is a meaningful floor with headroom for minor refactors.
    expect(collectSourceFiles(SRC_DIR).length).toBeGreaterThan(20);
  });

  it('C1: contains no org-mutating API calls anywhere in src/', () => {
    const violations = findInvariantViolations(SRC_DIR, ORG_WRITE_RULES);
    if (violations.length > 0) {
      throw new Error(
        'Read-only invariant violated — the following look like org writes:\n' +
          formatViolations(violations) +
          '\n\nThis plugin must never mutate a target org. If this is a false positive, ' +
          'add an `// invariant:allow` comment on the line after review.',
      );
    }
  });

  it('C2: contains no network-egress calls anywhere in src/', () => {
    const violations = findInvariantViolations(SRC_DIR, NETWORK_EGRESS_RULES);
    if (violations.length > 0) {
      throw new Error(
        'No-egress invariant violated — the following look like third-party network calls:\n' +
          formatViolations(violations) +
          '\n\nThe only permitted destinations are the customer org and the configured sink.',
      );
    }
  });

  it('C2: performs no direct fetch() — all org I/O funnels through the core clients', () => {
    expect(filesUsingFetch(SRC_DIR)).toEqual([]);
  });
});
