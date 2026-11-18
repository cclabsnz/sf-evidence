import { VIEWS, type ViewDefinition } from '../../../src/query/views.js';

function view(name: ViewDefinition['name']): ViewDefinition {
  const v = VIEWS.find((x) => x.name === name);
  if (!v) throw new Error(`no view ${name}`);
  return v;
}

/**
 * Rewrites every DuckDB payload accessor form (`payload->>'X'`, `payload->'X'`,
 * `json_extract_string(payload, '$.X')`) to `payload.X`, so a test can pin an expression's
 * logic without pinning its accessor syntax.
 */
function normaliseAccessors(expr: string): string {
  return expr
    .replace(/json_extract(?:_string)?\(\s*payload\s*,\s*'\$\.(\w+)'\s*\)/g, 'payload.$1')
    .replace(/payload\s*->>?\s*'(?:\$\.)?(\w+)'/g, 'payload.$1')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('VIEWS', () => {
  it('defines records, setup_changes and limit_samples, version 1', () => {
    expect(VIEWS.map((v) => v.name)).toEqual(['records', 'setup_changes', 'limit_samples']);
    for (const v of VIEWS) expect(v.version).toBe(1);
  });

  it('every column has a description and a duckdb expression', () => {
    for (const v of VIEWS) {
      expect(v.description.trim()).not.toBe('');
      expect(v.grain.trim()).not.toBe('');
      for (const c of v.columns) {
        expect(c.description.trim()).not.toBe('');
        expect(c.expr.duckdb?.trim()).toBeTruthy();
      }
    }
  });

  it('timeColumn names a column of the view', () => {
    expect(view('records').timeColumn).toBe('occurred_at_utc');
    expect(view('setup_changes').timeColumn).toBe('occurred_at_utc');
    expect(view('limit_samples').timeColumn).toBe('sampled_at_utc');
    for (const v of VIEWS) {
      const col = v.columns.find((c) => c.name === v.timeColumn);
      expect(col?.type).toBe('TIMESTAMP');
    }
  });

  it('column names are unique snake_case', () => {
    for (const v of VIEWS) {
      const names = v.columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it('has exactly the design 5.5 column sets, with org_id and org_label in every view', () => {
    const names = (n: ViewDefinition['name']): string[] => view(n).columns.map((c) => c.name).sort();
    expect(names('records')).toEqual(
      ['api_version', 'collected_at_utc', 'month', 'occurred_at_utc', 'org_id', 'org_label', 'payload',
        'schema', 'source', 'source_id', 'year'].sort(),
    );
    expect(names('setup_changes')).toEqual(
      ['action', 'collected_at_utc', 'created_by_context', 'display', 'occurred_at_local', 'occurred_at_utc',
        'org_id', 'org_label', 'performed_by', 'performed_by_id', 'recorded_as', 'recorded_as_id',
        'recorded_as_name', 'section', 'source_id', 'via_login_as'].sort(),
    );
    expect(names('limit_samples')).toEqual(
      ['hour_utc', 'limit_name', 'max', 'org_id', 'org_label', 'pct_used', 'remaining', 'sampled_at_local',
        'sampled_at_utc', 'used'].sort(),
    );
  });

  it('types *_utc as TIMESTAMP and *_local as TIMESTAMPTZ', () => {
    for (const v of VIEWS) {
      for (const c of v.columns) {
        if (c.name.endsWith('_utc')) expect(c.type).toBe('TIMESTAMP');
        if (c.name.endsWith('_local')) expect(c.type).toBe('TIMESTAMPTZ');
      }
    }
  });

  it('reads sources: every source for records, audit-trail and limits for the flattened views', () => {
    expect([...view('records').sources].sort()).toEqual(['audit-trail', 'limits', 'login-history']);
    expect(view('setup_changes').sources).toEqual(['audit-trail']);
    expect(view('limit_samples').sources).toEqual(['limits']);
  });

  it('performed_by_id never references CreatedById outside a non-Login-As branch', () => {
    const expr = view('setup_changes').columns.find((c) => c.name === 'performed_by_id')?.expr.duckdb ?? '';
    expect(normaliseAccessors(expr)).toBe('CASE WHEN payload.DelegateUser IS NULL THEN payload.CreatedById END');
    expect(expr.match(/CreatedById/g)).toHaveLength(1);
  });

  it('performed_by takes DelegateUser when via Login-As, else CreatedByUsername', () => {
    const cols = view('setup_changes').columns;
    const expr = (n: string): string => normaliseAccessors(cols.find((c) => c.name === n)?.expr.duckdb ?? '');
    expect(expr('via_login_as')).toBe('payload.DelegateUser IS NOT NULL');
    expect(expr('performed_by')).toBe(
      'CASE WHEN payload.DelegateUser IS NOT NULL THEN payload.DelegateUser ELSE payload.CreatedByUsername END',
    );
    expect(expr('recorded_as_id')).toBe('payload.CreatedById');
  });

  it('lists the known gaps the dictionary must state', () => {
    expect(view('limit_samples').knownGaps.join(' ')).toMatch(/sub-limit/i);
    const sc = view('setup_changes').knownGaps.join(' ');
    expect(sc).toMatch(/username/i);
    expect(sc).toMatch(/performed_by_id/);
    expect(sc).toMatch(/Login-As/);
  });

  it('limit_samples declares each column before any column whose expression names it', () => {
    // DuckDB resolves select-list aliases left to right, so used and pct_used can only name
    // max, remaining and used if those come first.
    const order = view('limit_samples').columns.map((c) => c.name);
    expect(order.indexOf('max')).toBeLessThan(order.indexOf('used'));
    expect(order.indexOf('remaining')).toBeLessThan(order.indexOf('used'));
    expect(order.indexOf('used')).toBeLessThan(order.indexOf('pct_used'));
  });

  it('pct_used is NULL when max is 0 or NULL', () => {
    const expr = view('limit_samples').columns.find((c) => c.name === 'pct_used')?.expr.duckdb ?? '';
    expect(expr.replace(/\s+/g, ' ')).toBe('CASE WHEN max IS NULL OR max = 0 THEN NULL ELSE 100.0 * used / max END');
  });
});
