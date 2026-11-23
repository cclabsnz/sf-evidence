import { join } from 'node:path';
import {
  orgPrefix,
  recordFilePath,
  manifestPath,
  headPath,
  statePath,
  parseOrgDir,
  isOrgId,
  isRecordPath,
  absoluteRecordPath,
} from '../../../src/sinks/layout.js';

const ORG = '00D5j000000AbCdEAK';

describe('layout', () => {
  it('builds a Hive-partitioned record path from the record occurrence month', () => {
    expect(
      recordFilePath({
        orgId: ORG,
        source: 'audit-trail',
        occurredAt: '2026-08-14T02:11:09.000Z',
        collectedAt: '2026-08-15T09:00:12.482Z',
        runId: '01K3QF8H2N0000000000000000',
      }),
    ).toBe(
      'org_id=00D5j000000AbCdEAK/source=audit-trail/year=2026/month=08/part-20260815T090012Z-01K3QF8H.ndjson',
    );
  });

  it('partitions by the UTC month of occurred_at, not of collected_at', () => {
    // Collected in September, but the event happened in August: it belongs to August.
    const p = recordFilePath({
      orgId: ORG,
      source: 'audit-trail',
      occurredAt: '2026-08-31T23:30:00.000Z',
      collectedAt: '2026-09-01T00:05:00.000Z',
      runId: '01K3QF8H2N0000000000000000',
    });
    expect(p).toContain('year=2026/month=08');
  });

  it('uses the first 8 characters of the run id in the filename', () => {
    const p = recordFilePath({
      orgId: ORG,
      source: 'audit-trail',
      occurredAt: '2026-08-14T02:11:09.000Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      runId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });
    expect(p.endsWith('part-20260815T090012Z-ABCDEFGH.ndjson')).toBe(true);
  });

  it('appends a part suffix when given, so two rounds of one run never share a file name', () => {
    const args = {
      orgId: ORG,
      source: 'audit-trail' as const,
      occurredAt: '2026-08-14T02:11:09.000Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      runId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    };
    const p = recordFilePath({ ...args, part: 'r02' });
    expect(p.endsWith('part-20260815T090012Z-ABCDEFGH-r02.ndjson')).toBe(true);
    expect(isRecordPath(p, ORG, 'audit-trail')).toBe(true);
    expect(recordFilePath({ ...args, part: undefined })).toBe(recordFilePath(args));
  });

  it('zero-pads the manifest sequence to eight digits so files sort lexically', () => {
    expect(manifestPath(ORG, 1)).toBe(
      'org_id=00D5j000000AbCdEAK/_chain/00000001.manifest.json',
    );
    expect(manifestPath(ORG, 42)).toBe(
      'org_id=00D5j000000AbCdEAK/_chain/00000042.manifest.json',
    );
  });

  it('places head and state under underscore-prefixed directories', () => {
    // The `_` prefix is what keeps a `**/*.ndjson` glob from picking them up.
    expect(headPath(ORG)).toBe('org_id=00D5j000000AbCdEAK/_chain/head.json');
    expect(statePath(ORG, 'audit-trail')).toBe(
      'org_id=00D5j000000AbCdEAK/_state/audit-trail.json',
    );
  });

  it('always uses forward slashes, whatever the platform', () => {
    expect(orgPrefix(ORG)).toBe('org_id=00D5j000000AbCdEAK');
    expect(manifestPath(ORG, 1)).not.toContain('\\');
  });

  it('rejects an org id that is not a plausible Salesforce id', () => {
    // A path segment built from unvalidated input is a traversal risk.
    expect(() => orgPrefix('../../etc')).toThrow(/invalid org id/i);
    expect(() => orgPrefix('00D5j000000AbCdE')).toThrow(/invalid org id/i);
  });

  it('rejects a sequence number that is not a positive integer', () => {
    expect(() => manifestPath(ORG, 0)).toThrow(/sequence/i);
    expect(() => manifestPath(ORG, -1)).toThrow(/sequence/i);
    expect(() => manifestPath(ORG, 1.5)).toThrow(/sequence/i);
  });

  it('isOrgId accepts exactly 18 alphanumerics', () => {
    expect(isOrgId(ORG)).toBe(true);
    expect(isOrgId(ORG.slice(0, 15))).toBe(false);
    expect(isOrgId('../x')).toBe(false);
    expect(isOrgId(`${ORG}/`)).toBe(false);
  });

  it('isRecordPath accepts what recordFilePath writes, for that org and source only', () => {
    const p = recordFilePath({
      orgId: ORG,
      source: 'audit-trail',
      occurredAt: '2026-08-14T02:11:09.000Z',
      collectedAt: '2026-08-15T09:00:12.482Z',
      runId: '01K3QF8H2N0000000000000000',
    });
    expect(isRecordPath(p, ORG, 'audit-trail')).toBe(true);
    expect(isRecordPath(p, '00D000000000002AAA', 'audit-trail')).toBe(false);
    expect(isRecordPath(p, ORG, 'limits')).toBe(false);
    const dir = `org_id=${ORG}/source=audit-trail/year=2026/month=08`;
    for (const bad of [
      `${dir}/../../../../x.ndjson`,
      `${dir}/..`,
      `${dir}/.hidden.ndjson`,
      `${dir}/part-x.json`,
      `${dir}/a\\b.ndjson`,
      `${dir}/sub/part-x.ndjson`,
      `/${dir}/part-x.ndjson`,
      `org_id=${ORG}/source=audit-trail/year=26/month=08/part-x.ndjson`,
      `org_id=${ORG}/source=audit-trail/year=2026/month=13/part-x.ndjson`,
      `org_id=${ORG}/_state/part-x.ndjson`,
    ]) {
      expect([bad, isRecordPath(bad, ORG, 'audit-trail')]).toEqual([bad, false]);
    }
  });

  it('parseOrgDir extracts an 18-char org id and rejects everything else', () => {
    expect(parseOrgDir(`org_id=${ORG}`)).toBe(ORG);
    expect(parseOrgDir('org_id=short')).toBeNull();
    expect(parseOrgDir(ORG)).toBeNull();
  });

  it('absoluteRecordPath joins with platform separators', () => {
    expect(absoluteRecordPath('/r', `org_id=${ORG}/source=x/f.ndjson`)).toBe(
      join('/r', `org_id=${ORG}`, 'source=x', 'f.ndjson'),
    );
  });
});
