import { createHash } from 'node:crypto';

/** SHA-256 as lowercase hex (SPEC.md §6.1). */
export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Merkle root over record hashes, in file order (SPEC.md §6.2).
 *
 * Binary tree; when a level has odd length the last node is duplicated. Order-sensitive by
 * construction, so reordering records in a file breaks the root — which is the point:
 * `file_sha256` catches byte changes, `records_root` additionally supports proving one
 * specific record is in the archive without disclosing the rest of the file.
 *
 * @param leafHashesHex record hashes as lowercase hex, in the order they appear in the file.
 */
export function merkleRoot(leafHashesHex: readonly string[]): string {
  if (leafHashesHex.length === 0) {
    return sha256Hex(Buffer.alloc(0));
  }

  let level: Buffer[] = leafHashesHex.map((h) => Buffer.from(h, 'hex'));

  while (level.length > 1) {
    if (level.length % 2 === 1) {
      level.push(level[level.length - 1]!);
    }
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(createHash('sha256').update(Buffer.concat([level[i]!, level[i + 1]!])).digest());
    }
    level = next;
  }

  return level[0]!.toString('hex');
}
