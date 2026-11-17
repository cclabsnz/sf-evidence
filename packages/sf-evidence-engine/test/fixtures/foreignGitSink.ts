import { GitSink } from '../../src/sinks/git.js';
import type { Sink } from '../../src/types/sink.js';

/**
 * A GitSink as a second installed copy of the engine would hand us: same shape, different
 * class identity. Happens when a host depends on the engine directly and also on
 * @cclabsnz/sf-evidence, and the two engine ranges don't dedupe.
 */
export function foreignGitSink(root: string): Sink & { anchorOrgId?: string } {
  const original = new GitSink(root);
  const foreign = Object.create(Object.prototype) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(GitSink.prototype)) {
    if (key !== 'constructor') foreign[key] = (GitSink.prototype as unknown as Record<string, unknown>)[key];
  }
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(GitSink.prototype))) {
    if (key !== 'constructor' && !(key in foreign)) {
      foreign[key] = (Object.getPrototypeOf(GitSink.prototype) as Record<string, unknown>)[key];
    }
  }
  Object.assign(foreign, original);
  return foreign as unknown as Sink & { anchorOrgId?: string };
}
