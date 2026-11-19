import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { GitSink } from '../../../src/sinks/git.js';
import { buildBatch } from '../../../src/chain/manifestBuilder.js';
import { GENESIS_PREV } from '../../../src/types/manifest.js';
import { RECORD_0, ORG_ID } from '../../../src/testing/specVectors.js';
import type { NormalisedRecord } from '../../../src/types/record.js';

const run = promisify(execFile);

function batch(seq: number, prev: string) {
  return buildBatch({
    orgId: ORG_ID,
    runId: '01K3QF8H2N0000000000000000',
    createdAt: '2026-08-15T09:00:12.482Z',
    collectedAt: `2026-08-15T09:0${seq}:12.482Z`,
    prevManifestHash: prev,
    seq,
    outcomes: [
      {
        source: 'audit-trail',
        status: 'complete',
        window: { from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }, achieved: [{ from: '2026-02-16T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' }],
        records: [RECORD_0] as unknown as NormalisedRecord[],
      },
    ],
    degradations: [],
  });
}

describe('GitSink', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-evidence-git-'));
    await run('git', ['init', '-b', 'main'], { cwd: root });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await run('git', ['config', 'user.name', 'Test'], { cwd: root });
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('advertises the git anchor', () => {
    expect(new GitSink(root).capabilities.anchors).toEqual(['git']);
  });

  it('init fails when the root is not a git repository, and does not create one', async () => {
    // C5: we never provision. `git init` is provisioning.
    const plain = await mkdtemp(join(tmpdir(), 'sf-evidence-plain-'));
    await expect(new GitSink(plain).init()).rejects.toThrow(/not a git repository.*git init/is);
    await rm(plain, { recursive: true, force: true });
  });

  it('checkReadable fails when the root is not a git repository, and does not create one', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'sf-evidence-plain-'));
    try {
      await expect(new GitSink(plain).checkReadable()).rejects.toThrow(/not a git repository.*git init/is);
      await expect(run('git', ['rev-parse', '--git-dir'], { cwd: plain })).rejects.toThrow();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  (process.getuid?.() === 0 ? it.skip : it)('checkReadable accepts a read-only repository that init refuses', async () => {
    await chmod(root, 0o555);
    try {
      await expect(new GitSink(root).checkReadable()).resolves.toBeUndefined();
      await expect(new GitSink(root).init()).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(root, 0o755);
    }
  });

  it('commits the batch and returns the commit sha', async () => {
    const sink = new GitSink(root);
    await sink.init();
    const out = await sink.putBatch(batch(1, GENESIS_PREV));

    expect(out.commit).toMatch(/^[0-9a-f]{7,40}$/);
    const { stdout } = await run('git', ['log', '--oneline'], { cwd: root });
    expect(stdout).toContain('evidence: seq 1');
  });

  it('writes the manifest hash into the commit message so the chain is greppable in git log', async () => {
    const sink = new GitSink(root);
    await sink.init();
    const out = await sink.putBatch(batch(1, GENESIS_PREV));
    const { stdout } = await run('git', ['log', '-1', '--format=%B'], { cwd: root });
    expect(stdout).toContain(out.manifestHash);
    expect(stdout).toContain(GENESIS_PREV);
  });

  it('leaves nothing uncommitted after a batch', async () => {
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root });
    expect(stdout.trim()).toBe('');
  });

  it('never pushes, even when a remote is configured', async () => {
    // An automatic push is egress the operator may not have authorised.
    await run('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: root });
    const sink = new GitSink(root);
    await sink.init();
    const out = await sink.putBatch(batch(1, GENESIS_PREV));
    expect(out.pushPending).toBe(true);
  });

  it('reports pushPending false when there is no remote', async () => {
    const sink = new GitSink(root);
    await sink.init();
    const out = await sink.putBatch(batch(1, GENESIS_PREV));
    expect(out.pushPending).toBe(false);
  });

  it('never invokes git with a push argument, across every command a full putBatch issues', async () => {
    // Structural, not inferential: `pushPending` alone only proves a flag came back a
    // certain value, which a future fire-and-forget `void this.git(['push', ...])` could
    // satisfy while a background push still ran. This spies on the sink's own single
    // subprocess chokepoint — the private `git()` helper every command in this class goes
    // through — forwards each call to the real implementation so the batch still actually
    // commits, and inspects every argv the sink issued.
    await run('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: root });
    const sink = new GitSink(root);
    await sink.init();

    type GitFn = (args: string[]) => Promise<string>;
    const original = ((sink as unknown as { git: GitFn }).git as GitFn).bind(sink);
    const calls: string[][] = [];
    jest
      .spyOn(sink as unknown as { git: GitFn }, 'git')
      .mockImplementation(async (args: string[]) => {
        calls.push(args);
        return original(args);
      });

    await sink.putBatch(batch(1, GENESIS_PREV));

    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv).not.toContain('push');
    }
    // Sanity: prove the spy actually observed the sink's real work, not an empty run.
    expect(calls.some((argv) => argv.includes('commit'))).toBe(true);
  });

  it('describes its location as a usable path, with the prose in a separate note', () => {
    const d = new GitSink(root).describe();
    expect(d.location).toBe(root);
    expect(d.location).not.toContain('(');
    expect(d.note).toMatch(/git repository/i);
    expect(d.credentialSource).toMatch(/^none/);
  });

  it('reports remote presence from the anchor evaluation, since the claim depends on it', async () => {
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    sink.anchorOrgId = ORG_ID;

    expect((await sink.evaluateAnchor([1])).remote).toBe(false);

    await run('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: root });
    expect((await sink.evaluateAnchor([1])).remote).toBe(true);
  });

  it('anchor evaluation reports every manifest as committed', async () => {
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    sink.anchorOrgId = ORG_ID; // required: the chain is per-org, so the caller names it
    const result = await sink.evaluateAnchor([1]);
    expect(result.valid).toBe(true);
    expect(result.unsignedCommits).toBe(1);
    expect(result.signedCommits).toBe(0);
    // A plain unsigned commit is a policy question, not a red flag — it must not read as bad.
    expect(result.badSignatures).toBe(0);
  });

  it('anchor evaluation fails when a manifest was never committed', async () => {
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    sink.anchorOrgId = ORG_ID;
    const result = await sink.evaluateAnchor([1, 2]);
    expect(result.valid).toBe(false);
    expect(result.detail).toMatch(/seq 2/);
  });

  it('anchor evaluation requires signatures when requireSigned is set', async () => {
    const sink = new GitSink(root, { requireSigned: true });
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    sink.anchorOrgId = ORG_ID;
    const result = await sink.evaluateAnchor([1]);
    expect(result.valid).toBe(false);
    expect(result.detail).toMatch(/unsigned/i);
  });

  it('a bad/forged signature (git status B) fails the anchor even when requireSigned is unset', async () => {
    // A bad signature is evidence of tampering, not a policy choice — it must never depend
    // on requireSigned to be reported. Producing a genuine GPG-rejected signature needs a
    // real (or deliberately broken) key in the test environment, which is impractical here,
    // so we stub the private `git` helper's output for the one call evaluateAnchor makes
    // (`git log --format=%G? ...`) after a real commit already exists on disk.
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    sink.anchorOrgId = ORG_ID;

    jest.spyOn(sink as unknown as { git: (args: string[]) => Promise<string> }, 'git')
      .mockResolvedValue('B\n');

    const result = await sink.evaluateAnchor([1]);
    expect(result.valid).toBe(false);
    expect(result.badSignatures).toBe(1);
    expect(result.detail).toMatch(/signature/i);
  });

  it('counts multiple bad signatures in badSignatures', async () => {
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    sink.anchorOrgId = ORG_ID;

    jest.spyOn(sink as unknown as { git: (args: string[]) => Promise<string> }, 'git')
      .mockResolvedValue('B\n');

    // Both seqs resolve via the stub to a 'B' status regardless of which manifest path was
    // requested, so two evaluated seqs means two bad signatures.
    const result = await sink.evaluateAnchor([1, 2]);
    expect(result.badSignatures).toBe(2);
    expect(result.valid).toBe(false);
  });

  it('reports a bad signature in preference to a missing-commit message when both apply', async () => {
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    sink.anchorOrgId = ORG_ID;

    // seq 1 has a real commit; the stub reports it as a bad signature. seq 2 was never
    // committed, so without the stub it would report as missing. Bad-signature must win.
    jest.spyOn(sink as unknown as { git: (args: string[]) => Promise<string> }, 'git')
      .mockImplementation(async (args: string[]) =>
        args[0] === 'log' && args.at(-1)?.includes('00000001') ? 'B\n' : '',
      );

    const result = await sink.evaluateAnchor([1, 2]);
    expect(result.valid).toBe(false);
    expect(result.badSignatures).toBe(1);
    expect(result.detail).toMatch(/signature/i);
    expect(result.detail).not.toMatch(/seq 2/);
  });

  it('refuses to evaluate the anchor when anchorOrgId was never set', async () => {
    // Guessing the org would silently verify the wrong chain, which is worse than failing.
    const sink = new GitSink(root);
    await sink.init();
    await sink.putBatch(batch(1, GENESIS_PREV));
    await expect(sink.evaluateAnchor([1])).rejects.toThrow(/anchorOrgId/);
  });

  it('never commits _state', async () => {
    // _state is derived and disposable (SPEC.md §5.4). Committing it would put a cache into
    // the anchor chain, where it would look like evidence.
    const sink = new GitSink(root);
    await sink.init();
    await sink.writeState(ORG_ID, 'coverage.json', '{"version":1,"seq":0,"summaries":[]}');
    await sink.putBatch(batch(1, GENESIS_PREV));
    await sink.writeState(ORG_ID, 'coverage.json', '{"version":1,"seq":1,"summaries":[]}');

    const { stdout: tracked } = await run('git', ['ls-files'], { cwd: root });
    expect(tracked).toContain('_chain/');
    expect(tracked).not.toContain('_state');
    const { stdout: history } = await run('git', ['log', '--all', '--name-only', '--format='], { cwd: root });
    expect(history).not.toContain('_state');
  });
});
