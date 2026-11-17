import { resolve } from 'node:path';
import {
  EXIT,
  GitSink,
  LocalSink,
  type ExitCode,
  type GitSinkOptions,
  type Sink,
  type SinkId,
} from '@cclabsnz/sf-evidence-engine';

/** Tier 0 default: no configuration, archive beside the working directory (SPEC.md §9.1). */
export const DEFAULT_ARCHIVE = './sf-evidence-archive';

const IMPLEMENTED: SinkId[] = ['local', 'git'];

export interface SinkResolveOptions {
  /** git only: sign each manifest commit with the operator's key. We never hold a key. */
  sign?: boolean;
  /** git only: `verify --anchor git` fails on any unsigned manifest commit. */
  requireSigned?: boolean;
}

export function resolveSink(id: string, root: string, opts: SinkResolveOptions = {}): Sink {
  const gitOptions: GitSinkOptions = { sign: opts.sign, requireSigned: opts.requireSigned };
  switch (id) {
    case 'local':
      return new LocalSink(root);
    case 'git':
      return new GitSink(root, gitOptions);
    default:
      throw new Error(
        `Sink '${id}' is not available in this release. Available: ${IMPLEMENTED.join(', ')}.`,
      );
  }
}

/**
 * Resolve a comma-separated `--sink` list, rejecting two canonical sinks that would write to
 * the same archive root.
 *
 * `--sink local,git` against one root is not a redundant mirror, it is two writers claiming
 * the same chain: the first `putBatch` writes records, manifest and head, and the second
 * fails on the manifest's exclusive publish with "Manifest sequence 1 already exists" — a
 * concurrency message for a configuration error, raised after a partial write. It is
 * rejected up front, before anything is written, and named for what it actually is.
 *
 * The check is on the resolved filesystem root, not the sink id, so `--archive ./a` twice by
 * different relative spellings is still caught. Non-canonical sinks (a SIEM mirror) are
 * exempt: they cannot hold the chain, so two of them cannot collide over it.
 *
 * There is no flag combination that fixes this within one invocation — `--archive` takes a
 * single root and applies it to every sink in `--sink` — so the remedy the error names is
 * two runs, not two flags.
 */
export function resolveSinks(
  ids: readonly string[],
  root: string,
  opts: SinkResolveOptions = {},
): Sink[] {
  const sinks = ids.map((id) => resolveSink(id.trim(), root, opts));
  const claimed = new Map<string, Sink>();

  for (const sink of sinks) {
    if (!sink.capabilities.canonical) continue;
    const location = resolve(sink.describe().location);
    const other = claimed.get(location);
    if (other) {
      throw new Error(
        `Sinks '${other.id}' and '${sink.id}' both resolve to the same archive root ` +
          `(${location}). Two canonical sinks cannot share one chain — each would claim the ` +
          'same manifest sequence. --archive takes one root and applies it to every sink, so ' +
          'there is no single command that writes these two sinks to separate roots: run ' +
          'collect once per sink, each with its own --archive, or pick one sink. ' +
          `(The 'git' sink already writes every file the 'local' sink does; it adds a commit ` +
          'on top, so it is not a second copy.)',
      );
    }
    claimed.set(location, sink);
  }

  return sinks;
}

export function exitCodeFor(result: { degraded: boolean }, failOnDegraded: boolean): ExitCode {
  if (!result.degraded) return EXIT.OK;
  return failOnDegraded ? EXIT.ERROR : EXIT.DEGRADED;
}
