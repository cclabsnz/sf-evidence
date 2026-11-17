import { isApiError } from '@cclabsnz/sf-core';
import type { Degradation } from '../types/manifest.js';
import type { SourceId } from '../types/record.js';

/**
 * Remediation text per error code. Written for the operator, naming the exact permission
 * label they will search for in Setup.
 */
const REMEDIATION: Record<string, string> = {
  INSUFFICIENT_ACCESS:
    'Grant the running user the "View Setup and Configuration" permission, then re-run.',
  INSUFFICIENT_ACCESS_OR_READONLY:
    'Grant the running user the "View Setup and Configuration" permission, then re-run.',
  INVALID_TYPE:
    'The object is not available in this org or is not visible to the running user. Confirm the org edition and the "View Setup and Configuration" permission.',
  INVALID_FIELD:
    'A requested field is not available at this API version. The affected time slice is not collected, and the source is marked partial (or degraded, if no slice succeeded) for the whole requested window — the manifest does not record which slice failed. Re-run against an org on a newer API version.',
  QUERY_TIMEOUT:
    'The query exceeded the org query timeout for this time slice, and the slice could not be narrowed further (floor: one hour). The slice bounds are recorded in the manifest; re-run collect for that window when the org is less busy.',
  REQUEST_LIMIT_EXCEEDED:
    'The org has exhausted its API request allocation. Re-run after the daily limit resets.',
};

/**
 * Map an error to a coverage degradation, or null if it is not one (C6).
 *
 * Returning null matters as much as returning a value: an unrecognised failure must
 * propagate and fail the run rather than be silently recorded as reduced coverage, which
 * would be a gap dressed up as a known limitation.
 */
export function classifyDegradation(err: unknown, source: SourceId): Degradation | null {
  if (!isApiError(err)) return null;
  const remediation = REMEDIATION[err.errorCode];
  if (!remediation) return null;

  return {
    source,
    code: err.errorCode,
    detail: err.message,
    remediation,
  };
}
