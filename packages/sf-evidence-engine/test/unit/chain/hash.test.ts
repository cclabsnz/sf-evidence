import { sha256Hex, merkleRoot } from '../../../src/chain/hash.js';
import { canonicalBytes } from '../../../src/chain/canonical.js';
import { RECORD_0, RECORD_1, SPEC_VECTORS } from '../../../src/testing/specVectors.js';

describe('sha256Hex', () => {
  it('produces lowercase hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('reproduces record_hash[0] from SPEC.md §6.4', () => {
    expect(sha256Hex(canonicalBytes(RECORD_0))).toBe(SPEC_VECTORS.recordHash0);
  });

  it('reproduces record_hash[1] from SPEC.md §6.4', () => {
    expect(sha256Hex(canonicalBytes(RECORD_1))).toBe(SPEC_VECTORS.recordHash1);
  });

  it('detects the attribution-erasing edit: nulling DelegateUser changes the hash', () => {
    const tampered = {
      ...RECORD_0,
      payload: { ...RECORD_0.payload, DelegateUser: null },
    };
    expect(sha256Hex(canonicalBytes(tampered))).toBe(SPEC_VECTORS.tamperedRecordHash0);
    expect(sha256Hex(canonicalBytes(tampered))).not.toBe(SPEC_VECTORS.recordHash0);
  });
});

describe('merkleRoot', () => {
  it('reproduces records_root from SPEC.md §6.4', () => {
    expect(merkleRoot([SPEC_VECTORS.recordHash0, SPEC_VECTORS.recordHash1])).toBe(
      SPEC_VECTORS.recordsRoot,
    );
  });

  it('returns the single leaf unchanged for a one-record batch', () => {
    expect(merkleRoot([SPEC_VECTORS.recordHash0])).toBe(SPEC_VECTORS.recordHash0);
  });

  it('duplicates the last node on an odd level', () => {
    const [a, b] = [SPEC_VECTORS.recordHash0, SPEC_VECTORS.recordHash1];
    // Three leaves: level 1 is [H(a|b), H(c|c)] where c is the duplicated third leaf.
    const three = merkleRoot([a, b, a]);
    const explicit = merkleRoot([a, b, a, a]);
    expect(three).toBe(explicit);
  });

  it('is order-sensitive, so reordering records is detected', () => {
    expect(merkleRoot([SPEC_VECTORS.recordHash1, SPEC_VECTORS.recordHash0])).not.toBe(
      SPEC_VECTORS.recordsRoot,
    );
  });

  it('hashes the empty batch to the SHA-256 of no bytes', () => {
    expect(merkleRoot([])).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('reproduces the tampered root from SPEC.md §6.4', () => {
    expect(merkleRoot([SPEC_VECTORS.tamperedRecordHash0, SPEC_VECTORS.recordHash1])).toBe(
      SPEC_VECTORS.tamperedRecordsRoot,
    );
  });
});
