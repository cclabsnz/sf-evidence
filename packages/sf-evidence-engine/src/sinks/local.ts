import {
  access,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { manifestPath, headPath, orgPrefix, stateFilePath, CHAIN_DIR } from './layout.js';
import { manifestHash } from '../chain/manifestBuilder.js';
import { toIsoMs } from '../lib/time.js';
import type { ChainHead, Manifest } from '../types/manifest.js';
import type {
  OrphanFile,
  PreparedBatch,
  PutOutcome,
  Sink,
  SinkCapabilities,
  SinkDescription,
  SinkId,
} from '../types/sink.js';

/**
 * Plain-filesystem sink. The Tier 0 default: `./sf-evidence-archive/`.
 *
 * Write ordering is the invariant that matters here (SPEC.md §7.3): record files, then the
 * manifest, then head. An interruption can therefore leave orphan record files — detectable
 * and harmless — but never a manifest pointing at a file that does not exist, which would be
 * indistinguishable from deletion-tampering and would poison verification forever.
 */
export class LocalSink implements Sink {
  public readonly id: SinkId = 'local';

  public readonly capabilities: SinkCapabilities = {
    canonical: true,
    readable: true,
    queryable: true,
    supportsObjectLock: false,
    anchors: [],
  };

  public constructor(protected readonly root: string) {}

  public describe(): SinkDescription {
    return {
      id: this.id,
      location: this.root,
      note: 'plain filesystem directory',
      credentialSource: 'none (local filesystem)',
      anchors: this.capabilities.anchors,
    };
  }

  public async init(): Promise<void> {
    try {
      const s = await stat(this.root);
      if (!s.isDirectory()) {
        throw new Error(`Archive root is not a directory: ${this.root}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // C5: we verify and instruct; we never provision.
        throw new Error(
          `Archive root does not exist: ${this.root}\n` +
            `Create it yourself and re-run:  mkdir -p ${this.root}`,
        );
      }
      throw err;
    }
    await access(this.root, constants.W_OK);
  }

  public async head(orgId: string): Promise<ChainHead | null> {
    return this.readJson<ChainHead>(headPath(orgId));
  }

  public async readManifest(orgId: string, seq: number): Promise<Manifest | null> {
    return this.readJson<Manifest>(manifestPath(orgId, seq));
  }

  public async listManifests(orgId: string): Promise<number[]> {
    const dir = join(this.root, orgPrefix(orgId), CHAIN_DIR);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((n) => /^\d{8}\.manifest\.json$/.test(n))
      .map((n) => Number.parseInt(n.slice(0, 8), 10))
      .sort((a, b) => a - b);
  }

  public async readFile(relPath: string): Promise<Buffer> {
    return readFile(join(this.root, ...relPath.split('/')));
  }

  public async listOrphans(orgId: string): Promise<OrphanFile[]> {
    const referenced = new Set<string>();
    for (const seq of await this.listManifests(orgId)) {
      const m = await this.readManifest(orgId, seq);
      for (const source of m?.sources ?? []) {
        for (const f of source.files) referenced.add(f.path);
      }
    }

    const present = await this.walkNdjson(orgPrefix(orgId));
    const orphans: OrphanFile[] = [];
    for (const relPath of present) {
      if (referenced.has(relPath)) continue;
      const s = await stat(join(this.root, ...relPath.split('/')));
      orphans.push({ relPath, bytes: s.size });
    }
    return orphans.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  }

  public async putBatch(batch: PreparedBatch): Promise<PutOutcome> {
    const mPath = manifestPath(batch.orgId, batch.manifest.seq);
    if (await this.exists(mPath)) {
      throw this.seqClaimedError(batch.manifest.seq, batch.orgId);
    }

    // Invariant S1 — record files first.
    for (const file of batch.files) {
      await this.writeArtifact(file.relPath, file.bytes);
    }

    // Then the manifest, published atomically-exclusive. The exists() check above is only a
    // cheap fast path — two concurrent runs can both pass it before either has written, so
    // the real guard against both claiming this seq is writeArtifactExclusive's link() below,
    // which fails with EEXIST for whichever writer loses the race instead of silently
    // overwriting (SPEC.md's conditional-write requirement for sinks that lack one natively).
    const hash = manifestHash(batch.manifest);
    try {
      await this.writeArtifactExclusive(
        mPath,
        Buffer.from(JSON.stringify(batch.manifest, null, 2) + '\n', 'utf8'),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw this.seqClaimedError(batch.manifest.seq, batch.orgId);
      }
      throw err;
    }

    // Then, last of all, the head pointer.
    const head: ChainHead = {
      seq: batch.manifest.seq,
      manifest_hash: hash,
      updated_at: toIsoMs(new Date()),
    };
    await this.writeArtifact(
      headPath(batch.orgId),
      Buffer.from(JSON.stringify(head, null, 2) + '\n', 'utf8'),
    );

    return { written: true, manifestSeq: batch.manifest.seq, manifestHash: hash };
  }

  public async readState(orgId: string, name: string): Promise<string | null> {
    const relPath = stateFilePath(orgId, name);
    try {
      return await readFile(join(this.root, ...relPath.split('/')), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Temp file plus rename, so a reader never sees a half-written cache. */
  public async writeState(orgId: string, name: string, json: string): Promise<void> {
    await this.writeArtifact(stateFilePath(orgId, name), Buffer.from(json, 'utf8'));
  }

  /**
   * Write via unique temp file + rename, so a reader never observes a half-written artifact.
   *
   * `rename` replaces an existing destination silently — fine here, since every caller of
   * this primitive either targets a path that cannot collide (record files are named by run
   * id) or is a pointer that is meant to be replaced (head.json). The manifest, which must
   * not be silently overwritten, uses `writeArtifactExclusive` instead.
   */
  protected async writeArtifact(relPath: string, bytes: Buffer): Promise<void> {
    const abs = join(this.root, ...relPath.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    const tmp = this.tempPath(abs);
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, abs);
    } catch (err) {
      await this.cleanupTemp(tmp);
      throw err;
    }
  }

  /**
   * Write via unique temp file + `link`, so the publish is atomically exclusive: `link` fails
   * with `EEXIST` if the destination already exists, instead of `rename`'s silent replace.
   * This is what actually prevents two concurrent writers from both claiming the same
   * manifest sequence — the up-front `exists()` check in `putBatch` is only a fast path and
   * cannot close the gap between check and write on its own (TOCTOU).
   */
  protected async writeArtifactExclusive(relPath: string, bytes: Buffer): Promise<void> {
    const abs = join(this.root, ...relPath.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    const tmp = this.tempPath(abs);
    try {
      await writeFile(tmp, bytes);
      await link(tmp, abs);
    } catch (err) {
      // Nothing was published — safe to clean up and let the caller see the failure.
      await this.cleanupTemp(tmp);
      throw err;
    }
    // link() succeeding IS the publish: sequence N is claimed the moment it returns. The
    // remaining unlink is housekeeping for the now-redundant temp copy, not part of the
    // commit — if it fails, swallow it rather than propagate, or putBatch would report
    // failure for a manifest that is already correctly on disk, and a retry would then
    // collide with the very sequence it thinks it never claimed.
    await this.cleanupTemp(tmp);
  }

  /** Unique per invocation — two concurrent writers must never share a temp path. */
  private tempPath(abs: string): string {
    return `${abs}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  }

  /**
   * Best-effort: the temp file may already be gone (ENOENT, the expected case) or something
   * else may fail. Either way, swallow it. Two call sites rely on that: after a failed write
   * or publish, the caller is already about to rethrow the real error, and a cleanup failure
   * must never mask it; after a successful `link()` publish, there is no error to mask — the
   * temp file is redundant housekeeping, and failing to remove it must not be reported as a
   * failure of the (already-succeeded) write.
   */
  private async cleanupTemp(tmp: string): Promise<void> {
    try {
      await unlink(tmp);
    } catch {
      // Deliberately ignored — see doc comment above.
    }
  }

  private seqClaimedError(seq: number, orgId: string): Error {
    return new Error(
      `Manifest sequence ${seq} already exists for org ${orgId}. ` +
        'Another run may have claimed it; re-read head and retry.',
    );
  }

  private async exists(relPath: string): Promise<boolean> {
    try {
      await access(join(this.root, ...relPath.split('/')));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  private async readJson<T>(relPath: string): Promise<T | null> {
    try {
      const raw = await readFile(join(this.root, ...relPath.split('/')), 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async walkNdjson(relDir: string): Promise<string[]> {
    const abs = join(this.root, ...relDir.split('/'));
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const out: string[] = [];
    for (const e of entries) {
      // `_chain` and `_state` are underscore-prefixed precisely so this skip is trivial.
      if (e.isDirectory()) {
        if (e.name.startsWith('_')) continue;
        out.push(...(await this.walkNdjson(`${relDir}/${e.name}`)));
      } else if (e.name.endsWith('.ndjson')) {
        out.push(`${relDir}/${e.name}`.split(sep).join('/'));
      }
    }
    return out;
  }
}
