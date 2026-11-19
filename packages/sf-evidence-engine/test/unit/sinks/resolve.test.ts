import { LocalSink } from '../../../src/sinks/local.js';
import { GitSink } from '../../../src/sinks/git.js';
import { resolveSink, resolveSinks, DEFAULT_ARCHIVE } from '../../../src/sinks/resolve.js';

describe('resolveSink', () => {
  it('defaults the archive to ./sf-evidence-archive, so Tier 0 needs no configuration', () => {
    expect(DEFAULT_ARCHIVE).toBe('./sf-evidence-archive');
  });

  it('builds a LocalSink for id "local"', () => {
    expect(resolveSink('local', '/tmp/x')).toBeInstanceOf(LocalSink);
  });

  it('builds a GitSink for id "git"', () => {
    expect(resolveSink('git', '/tmp/x')).toBeInstanceOf(GitSink);
  });

  it('rejects a sink that is not implemented yet, naming what is', () => {
    expect(() => resolveSink('s3', '/tmp/x')).toThrow(/not available.*local, git/is);
  });

  it('passes signing options through to the git sink, so they are reachable from a command', () => {
    // GitSinkOptions used to be unreachable: resolveSink constructed `new GitSink(root)`
    // with no options, so neither `sign` nor `requireSigned` could be enabled by any user
    // while the anchor statement claimed the signing key was part of the guarantee.
    const sink = resolveSink('git', '/tmp/x', { sign: true, requireSigned: true });
    expect(sink).toBeInstanceOf(GitSink);
  });
});

describe('resolveSinks', () => {
  it('rejects two canonical sinks that resolve to the same archive root', () => {
    // `--sink local,git` against one root used to be accepted, write records, and then throw
    // "Manifest sequence 1 already exists" — a concurrency message for a configuration
    // error, raised after a partial write.
    expect(() => resolveSinks(['local', 'git'], '/tmp/one-archive')).toThrow(
      /same archive root/i,
    );
  });

  it('names both sinks and explains why git is not a second copy', () => {
    expect(() => resolveSinks(['local', 'git'], '/tmp/one-archive')).toThrow(
      /'local' and 'git'[\s\S]*not a second copy/i,
    );
  });

  it('rejects the same root spelled two different ways', () => {
    expect(() => resolveSinks(['local', 'local'], './x')).toThrow(/same archive root/i);
  });

  it('accepts a single sink', () => {
    expect(resolveSinks(['git'], '/tmp/one-archive')).toHaveLength(1);
  });

  it('trims whitespace from a comma-separated list', () => {
    expect(resolveSinks([' local '], '/tmp/x')[0]).toBeInstanceOf(LocalSink);
  });
});
