import { ArchiveReader as EngineArchiveReader, GitSink as EngineGitSink, LocalSink as EngineLocalSink } from '@cclabsnz/sf-evidence-engine';
import { ArchiveReader, GitSink, LocalSink } from '../../../src/index.js';

/**
 * resolveEvaluateAnchor decides whether to evaluate the git anchor with `instanceof GitSink`.
 * If the CLI ever exported its own copy of a sink class, a CLI-constructed sink would fail
 * that check inside the engine and the anchor would silently go unevaluated.
 */
describe('classes shared with the engine', () => {
  it('re-exports the engine classes themselves, not copies', () => {
    expect(GitSink).toBe(EngineGitSink);
    expect(LocalSink).toBe(EngineLocalSink);
    expect(ArchiveReader).toBe(EngineArchiveReader);
  });
});
