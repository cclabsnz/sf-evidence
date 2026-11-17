import { toIsoMs } from '../lib/time.js';
import type { NormalisedRecord } from '../types/record.js';

/**
 * Fields selected from SetupAuditTrail.
 *
 * `DelegateUser` is not optional. When an administrator acts through Login-As, Salesforce
 * records the user who *granted* access in CreatedById and the administrator who actually
 * performed the action in DelegateUser. An archive that keeps one and drops the other does
 * not lose detail — it inverts attribution (SPEC.md §1.2).
 */
export const AUDIT_TRAIL_FIELDS = [
  'Id',
  'Action',
  'Section',
  'Display',
  'CreatedDate',
  'CreatedById',
  'DelegateUser',
  'CreatedByContext',
  'CreatedByIssuer',
  'CreatedBy.Name',
  'CreatedBy.Username',
] as const;

export const AUDIT_TRAIL_SCHEMA = 'sf-evidence/audit-trail/v1';

export interface NormaliseContext {
  orgId: string;
  apiVersion: string;
  collectedAt: string;
}

/** A raw SetupAuditTrail row as returned by the SOQL client. */
export interface AuditTrailRow {
  Id?: string;
  Action?: string | null;
  Section?: string | null;
  Display?: string | null;
  CreatedDate?: string;
  CreatedById?: string | null;
  DelegateUser?: string | null;
  CreatedByContext?: string | null;
  CreatedByIssuer?: string | null;
  CreatedBy?: { Name?: string | null; Username?: string | null } | null;
  [k: string]: unknown;
}

/** Coerce `undefined` to `null` so an absent field is explicit rather than missing. */
function orNull(v: unknown): unknown {
  return v === undefined ? null : v;
}

export function normaliseAuditTrailRow(
  row: AuditTrailRow,
  ctx: NormaliseContext,
): NormalisedRecord {
  if (!row.Id) {
    throw new Error('SetupAuditTrail row is missing Id; it cannot be deduplicated.');
  }
  if (!row.CreatedDate) {
    throw new Error(`SetupAuditTrail row ${row.Id} is missing CreatedDate.`);
  }

  const createdDate = toIsoMs(row.CreatedDate);

  return {
    schema: AUDIT_TRAIL_SCHEMA,
    org_id: ctx.orgId,
    source: 'audit-trail',
    source_id: row.Id,
    occurred_at: createdDate,
    collected_at: ctx.collectedAt,
    api_version: ctx.apiVersion,
    payload: {
      Action: orNull(row.Action),
      CreatedByContext: orNull(row.CreatedByContext),
      CreatedById: orNull(row.CreatedById),
      CreatedByIssuer: orNull(row.CreatedByIssuer),
      CreatedByName: orNull(row.CreatedBy?.Name),
      CreatedByUsername: orNull(row.CreatedBy?.Username),
      CreatedDate: createdDate,
      DelegateUser: orNull(row.DelegateUser),
      Display: orNull(row.Display),
      Id: row.Id,
      Section: orNull(row.Section),
    },
  };
}
