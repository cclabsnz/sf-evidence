/** The three sources the archive can hold. Only `audit-trail` is implemented in Phase 0. */
export type SourceId = 'audit-trail' | 'login-history' | 'limits';

/**
 * The envelope every record from every source shares (SPEC.md §4.1).
 *
 * `payload` keeps verbatim Salesforce field names on purpose: an auditor tracing a record
 * back to the org should see the same field names in both places, and we should not be in
 * the business of inventing synonyms for `DelegateUser`.
 */
export interface NormalisedRecord {
  /** Source schema and version, e.g. `sf-evidence/audit-trail/v1`. */
  schema: string;
  /** 18-character org id, always. */
  org_id: string;
  source: SourceId;
  /** Dedupe key. The Salesforce Id for event sources (SPEC.md §4.6). */
  source_id: string;
  /** Salesforce's timestamp. Never the local clock. */
  occurred_at: string;
  /** Local clock at run start. Advisory only. */
  collected_at: string;
  /** API version used for the query that produced this record. */
  api_version: string;
  payload: Record<string, unknown>;
}
