import { normaliseAuditTrailRow, AUDIT_TRAIL_FIELDS } from '../../../src/collectors/normalise.js';
import { canonicalBytes } from '../../../src/chain/canonical.js';
import { sha256Hex } from '../../../src/chain/hash.js';
import { SPEC_VECTORS, ORG_ID } from '../../../src/testing/specVectors.js';

const CTX = {
  orgId: ORG_ID,
  apiVersion: '64.0',
  collectedAt: '2026-08-15T09:00:00.000Z',
};

/** A raw SOQL row exactly as jsforce returns it, including the nested CreatedBy join. */
const RAW_ROW = {
  Id: '0Ym5j00000XyZ01CAA',
  Action: 'PermSetAssign',
  Section: 'Manage Users',
  Display: 'Assigned permission set System Administrator to user kim.ngata@example.govt.nz',
  CreatedDate: '2026-08-14T02:11:09.000+0000',
  CreatedById: '0055j00000AaBbCcAAG',
  DelegateUser: 'support.admin@example.govt.nz',
  CreatedByContext: null,
  CreatedByIssuer: null,
  CreatedBy: { Name: 'Jo Taylor', Username: 'jo.taylor@example.govt.nz' },
};

describe('normaliseAuditTrailRow', () => {
  it('produces exactly the SPEC.md §6.4 record', () => {
    const record = normaliseAuditTrailRow(RAW_ROW, CTX);
    // CreatedByName is not in the spec vector's payload, so the vector omits it.
    // Assert the hash rather than deep-equality so any drift is caught at the byte level.
    const { CreatedByName: _drop, ...payload } = record.payload as Record<string, unknown>;
    expect(sha256Hex(canonicalBytes({ ...record, payload }))).toBe(SPEC_VECTORS.recordHash0);
  });

  it('uses the Salesforce timestamp for occurred_at, normalised to UTC milliseconds', () => {
    expect(normaliseAuditTrailRow(RAW_ROW, CTX).occurred_at).toBe('2026-08-14T02:11:09.000Z');
  });

  it('captures DelegateUser — the field that carries Login-As attribution', () => {
    const record = normaliseAuditTrailRow(RAW_ROW, CTX);
    expect((record.payload as Record<string, unknown>).DelegateUser).toBe(
      'support.admin@example.govt.nz',
    );
  });

  it('preserves an absent DelegateUser as null, not as a missing key', () => {
    const row = { ...RAW_ROW, DelegateUser: undefined };
    const record = normaliseAuditTrailRow(row, CTX);
    expect(record.payload).toHaveProperty('DelegateUser', null);
  });

  it('flattens the CreatedBy join into scalar payload fields', () => {
    const record = normaliseAuditTrailRow(RAW_ROW, CTX);
    const payload = record.payload as Record<string, unknown>;
    expect(payload.CreatedByUsername).toBe('jo.taylor@example.govt.nz');
    expect(payload.CreatedByName).toBe('Jo Taylor');
    expect(payload).not.toHaveProperty('CreatedBy');
  });

  it('tolerates a missing CreatedBy join by emitting nulls', () => {
    const { CreatedBy: _omit, ...row } = RAW_ROW;
    const payload = normaliseAuditTrailRow(row, CTX).payload as Record<string, unknown>;
    expect(payload.CreatedByUsername).toBeNull();
    expect(payload.CreatedByName).toBeNull();
  });

  it('drops the jsforce attributes envelope', () => {
    const row = { ...RAW_ROW, attributes: { type: 'SetupAuditTrail', url: '/x' } };
    expect(normaliseAuditTrailRow(row, CTX).payload).not.toHaveProperty('attributes');
  });

  it('sets source_id to the Salesforce Id, which is the dedupe key', () => {
    expect(normaliseAuditTrailRow(RAW_ROW, CTX).source_id).toBe('0Ym5j00000XyZ01CAA');
  });

  it('throws when Id is missing, rather than writing an undedupable record', () => {
    const { Id: _omit, ...row } = RAW_ROW;
    expect(() => normaliseAuditTrailRow(row, CTX)).toThrow(/missing Id/i);
  });

  it('throws when CreatedDate is missing, rather than writing a record without occurred_at integrity', () => {
    const { CreatedDate: _omit, ...row } = RAW_ROW;
    expect(() => normaliseAuditTrailRow(row, CTX)).toThrow(/missing CreatedDate/i);
  });
});

describe('AUDIT_TRAIL_FIELDS', () => {
  it('includes DelegateUser', () => {
    expect(AUDIT_TRAIL_FIELDS).toContain('DelegateUser');
  });

  it('requests the CreatedBy join rather than a second query', () => {
    expect(AUDIT_TRAIL_FIELDS).toContain('CreatedBy.Username');
    expect(AUDIT_TRAIL_FIELDS).toContain('CreatedBy.Name');
  });
});
