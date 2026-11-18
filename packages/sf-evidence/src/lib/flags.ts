import { EXIT, type ExitCode } from '@cclabsnz/sf-evidence-engine';

export function exitCodeFor(result: { degraded: boolean }, failOnDegraded: boolean): ExitCode {
  if (!result.degraded) return EXIT.OK;
  return failOnDegraded ? EXIT.ERROR : EXIT.DEGRADED;
}
