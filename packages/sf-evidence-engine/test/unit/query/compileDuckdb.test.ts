import { compileDuckdbViews } from '../../../src/query/compileDuckdb.js';
import { VIEWS } from '../../../src/query/views.js';
import type { QueryFiles } from '../../../src/archive/queryFiles.js';
import type { SourceId } from '../../../src/types/record.js';

const ORG_A = '00D5j000000AbCdEAK';
const ORG_B = '00D000000000002AAA';
const AUDIT = `/arch/org_id=${ORG_A}/source=audit-trail/year=2026/month=08/part-1.ndjson`;
const LIMITS = `/arch/org_id=${ORG_A}/source=limits/year=2026/month=11/part-2.ndjson`;

function files(bySource: Partial<Record<SourceId, string[]>>, orgLabels: Record<string, string | null> = {}): QueryFiles {
  return { bySource: bySource as Record<SourceId, string[]>, orphanCount: 0, orgLabels };
}

function stmt(sqls: string[], name: string): string {
  const s = sqls.find((x) => x.startsWith(`CREATE VIEW ${name} AS`));
  if (!s) throw new Error(`no statement for ${name}`);
  return s;
}

describe('compileDuckdbViews', () => {
  const full = files({ 'audit-trail': [AUDIT], limits: [LIMITS] }, { [ORG_A]: 'Fixture Prod', [ORG_B]: null });

  it('emits one CREATE VIEW per view, in VIEWS order', () => {
    const sqls = compileDuckdbViews({ files: full, timezone: 'UTC' });
    expect(sqls).toHaveLength(VIEWS.length);
    expect(sqls.map((s) => s.split(' ')[2])).toEqual(VIEWS.map((v) => v.name));
  });

  it('reads the explicit file list with pinned hive types and explicit columns, payload as JSON', () => {
    const s = stmt(compileDuckdbViews({ files: full, timezone: 'UTC' }), 'setup_changes');
    expect(s).toContain(`read_ndjson(['${AUDIT}']`);
    expect(s).toContain('hive_partitioning = true');
    expect(s).toContain("hive_types = {'org_id': 'VARCHAR', 'source': 'VARCHAR', 'year': 'INTEGER', 'month': 'INTEGER'}");
    expect(s).toMatch(/columns = \{[^}]*'payload': 'JSON'[^}]*\}/);
    // org_id and source come from the hive partition, never from the record's own copies.
    expect(s).not.toMatch(/columns = \{[^}]*'org_id'/);
    expect(s).not.toMatch(/columns = \{[^}]*'source':/);
    // No `SELECT *`: a `k=v` segment in the archive root path would add a hive column.
    expect(s).not.toMatch(/SELECT \*|\.\*/);
    expect(s).not.toContain(LIMITS);
  });

  it('records reads every source file; each view reads only its own sources', () => {
    const sqls = compileDuckdbViews({ files: full, timezone: 'UTC' });
    expect(stmt(sqls, 'records')).toContain(`read_ndjson(['${AUDIT}', '${LIMITS}']`);
    expect(stmt(sqls, 'limit_samples')).toContain(`read_ndjson(['${LIMITS}']`);
    expect(stmt(sqls, 'limit_samples')).not.toContain(AUDIT);
  });

  it('casts every column to its declared type', () => {
    const sqls = compileDuckdbViews({ files: full, timezone: 'UTC' });
    for (const v of VIEWS) {
      const s = stmt(sqls, v.name);
      for (const c of v.columns) expect(s).toContain(`CAST(${c.expr.duckdb} AS ${c.type}) AS ${c.name}`);
    }
  });

  it('unnests limits by json_keys and extracts each value by JSON pointer', () => {
    const s = stmt(compileDuckdbViews({ files: full, timezone: 'UTC' }), 'limit_samples');
    expect(s).toContain("unnest(json_keys(payload->'limits'))");
    expect(s).toContain("json_extract(payload->'limits', '/' || replace(replace(limit_name, '~', '~0'), '/', '~1'))");
  });

  it('inlines org labels as a VALUES left join, sorted by org id, NULL labels typed', () => {
    const s = stmt(compileDuckdbViews({ files: full, timezone: 'UTC' }), 'records');
    expect(s).toContain(`LEFT JOIN (VALUES ('${ORG_B}', CAST(NULL AS VARCHAR)), ('${ORG_A}', CAST('Fixture Prod' AS VARCHAR))) AS org_labels(org_id, org_label) USING (org_id)`);
  });

  it('falls back to a typed empty label relation when there are no org labels', () => {
    const s = stmt(compileDuckdbViews({ files: files({ 'audit-trail': [AUDIT] }), timezone: 'UTC' }), 'records');
    expect(s).not.toContain('VALUES');
    expect(s).toContain('LEFT JOIN (SELECT CAST(NULL AS VARCHAR) AS org_id, CAST(NULL AS VARCHAR) AS org_label WHERE false) AS org_labels');
  });

  it.each([
    ['an empty list', { 'audit-trail': [AUDIT], limits: [] }],
    ['a missing key', { 'audit-trail': [AUDIT] }],
  ])('compiles an empty-source view from a typed empty SELECT (%s)', (_label, bySource) => {
    const s = stmt(compileDuckdbViews({ files: files(bySource, { [ORG_A]: 'P' }), timezone: 'UTC' }), 'limit_samples');
    expect(s).not.toContain('read_ndjson');
    const def = VIEWS.find((v) => v.name === 'limit_samples')!;
    const items = def.columns.map((c) => `CAST(NULL AS ${c.type}) AS ${c.name}`).join(', ');
    expect(s).toBe(`CREATE VIEW limit_samples AS SELECT ${items} WHERE false`);
  });

  it('compiles records empty when the archive holds no files at all', () => {
    const s = stmt(compileDuckdbViews({ files: files({}), timezone: 'UTC' }), 'records');
    expect(s).not.toContain('read_ndjson');
    expect(s).toMatch(/WHERE false$/);
  });

  it('escapes file paths and org labels as SQL string literals', () => {
    const odd = "/arch/o'brien/org_id=00D5j000000AbCdEAK/source=audit-trail/year=2026/month=08/p.ndjson";
    const s = stmt(
      compileDuckdbViews({ files: files({ 'audit-trail': [odd] }, { [ORG_A]: "Jo's Org" }), timezone: 'UTC' }),
      'setup_changes',
    );
    expect(s).toContain("'/arch/o''brien/org_id=");
    expect(s).toContain("CAST('Jo''s Org' AS VARCHAR)");
    expect(s).not.toContain("o'brien");
    expect(s).not.toContain("Jo's");
  });

  it('does not emit the timezone into SQL: *_local is a TIMESTAMPTZ the session zone renders', () => {
    const sqls = compileDuckdbViews({ files: full, timezone: 'Pacific/Auckland' });
    for (const s of sqls) expect(s).not.toContain('Pacific/Auckland');
  });
});
