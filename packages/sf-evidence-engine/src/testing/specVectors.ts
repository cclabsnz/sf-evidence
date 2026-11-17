/**
 * Golden values from SPEC.md §6.4, computed with Python `hashlib` while the specification
 * was written — i.e. by an implementation other than this one. They are the contract
 * between this codebase and any third-party verifier.
 */
export const ORG_ID = '00D5j000000AbCdEAK';

export const RECORD_0 = {
  schema: 'sf-evidence/audit-trail/v1',
  org_id: ORG_ID,
  source: 'audit-trail',
  source_id: '0Ym5j00000XyZ01CAA',
  occurred_at: '2026-08-14T02:11:09.000Z',
  collected_at: '2026-08-15T09:00:00.000Z',
  api_version: '64.0',
  payload: {
    Action: 'PermSetAssign',
    CreatedByContext: null,
    CreatedByIssuer: null,
    CreatedById: '0055j00000AaBbCcAAG',
    CreatedByUsername: 'jo.taylor@example.govt.nz',
    CreatedDate: '2026-08-14T02:11:09.000Z',
    DelegateUser: 'support.admin@example.govt.nz',
    Display:
      'Assigned permission set System Administrator to user kim.ngata@example.govt.nz',
    Id: '0Ym5j00000XyZ01CAA',
    Section: 'Manage Users',
  },
} as const;

export const RECORD_1 = {
  schema: 'sf-evidence/audit-trail/v1',
  org_id: ORG_ID,
  source: 'audit-trail',
  source_id: '0Ym5j00000XyZ02CAA',
  occurred_at: '2026-08-14T02:12:44.000Z',
  collected_at: '2026-08-15T09:00:00.000Z',
  api_version: '64.0',
  payload: {
    Action: 'changedProfile',
    CreatedByContext: null,
    CreatedByIssuer: null,
    CreatedById: '0055j00000AaBbCcAAG',
    CreatedByUsername: 'jo.taylor@example.govt.nz',
    CreatedDate: '2026-08-14T02:12:44.000Z',
    DelegateUser: null,
    Display:
      'Changed profile for user kim.ngata@example.govt.nz from Standard User to System Administrator',
    Id: '0Ym5j00000XyZ02CAA',
    Section: 'Manage Users',
  },
} as const;

export const SPEC_VECTORS = {
  recordHash0: '9006df91f5e64124b3227379f8b605f87f121aa5089f5fe0ffc42c906632ec9b',
  recordHash1: 'fadcc7bfd4d22901cc161aa3ac9ff5423ffaed173860a8505313cda95a45ed8e',
  recordsRoot: '177ae7a662d4205d2db8bf956b4b084ab87fd4301b9a44a239c3621afeaa5209',
  fileBytes: 1245,
  fileSha256: '5943908130bc2e45ea4e597b2cf0d182c9b436d4a203996458536d42121ad25f',
  manifestHash1: 'd8c43464f5ee0b5d4cb632d1a5212ead87f047a1c4a6ebda6638834d0b5f6005',
  /** Same record with DelegateUser nulled — the attribution-erasing edit. */
  tamperedRecordHash0: '92355eebd195bdc816d61f72729f7d324cb104dc10552d1a81ca69a150289447',
  tamperedRecordsRoot: 'ba6550356a661a6445c84dde67c63420591198395f4492d8ab570c361ecc062c',
} as const;
