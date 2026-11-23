import type { Degradation } from '../types/manifest.js';
import type { SourceId } from '../types/record.js';

/**
 * The permission each source's reads need, as the operator will search for it in Setup. It is
 * substituted into the permission remediations below, so each phrase reads after "the".
 */
const PERMISSION: Record<SourceId, string> = {
  'audit-trail': '"View Setup and Configuration" permission',
  limits: '"View Setup and Configuration" permission',
  'login-history':
    '"Monitor Login History" permission (API name MonitorLoginHistory) — the SF Evidence Reader permission set in templates/scheduling/salesforce includes it',
};

/**
 * Remediation text per error code. Written for the operator, naming the exact permission
 * label they will search for in Setup.
 */
const REMEDIATION: Record<string, (permission: string) => string> = {
  INSUFFICIENT_ACCESS: (p) => `Grant the running user the ${p}, then re-run.`,
  INSUFFICIENT_ACCESS_OR_READONLY: (p) => `Grant the running user the ${p}, then re-run.`,
  INVALID_TYPE: (p) =>
    `The object is not available in this org or is not visible to the running user. Confirm the org edition and the ${p}.`,
  INVALID_FIELD: () =>
    'A requested field is not available at this API version. The affected time slice is not collected, and the source is marked partial (or degraded, if no slice succeeded) for the whole requested window — the manifest does not record which slice failed. Re-run against an org on a newer API version.',
  QUERY_TIMEOUT: () =>
    'The query exceeded the org query timeout for this time slice, and the slice could not be narrowed further (floor: one hour). The slice bounds are recorded in the manifest; re-run collect for that window when the org is less busy.',
  QUERY_TRUNCATED: () =>
    'The time slice returned more rows than one query could fetch, even narrowed to one hour, so it was not collected and is not counted as covered. ' +
    'The slice bounds are recorded in the manifest; re-run collect for that window to collect it (if the sf config value maxQueryLimit is set, raise it first).',
  REQUEST_LIMIT_EXCEEDED: () =>
    'The org has exhausted its API request allocation. Re-run after the daily limit resets.',
};

/**
 * The codes that mean the running user cannot read a source at all: a missing permission, or
 * an object the org does not expose to them. Retrying another window will not help.
 */
export const PERMISSION_ERROR_CODES: ReadonlySet<string> = new Set([
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INVALID_TYPE',
]);

/**
 * The Salesforce error code an API failure carries, or undefined when `err` is not one.
 *
 * Deliberately not sf-core's `isApiError`, which also requires a numeric `statusCode`. The
 * error a real query rejects with is jsforce's `HttpApiError`, which has `errorCode` (and
 * `name`, `data`) but no `statusCode`, and neither @salesforce/core nor sf-core's
 * SoqlClientImpl adds one. Requiring it meant no real permission, timeout or field error was
 * ever recognised: each one failed the run instead of being recorded as a degradation.
 */
export function salesforceErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * Map an error to a coverage degradation, or null if it is not one (C6).
 *
 * Returning null matters as much as returning a value: an unrecognised failure must
 * propagate and fail the run rather than be silently recorded as reduced coverage, which
 * would be a gap dressed up as a known limitation.
 */
export function classifyDegradation(err: unknown, source: SourceId): Degradation | null {
  const code = salesforceErrorCode(err);
  if (code === undefined) return null;
  const remediationFor = REMEDIATION[code];
  if (!remediationFor) return null;

  return {
    source,
    code,
    detail: err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? code),
    remediation: remediationFor(PERMISSION[source]),
  };
}
