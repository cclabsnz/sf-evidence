import {
  LoginHistoryCollector,
  loginHistoryFields,
  LOGIN_HISTORY_BASE_FIELDS,
} from '../../../src/collectors/loginHistory.js';
import { LOGIN_HISTORY_SCHEMA } from '../../../src/collectors/normalise.js';
import { LimitsCollector } from '../../../src/collectors/limits.js';
import { API_VERSION } from '../../../src/salesforce.js';
import { ORG_ID } from '../../../src/testing/specVectors.js';
import type { SoqlClient } from '@cclabsnz/sf-core';
import { sfApiError } from '../../fixtures/httpApiError.js';

const VERSIONED = ['ForwardedForIp', 'AuthMethodReference', 'AuthContextClassRef'];

/** Invented values only: nothing here comes from a real org. */
function row(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: `0Ya5j00000LhIs${String(i).padStart(2, '0')}AAA`,
    UserId: '0055j00000AaBbCcAAG',
    LoginTime: `2026-08-14T02:11:${String(i % 60).padStart(2, '0')}.000+0000`,
    LoginType: 'Application',
    LoginSubType: null,
    Status: 'Success',
    Application: 'Browser',
    Browser: 'Firefox 140',
    Platform: 'Linux',
    SourceIp: '203.0.113.10',
    CountryIso: 'NZ',
    LoginGeoId: '04F5j00000GeOaaEAA',
    LoginUrl: 'acme.my.salesforce.com',
    NetworkId: null,
    ApiType: null,
    ApiVersion: null,
    ClientVersion: null,
    AuthenticationServiceId: null,
    CipherSuite: 'ECDHE-RSA-AES256-GCM-SHA384',
    TlsProtocol: 'TLS 1.3',
    OptionsIsGet: false,
    OptionsIsPost: true,
    ForwardedForIp: null,
    AuthMethodReference: null,
    AuthContextClassRef: null,
    ...over,
  };
}

function fakeSoql(impl: (soql: string) => Promise<unknown[]>): SoqlClient {
  return {
    query: async () => ({ totalSize: 0, done: true, records: [] }),
    queryAll: (async (soql: string) => impl(soql)) as SoqlClient['queryAll'],
  } as SoqlClient;
}

function apiError(errorCode: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { errorCode, statusCode: 400, name: 'ApiError' });
}

const CTX = {
  orgId: ORG_ID,
  apiVersion: '67.0',
  collectedAt: '2026-08-15T09:00:00.000Z',
};

/** Inside one calendar month: exactly one slice. */
const ONE_SLICE = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' };
/** Three month slices: June, July, August. */
const THREE_SLICES = { from: '2026-06-01T00:00:00.000Z', to: '2026-08-15T09:00:00.000Z' };

const selected = (soql: string): string[] =>
  soql.slice('SELECT '.length, soql.indexOf(' FROM ')).split(', ');

describe('loginHistoryFields', () => {
  it('has the 22 base fields in order', () => {
    expect(LOGIN_HISTORY_BASE_FIELDS).toHaveLength(22);
    expect(loginHistoryFields('50.0')).toEqual([...LOGIN_HISTORY_BASE_FIELDS]);
  });

  it('adds versioned fields whose since is at or below the API version', () => {
    const at64 = loginHistoryFields('64.0');
    expect(at64).toHaveLength(24);
    expect(at64).toContain('ForwardedForIp');
    expect(at64).toContain('AuthMethodReference');
    expect(at64).not.toContain('AuthContextClassRef');
    expect(loginHistoryFields('67.0')).toHaveLength(25);
    expect(loginHistoryFields('67.0')).toContain('AuthContextClassRef');
  });
});

describe('API_VERSION', () => {
  it('is 67.0, and the limits collector reads at that version', () => {
    expect(API_VERSION).toBe('67.0');
    expect(new LimitsCollector().describeQueries()[0]!.soql).toBe('GET /services/data/v67.0/limits/');
  });
});

describe('LoginHistoryCollector', () => {
  it('is an event source with the documented 180-day retention', () => {
    const c = new LoginHistoryCollector();
    expect(c.source).toBe('login-history');
    expect(c.kind).toBe('event');
    expect(c.retentionDays).toBe(180);
  });

  it('queries all 25 fields over the slice, ordered by LoginTime then Id', async () => {
    const seen: string[] = [];
    const soql = fakeSoql(async (q) => {
      seen.push(q);
      return [row(1), row(2)];
    });
    const outcome = await new LoginHistoryCollector().collect({ ...CTX, soql }, { window: ONE_SLICE });

    expect(seen).toEqual([
      `SELECT ${loginHistoryFields('67.0').join(', ')} FROM LoginHistory ` +
        'WHERE LoginTime >= 2026-08-01T00:00:00Z AND LoginTime < 2026-08-15T09:00:00Z ' +
        'ORDER BY LoginTime ASC, Id ASC',
    ]);
    expect(selected(seen[0]!)).toHaveLength(25);
    expect(outcome.status).toBe('complete');
    expect(outcome.records).toHaveLength(2);
    const rec = outcome.records[0]!;
    expect(rec.schema).toBe(LOGIN_HISTORY_SCHEMA);
    expect(rec.source).toBe('login-history');
    expect(rec.source_id).toBe(row(1).Id);
    expect(rec.occurred_at).toBe('2026-08-14T02:11:01.000Z');
    expect(rec.api_version).toBe('67.0');
    expect(Object.keys(rec.payload).sort()).toEqual([...loginHistoryFields('67.0')].sort());
    expect(outcome.fetched).toBe(2);
    expect(outcome.deduped).toBe(0);
  });

  it('skips a row already in the archive and counts it as deduped', async () => {
    const soql = fakeSoql(async () => [row(1), row(2)]);
    const outcome = await new LoginHistoryCollector().collect(
      { ...CTX, soql },
      { window: ONE_SLICE, knownSourceIds: new Set([row(1).Id as string]) },
    );
    expect(outcome.deduped).toBe(1);
    expect(outcome.records.map((r) => r.source_id)).toEqual([row(2).Id]);
    expect(outcome.fetched).toBe(outcome.records.length + outcome.deduped);
  });

  it('refuses to drop a row with no Id', async () => {
    const soql = fakeSoql(async () => [row(1, { Id: undefined })]);
    await expect(
      new LoginHistoryCollector().collect({ ...CTX, soql }, { window: ONE_SLICE }),
    ).rejects.toThrow(/LoginHistory.*Id/);
  });

  it('drops the versioned fields once on INVALID_FIELD and keeps them dropped for the run', async () => {
    const seen: string[] = [];
    const soql = fakeSoql(async (q) => {
      seen.push(q);
      if (seen.length === 1) throw apiError('INVALID_FIELD', "No such column 'AuthContextClassRef'");
      return [row(seen.length)];
    });
    const outcome = await new LoginHistoryCollector().collect({ ...CTX, soql }, { window: THREE_SLICES });

    // First June attempt, June retry, July, August.
    expect(seen).toHaveLength(4);
    expect(selected(seen[0]!)).toHaveLength(25);
    const juneWhere = (q: string) => q.slice(q.indexOf(' WHERE '));
    expect(juneWhere(seen[1]!)).toBe(juneWhere(seen[0]!));
    for (const q of seen.slice(1)) {
      expect(selected(q)).toEqual([...LOGIN_HISTORY_BASE_FIELDS]);
    }

    expect(outcome.status).toBe('complete');
    expect(outcome.degradations).toHaveLength(1);
    const d = outcome.degradations[0]!;
    expect(d).toMatchObject({
      source: 'login-history',
      code: 'INVALID_FIELD',
      detail: "No such column 'AuthContextClassRef'",
      fieldsDropped: VERSIONED,
      remediation:
        "The org rejected these LoginHistory fields although API v67.0 should expose them; records from this run omit them. Check the org's API version and field visibility for the running user.",
    });
    expect(d.window).toBeUndefined();

    expect(outcome.records).toHaveLength(3);
    for (const rec of outcome.records) {
      for (const f of VERSIONED) expect(rec.payload).not.toHaveProperty(f);
      expect(Object.keys(rec.payload)).toHaveLength(22);
    }
  });

  it('starts with omitFields already dropped: never issues the failing query, still records the downgrade', async () => {
    const seen: string[] = [];
    const soql = fakeSoql(async (q) => {
      seen.push(q);
      return [row(seen.length)];
    });
    const outcome = await new LoginHistoryCollector().collect(
      { ...CTX, soql },
      { window: THREE_SLICES, omitFields: VERSIONED },
    );

    expect(seen).toHaveLength(3);
    for (const q of seen) expect(selected(q)).toEqual([...LOGIN_HISTORY_BASE_FIELDS]);
    expect(outcome.status).toBe('complete');
    expect(outcome.degradations).toHaveLength(1);
    const d = outcome.degradations[0]!;
    expect(d).toMatchObject({
      source: 'login-history',
      code: 'INVALID_FIELD',
      fieldsDropped: VERSIONED,
      remediation:
        "The org rejected these LoginHistory fields although API v67.0 should expose them; records from this run omit them. Check the org's API version and field visibility for the running user.",
    });
    expect(d.detail).toMatch(/earlier in this run/);
    expect(d.window).toBeUndefined();
    for (const rec of outcome.records) expect(Object.keys(rec.payload)).toHaveLength(22);
  });

  it('keeps 25 fields on records fetched before a later slice triggers the downgrade', async () => {
    const seen: string[] = [];
    const soql = fakeSoql(async (q) => {
      seen.push(q);
      if (seen.length === 2) throw apiError('INVALID_FIELD', "No such column 'AuthContextClassRef'");
      return [row(seen.length)];
    });
    const outcome = await new LoginHistoryCollector().collect({ ...CTX, soql }, { window: THREE_SLICES });

    // June (25 fields), July attempt (25, rejected), July retry (22), August (22).
    expect(seen.map((q) => selected(q).length)).toEqual([25, 25, 22, 22]);
    const byId = new Map(outcome.records.map((r) => [r.source_id, Object.keys(r.payload).length]));
    expect(byId.get(row(1).Id as string)).toBe(25);
    expect(byId.get(row(3).Id as string)).toBe(22);
    expect(byId.get(row(4).Id as string)).toBe(22);
  });

  it('records a second INVALID_FIELD after the downgrade as an ordinary slice degradation', async () => {
    const soql = fakeSoql(async () => {
      throw apiError('INVALID_FIELD');
    });
    const outcome = await new LoginHistoryCollector().collect({ ...CTX, soql }, { window: ONE_SLICE });

    expect(outcome.status).toBe('degraded');
    expect(outcome.records).toEqual([]);
    expect(outcome.achieved).toEqual([]);
    const slice = outcome.degradations.find((d) => d.window !== undefined);
    expect(slice).toMatchObject({ code: 'INVALID_FIELD', window: ONE_SLICE });
  });

  it('degrades, never completes empty, when every slice lacks access', async () => {
    const soql = fakeSoql(async () => {
      throw apiError('INSUFFICIENT_ACCESS');
    });
    const outcome = await new LoginHistoryCollector().collect({ ...CTX, soql }, { window: THREE_SLICES });

    expect(outcome.status).toBe('degraded');
    expect(outcome.records).toEqual([]);
    expect(outcome.degradations).toHaveLength(3);
    for (const d of outcome.degradations) {
      expect(d.source).toBe('login-history');
      expect(d.remediation).toContain('Monitor Login History');
      expect(d.remediation).toContain('MonitorLoginHistory');
    }
  });

  it('describes one LoginHistory query with placeholders and the permission it needs', () => {
    const qs = new LoginHistoryCollector().describeQueries();
    expect(qs).toHaveLength(1);
    expect(qs[0]!.object).toBe('LoginHistory');
    expect(qs[0]!.permission).toContain('Monitor Login History');
    expect(qs[0]!.soql).toContain('LoginTime >= <from> AND LoginTime < <to>');
    expect(qs[0]!.soql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('LoginHistoryCollector with the error shape jsforce actually throws', () => {
  it('records a real-shape INSUFFICIENT_ACCESS as degraded, naming MonitorLoginHistory', async () => {
    const soql = fakeSoql(async () => {
      throw sfApiError('INSUFFICIENT_ACCESS', 'Insufficient privileges to access LoginHistory');
    });
    const out = await new LoginHistoryCollector().collect({ ...CTX, soql }, { window: ONE_SLICE });

    expect(out.status).toBe('degraded');
    expect(out.achieved).toEqual([]);
    expect(out.records).toEqual([]);
    expect(out.degradations).toHaveLength(1);
    expect(out.degradations[0]).toMatchObject({ source: 'login-history', code: 'INSUFFICIENT_ACCESS', window: ONE_SLICE });
    expect(out.degradations[0]!.remediation).toContain('MonitorLoginHistory');
  });

  it('downgrades the versioned fields on a real-shape INVALID_FIELD', async () => {
    const widths: number[] = [];
    const soql = fakeSoql(async (q) => {
      widths.push(selected(q).length);
      if (selected(q).includes('AuthContextClassRef')) {
        throw sfApiError('INVALID_FIELD', "No such column 'AuthContextClassRef' on entity 'LoginHistory'.");
      }
      return [row(1)];
    });
    const out = await new LoginHistoryCollector().collect({ ...CTX, soql }, { window: ONE_SLICE });

    expect(widths).toEqual([25, 22]);
    expect(out.status).toBe('complete');
    expect(out.degradations).toHaveLength(1);
    expect(out.degradations[0]).toMatchObject({ code: 'INVALID_FIELD', fieldsDropped: VERSIONED });
  });
});
