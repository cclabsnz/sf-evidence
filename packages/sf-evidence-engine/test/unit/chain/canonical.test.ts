import { canonicalize, canonicalBytes } from '../../../src/chain/canonical.js';
import { RECORD_0, SPEC_VECTORS } from '../../../src/testing/specVectors.js';

describe('canonicalize', () => {
  it('sorts object keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });

  it('preserves null rather than omitting the key', () => {
    // A field the org returned as null must stay distinguishable from a field we never asked for.
    expect(canonicalize({ DelegateUser: null })).toBe('{"DelegateUser":null}');
  });

  it('omits keys whose value is undefined', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('sorts keys by UTF-16 code unit, so uppercase precedes lowercase', () => {
    expect(canonicalize({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it('escapes strings the way JSON does', () => {
    expect(canonicalize({ s: 'a"b\\c\nd' })).toBe('{"s":"a\\"b\\\\c\\nd"}');
  });

  it('rejects a non-integer number rather than guessing a representation', () => {
    // RFC 8785 float formatting is the hard part of JCS. The archive never stores floats,
    // so refusing is safer and more auditable than implementing it.
    expect(() => canonicalize({ x: 1.5 })).toThrow(/non-integer/i);
  });

  it('rejects a number beyond safe integer range', () => {
    expect(() => canonicalize({ x: 1e21 })).toThrow(/unsafe/i);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalize({ x: NaN })).toThrow(/non-integer|unsafe/i);
    expect(() => canonicalize({ x: Infinity })).toThrow(/non-integer|unsafe/i);
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalize({ x: () => 1 })).toThrow(/unsupported/i);
    expect(() => canonicalize({ x: 1n })).toThrow(/unsupported/i);
  });

  it('rejects Date objects rather than silently serializing as {}', () => {
    expect(() => canonicalize({ occurred_at: new Date() })).toThrow(/non-plain object/i);
  });

  it('rejects Map objects', () => {
    expect(() => canonicalize({ x: new Map() })).toThrow(/non-plain object/i);
  });

  it('rejects RegExp objects', () => {
    expect(() => canonicalize({ x: /abc/ })).toThrow(/non-plain object/i);
  });

  it('reproduces the SPEC.md §6.4 record byte-for-byte', () => {
    const bytes = canonicalBytes(RECORD_0);
    expect(bytes.length).toBeGreaterThan(0);
    expect(canonicalize(RECORD_0).startsWith('{"api_version":"64.0","collected_at":')).toBe(true);
    // Full agreement is asserted via the hash in hash.test.ts.
    expect(SPEC_VECTORS.recordHash0).toHaveLength(64);
  });
});
