/**
 * RFC 8785 JSON Canonicalization Scheme, restricted to the JSON subset this archive
 * stores: string, boolean, null, safe integer, array, plain object.
 *
 * The restriction is deliberate. RFC 8785's difficulty is concentrated in ECMAScript
 * number formatting for non-integers, and the archive never stores one. A strict
 * implementation that *refuses* the cases it does not handle is more auditable than a
 * general one that might handle them subtly wrong — and refusing is always safe, because
 * a refusal fails a collection loudly rather than writing a record no verifier can
 * reproduce.
 *
 * Key ordering: RFC 8785 sorts by UTF-16 code unit, which is exactly what
 * `Array.prototype.sort()` does for strings by default.
 *
 * String escaping: RFC 8785 mandates the shortest escape form, which is what
 * `JSON.stringify` produces for a string.
 */

export class UnsupportedValueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedValueError';
  }
}

function canon(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'string':
      return JSON.stringify(value);

    case 'number': {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new UnsupportedValueError(
          `Non-integer number at ${path}: the archive stores only safe integers.`,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new UnsupportedValueError(
          `Unsafe integer at ${path}: exceeds Number.MAX_SAFE_INTEGER.`,
        );
      }
      return String(value);
    }

    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v, i) => canon(v, `${path}[${i}]`)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new UnsupportedValueError(
          `Non-plain object at ${path}: the archive stores only plain objects and arrays.`,
        );
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return (
        '{' +
        keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k], `${path}.${k}`)}`).join(',') +
        '}'
      );
    }

    default:
      throw new UnsupportedValueError(
        `Unsupported value of type ${typeof value} at ${path}.`,
      );
  }
}

/** Canonical JSON text for a value. */
export function canonicalize(value: unknown): string {
  return canon(value, '$');
}

/** Canonical JSON bytes (UTF-8) for a value — the exact bytes that get hashed. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}
