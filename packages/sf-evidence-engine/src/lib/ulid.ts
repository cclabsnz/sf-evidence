import { randomBytes } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so an id is unambiguous when read aloud or typed. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: bigint, length: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[Number(v % 32n)]! + out;
    v /= 32n;
  }
  return out;
}

/**
 * A ULID: 48-bit millisecond timestamp then 80 bits of randomness, Crockford base32.
 *
 * Run ids appear in archive filenames, so lexical order must equal chronological order —
 * which is why this is a ULID and not a UUIDv4.
 *
 * @param nowMs injectable for tests; defaults to the current time.
 */
export function newRunId(nowMs: number = Date.now()): string {
  const time = encode(BigInt(nowMs), 10);
  const rand = encode(BigInt('0x' + randomBytes(10).toString('hex')), 16);
  return time + rand;
}
