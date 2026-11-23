import { EXIT, type ExitCode } from './exit.js';
import { PERMISSION_ERROR_CODES, salesforceErrorCode } from './errors.js';
import type { Sink } from '../types/sink.js';

/**
 * `sf evidence doctor` (SPEC.md §8.10): environment diagnostics, with every external
 * dependency injected so a host that never loads the sf CLI can run the same checks.
 *
 * The recurring defect this module guards against is a report that claims more than the code
 * established. So a check that did not run says so, and a check that ran says only what it
 * observed: "writable" means `sink.init()` accepted the target (no file is created to find
 * out), and a signing key is "set", never "working".
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  remediation?: string;
  /**
   * False when the check did not look at anything: skipped for want of input, or not
   * applicable in this release. `level: 'ok'` on such a row means "nothing wrong found", never
   * "passed"; consumers of the JSON must read this field to tell the two apart.
   */
  checked: boolean;
}

export interface DoctorEnv {
  /** `process.version` or a bare `22.4.0`. */
  nodeVersion: string;
  /** Or the reason they could not be read; doctor reports that as a warning, not a crash. */
  versions: { plugin: string; engine: string } | { error: string };
  sink: Sink;
  /** Enables the chain-head check. */
  orgId?: string;
  /** Resolve a command on PATH to its location, or null. Must not run the command. */
  which(cmd: string): Promise<string | null>;
  /** One `git config --get` value, or null when the key is unset. Throws when git could not look. */
  gitConfig(key: string): Promise<string | null>;
  /**
   * Rows contributed by other plugins (the query plugin's "Query engine" row arrives this way).
   * Absent or empty means no such plugin answered, and doctor says the engine is not installed.
   */
  extraChecks?(): Promise<Check[]>;
  /** The org's clock. Supplied only when an org was named; absent means skew was not measured. */
  orgNow?(): Promise<Date>;
  /**
   * Reads one LoginHistory row (`SELECT Id FROM LoginHistory LIMIT 1`). Supplied only when an
   * org was named; resolves on success and rejects with the API error otherwise.
   */
  probeLoginHistory?(): Promise<void>;
  /** The local clock; defaults to `new Date()`. */
  now?(): Date;
}

export const MIN_NODE_MAJOR = 22;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const NOT_APPLICABLE = 'not applicable in this release';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runChecks(env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [nodeCheck(env.nodeVersion), versionsCheck(env.versions)];

  const archive = await archiveCheck(env.sink);
  checks.push(archive, await chainHeadCheck(env.sink, env.orgId));

  if (env.sink.id === 'git') {
    checks.push(...(await gitChecks(env, archive.level === 'ok')));
  }

  checks.push(...(await queryEngineChecks(env)));
  checks.push(await clockCheck(env));
  checks.push(await loginHistoryCheck(env));

  // Listed, never omitted: a reader must be able to tell "passed" from "never looked".
  for (const name of ['DuckDB httpfs/azure extensions', 'Cloud credentials', 'Licence file', 'Config file']) {
    checks.push({ name, level: 'ok', detail: NOT_APPLICABLE, checked: false });
  }
  return checks;
}

function nodeCheck(version: string): Check {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return { name: 'Node version', level: 'ok', detail: `${version} (needs ${MIN_NODE_MAJOR} or later)`, checked: true };
  }
  return {
    name: 'Node version',
    level: 'fail',
    detail: `${version} is older than the ${MIN_NODE_MAJOR} this plugin requires`,
    remediation: `Install Node ${MIN_NODE_MAJOR} or later.`,
    checked: true,
  };
}

function versionsCheck(v: DoctorEnv['versions']): Check {
  const name = 'Plugin and engine versions';
  if ('error' in v) {
    return { name, level: 'warn', detail: `could not read package versions: ${v.error}`, checked: true };
  }
  return { name, level: 'ok', detail: `plugin ${v.plugin}, engine ${v.engine}`, checked: true };
}

async function archiveCheck(sink: Sink): Promise<Check> {
  try {
    await sink.init();
    return {
      name: 'Archive reachable and writable',
      level: 'ok',
      detail: `${sink.id} sink accepted ${sink.describe().location} (checked without writing)`,
      checked: true,
    };
  } catch (err) {
    return {
      name: 'Archive reachable and writable',
      level: 'fail',
      detail: message(err).split('\n')[0] ?? 'sink.init() failed',
      remediation: 'Create the archive directory (or git repository) yourself, or pass --archive.',
      checked: true,
    };
  }
}

async function chainHeadCheck(sink: Sink, orgId: string | undefined): Promise<Check> {
  const name = 'Chain head readable';
  if (!orgId) return { name, level: 'ok', detail: 'not checked: pass --org-id to read a chain head', checked: false };
  try {
    const head = await sink.head(orgId);
    if (head === null) return { name, level: 'ok', detail: `no chain yet for ${orgId}`, checked: true };
    if (typeof head.seq !== 'number' || typeof head.manifest_hash !== 'string') {
      return {
        name,
        level: 'fail',
        detail: 'head.json parsed but lacks seq or manifest_hash',
        remediation: 'Run `sf evidence verify` for this org; head.json is rebuilt from the manifests on the next collect.',
        checked: true,
      };
    }
    return { name, level: 'ok', detail: `head.json parsed: seq ${head.seq} (chain not verified; run verify)`, checked: true };
  } catch (err) {
    return {
      name,
      level: 'fail',
      detail: `head.json could not be read: ${message(err)}`,
      remediation: 'Run `sf evidence verify` for this org to see what the chain itself says.',
      checked: true,
    };
  }
}

async function gitChecks(env: DoctorEnv, repoAccepted: boolean): Promise<Check[]> {
  const git = await env.which('git');
  const out: Check[] = [
    git
      ? { name: 'Git present', level: 'ok', detail: git, checked: true }
      : {
          name: 'Git present',
          level: 'warn',
          detail: 'git is not on PATH',
          remediation: 'Install git; the git sink commits each batch with it.',
          checked: true,
        },
    repoAccepted
      ? {
          name: 'Git repository state',
          level: 'ok',
          detail: 'archive root is a git repository (confirmed by the archive check)',
          checked: true,
        }
      : {
          name: 'Git repository state',
          level: 'warn',
          detail: 'not confirmed: the archive check failed',
          remediation: 'Fix the archive check above, then re-run doctor.',
          checked: false,
        },
  ];
  out.push(await signingCheck(env, git !== null, repoAccepted));
  return out;
}

/** "Not set" is claimed only when git actually looked in the archive and found no key. */
async function signingCheck(env: DoctorEnv, haveGit: boolean, repoAccepted: boolean): Promise<Check> {
  const name = 'Git signing key';
  if (!haveGit) return { name, level: 'warn', detail: 'not checked: git is not on PATH', checked: false };
  if (!repoAccepted) {
    return { name, level: 'warn', detail: 'not checked: the archive check failed, so git config was not read', checked: false };
  }
  let key: string | null;
  try {
    key = await env.gitConfig('user.signingkey');
  } catch (err) {
    return { name, level: 'warn', detail: `not checked: git config could not be read: ${message(err)}`, checked: false };
  }
  if (key) {
    return { name, level: 'ok', detail: 'user.signingkey is set (the key itself is not tested)', checked: true };
  }
  return {
    name,
    level: 'warn',
    detail: 'user.signingkey is not set, so `collect --sign` has no key to use',
    remediation: 'Set it with `git config user.signingkey <key id>` if you want signed anchor commits.',
    checked: true,
  };
}

/** An absent query plugin is not a fault: the placeholder is `ok` and unchecked, never a warning. */
async function queryEngineChecks(env: DoctorEnv): Promise<Check[]> {
  const extra = (await env.extraChecks?.()) ?? [];
  if (extra.length > 0) return extra;
  return [
    {
      name: 'Query engine',
      level: 'ok',
      detail: 'not installed (sf plugins install @cclabsnz/sf-evidence-query)',
      checked: false,
    },
  ];
}

async function clockCheck(env: DoctorEnv): Promise<Check> {
  const name = 'Clock skew against the org';
  if (!env.orgNow) {
    return { name, level: 'ok', detail: 'not checked: pass --target-org to compare clocks', checked: false };
  }
  try {
    const org = await env.orgNow();
    const local = (env.now ?? (() => new Date()))();
    const skew = Math.abs(org.getTime() - local.getTime());
    const seconds = Math.round(skew / 1000);
    if (skew > MAX_CLOCK_SKEW_MS) {
      return {
        name,
        level: 'warn',
        detail:
          `local clock ${org < local ? 'runs ahead of' : 'runs behind'} the org by about ${seconds}s; ` +
          'this affects collection, not only timestamps',
        remediation:
          'Sync this machine with NTP. collect ends each window at the earlier of the local and org ' +
          'clocks when it can read the org clock; when it cannot, it uses the local clock, and a local ' +
          'clock ahead of the org leaves the org events in between uncollected.',
        checked: true,
      };
    }
    return {
      name,
      level: 'ok',
      detail: `about ${seconds}s (to the second; limit ${MAX_CLOCK_SKEW_MS / 60_000} minutes)`,
      checked: true,
    };
  } catch (err) {
    return { name, level: 'warn', detail: `not checked: could not read the org clock: ${message(err)}`, checked: false };
  }
}

async function loginHistoryCheck(env: DoctorEnv): Promise<Check> {
  const name = 'Login History access';
  if (!env.probeLoginHistory) {
    return { name, level: 'ok', detail: 'not checked: pass --target-org to test access', checked: false };
  }
  try {
    await env.probeLoginHistory();
    return { name, level: 'ok', detail: 'the running user can read LoginHistory', checked: true };
  } catch (err) {
    const code = salesforceErrorCode(err);
    if (code !== undefined && PERMISSION_ERROR_CODES.has(code)) {
      return {
        name,
        level: 'warn',
        detail: `the running user cannot read LoginHistory (${code}); the "Monitor Login History" permission (API name MonitorLoginHistory) is missing`,
        remediation:
          'Assign the SF Evidence Reader permission set (it includes MonitorLoginHistory), or collect without login-history using --source audit-trail,limits.',
        checked: true,
      };
    }
    return { name, level: 'warn', detail: `could not test LoginHistory access: ${message(err)}`, checked: true };
  }
}

/** SPEC.md §8.10: 0 all ok, 4 on any warning, 1 on any failure. */
export function doctorExitCode(checks: readonly Check[]): ExitCode {
  if (checks.some((c) => c.level === 'fail')) return EXIT.ERROR;
  if (checks.some((c) => c.level === 'warn')) return EXIT.DEGRADED;
  return EXIT.OK;
}

/** One line per check (a row that looked at nothing reads `skipped`, whatever its level); the remediation, when there is one, on the line beneath. */
export function formatChecks(checks: readonly Check[]): string[] {
  return checks.flatMap((c) => [
    `${(!c.checked && c.level === 'ok' ? 'skipped' : c.level).padEnd(7)} ${c.name}: ${c.detail}`,
    ...(c.remediation ? [`        fix: ${c.remediation}`] : []),
  ]);
}
