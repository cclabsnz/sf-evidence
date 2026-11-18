import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSink, resolveQueryFiles, type QueryFiles } from '@cclabsnz/sf-evidence-engine';
import { FIXTURE, writeQueryFixture } from '@cclabsnz/sf-evidence-engine/testing/query';
import {
  QueryEngineUnavailable,
  loadDuckdb,
  openQuerySession,
  type QuerySession,
} from '../../../src/duckdb/session.js';
import { StatementRejected, guardStatement, type GuardPort } from '../../../src/duckdb/guard.js';

/**
 * The sandbox the security statement cites (design §5.4). Every rejection asserts both that the
 * statement failed and that it left nothing behind; every denied read asserts the target exists,
 * so a "file not found" can never pass for a refusal.
 */

/** Every path under `dir` with its size and mtime, so any write, touch or new file shows up. */
async function snapshot(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`;
    const s = await stat(join(dir, p));
    out.push(`${p}|${s.size}|${s.mtimeMs}`);
    if (e.isDirectory()) out.push(...(await snapshot(dir, p)));
  }
  return out.sort();
}

const FILE_ACCESS_DENIED = /file access|Permission Error|disabled by configuration/;

let root: string;
let tmp: string;
let files: QueryFiles;
let session: QuerySession | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sfe-query-sandbox-'));
  await writeQueryFixture(root);
  files = await resolveQueryFiles(new LocalSink(root), [FIXTURE.orgA, FIXTURE.orgB]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'sfe-query-out-'));
});

afterEach(async () => {
  session?.close();
  session = undefined;
  await rm(tmp, { recursive: true, force: true });
});

async function open(f: QueryFiles = files): Promise<QuerySession> {
  session = await openQuerySession({ files: f, timezone: 'Pacific/Auckland' });
  return session;
}

describe('DuckDB sandbox session', () => {
  it('opens and runs a trivial SELECT', async () => {
    const s = await open();
    const r = await s.run('SELECT 1 AS one');
    expect(r.columns).toEqual([{ name: 'one', type: 'INTEGER' }]);
    expect(r.rows).toEqual([{ one: 1 }]);
    expect(r.truncated).toBe(false);
    expect(await s.version()).toMatch(/^v\d+\.\d+\.\d+/);
  });

  describe('rejects', () => {
    const statements = (t: string): string[] => [
      `COPY (SELECT 1) TO '${t}/x.csv'`,
      `EXPORT DATABASE '${t}/x'`,
      `ATTACH ':memory:' AS y`,
      'INSTALL httpfs',
      'LOAD httpfs',
      'SET threads = 1',
      'PRAGMA version',
      'CREATE TABLE t AS SELECT 1',
      'INSERT INTO t VALUES (1)',
      `SELECT 1; COPY (SELECT 1) TO '${t}/y.csv'`,
      'SET lock_configuration = false',
    ];

    // Indexes, not the SQL, name the cases: the SQL embeds a per-test temp path.
    it.each(statements('<tmp>').map((sql, i) => [sql, i]))('%s', async (_label, i) => {
      const s = await open();
      const sql = statements(tmp)[i as number]!;
      await expect(s.run(sql)).rejects.toThrow();
      expect(existsSync(join(tmp, 'x.csv'))).toBe(false);
      expect(existsSync(join(tmp, 'x'))).toBe(false);
      expect(existsSync(join(tmp, 'y.csv'))).toBe(false);
      // Nothing it tried to create or attach is visible afterwards, and the lock still holds.
      const tables = await s.run("SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 't'");
      expect(Number(tables.rows[0]!.n)).toBe(0);
      const dbs = await s.run("SELECT count(*) AS n FROM duckdb_databases() WHERE database_name = 'y'");
      expect(Number(dbs.rows[0]!.n)).toBe(0);
      const lock = await s.run("SELECT current_setting('lock_configuration') AS v");
      expect(lock.rows[0]!.v).toBe(true);
    });

    it('rejects multiple statements, naming the count', async () => {
      const s = await open();
      await expect(s.run('SELECT 1; SELECT 2')).rejects.toThrow(StatementRejected);
      await expect(s.run('SELECT 1; SELECT 2')).rejects.toThrow(/exactly one statement/);
    });

    it('rejects non-SELECT statements by type, naming the type', async () => {
      const s = await open();
      await expect(s.run('CREATE TABLE t AS SELECT 1')).rejects.toThrow(StatementRejected);
      await expect(s.run('PRAGMA version')).rejects.toThrow(/only SELECT/);
      await expect(s.run('SET threads = 1')).rejects.toThrow(/only SELECT/);
    });

    it.each(['', '   \n\t', ';', '-- just a comment', '/* block */'])(
      'rejects empty or comment-only SQL %j',
      async (sql) => {
        const s = await open();
        await expect(s.run(sql)).rejects.toThrow(StatementRejected);
      },
    );

    it('rejects unparseable SQL with the parser message', async () => {
      const s = await open();
      await expect(s.run('SELEC 1')).rejects.toThrow(StatementRejected);
      await expect(s.run('SELEC 1')).rejects.toThrow(/Parser Error/);
    });
  });

  describe('rejects reads of non-allow-listed archive paths', () => {
    interface DeniedRead {
      /** The read, as the test name; `<root>` stands for the fixture archive root. */
      label: string;
      sql: () => string;
      /** The local file the read targets, asserted to exist; null for remote URLs and globs. */
      target: () => string | null;
    }
    const head = (): string => join(root, `org_id=${FIXTURE.orgA}`, '_chain', 'head.json');
    const orphan = (): string => join(root, FIXTURE.orphanRelPath);
    const reads: DeniedRead[] = [
      { label: "read_text('/etc/passwd')", sql: () => "SELECT * FROM read_text('/etc/passwd')", target: () => '/etc/passwd' },
      {
        label: "read_ndjson('https://example.com/x.ndjson')",
        sql: () => "SELECT * FROM read_ndjson('https://example.com/x.ndjson')",
        target: () => null,
      },
      { label: "read_csv('s3://bucket/x.csv')", sql: () => "SELECT * FROM read_csv('s3://bucket/x.csv')", target: () => null },
      { label: "read_ndjson('<root>/**/*.ndjson')", sql: () => `SELECT * FROM read_ndjson('${root}/**/*.ndjson')`, target: () => null },
      {
        label: "read_text('<root>/org_id=00D5j000000AbCdEAK/_chain/head.json')",
        sql: () => `SELECT * FROM read_text('${head()}')`,
        target: head,
      },
      { label: "read_ndjson('<orphan path>')", sql: () => `SELECT * FROM read_ndjson('${orphan()}')`, target: orphan },
    ];

    it.each(reads)('$label', async ({ sql, target }) => {
      const path = target();
      // The file is really there, so the failure below is the sandbox, not a missing file.
      if (path !== null) expect(existsSync(path)).toBe(true);
      const s = await open();
      const before = await snapshot(root);
      await expect(s.run(sql())).rejects.toThrow(FILE_ACCESS_DENIED);
      expect(await snapshot(root)).toEqual(before);
    });

    it('surfaces a denied file read as StatementRejected', async () => {
      const s = await open();
      await expect(s.run("SELECT * FROM read_text('/etc/passwd')")).rejects.toThrow(StatementRejected);
    });

    it('denies every file when the session has no files (empty allow-list means none, not all)', async () => {
      const s = await open({ bySource: {} as QueryFiles['bySource'], orphanCount: 0, orgLabels: {} });
      await expect(s.run("SELECT * FROM read_text('/etc/passwd')")).rejects.toThrow(FILE_ACCESS_DENIED);
      await expect(
        s.run(`SELECT * FROM read_ndjson('${files.bySource['audit-trail']![0]!}')`),
      ).rejects.toThrow(FILE_ACCESS_DENIED);
      // The views still exist, typed and empty.
      const r = await s.run('SELECT count(*) AS n FROM records');
      expect(Number(r.rows[0]!.n)).toBe(0);
    });
  });

  describe('extensions stay off', () => {
    let home: string;
    let savedHome: string | undefined;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'sfe-query-home-'));
      savedHome = process.env.HOME;
      process.env.HOME = home;
    });

    afterEach(async () => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await rm(home, { recursive: true, force: true });
    });

    it('has no httpfs or azure installed, and never touches ~/.duckdb', async () => {
      const s = await open();
      // The brief's `count(*) ... WHERE installed` cannot return 0 inside a locked session: listing
      // `installed` scans the extension directory, which the lockdown denies outright. That denial
      // is the stronger result (DuckDB cannot even look for an extension), so it is asserted here,
      // together with autoinstall/autoload being off and INSTALL/LOAD failing.
      await expect(
        s.run("SELECT count(*) AS n FROM duckdb_extensions() WHERE installed AND extension_name IN ('httpfs','azure')"),
      ).rejects.toThrow(FILE_ACCESS_DENIED);
      const settings = await s.run(
        "SELECT name, value FROM duckdb_settings() WHERE name IN ('autoinstall_known_extensions','autoload_known_extensions') ORDER BY name",
      );
      expect(settings.rows).toEqual([
        { name: 'autoinstall_known_extensions', value: 'false' },
        { name: 'autoload_known_extensions', value: 'false' },
      ]);
      await expect(s.run('INSTALL httpfs')).rejects.toThrow();
      await expect(s.run('LOAD httpfs')).rejects.toThrow();
      await s.run('SELECT count(*) FROM records');
      s.close();
      session = undefined;
      expect(await readdir(home)).toEqual([]);
    });

    it('points DuckDB home, extension and secret directories away from the user home', async () => {
      const s = await open();
      const r = await s.run(
        "SELECT name, value FROM duckdb_settings() WHERE name IN ('home_directory','extension_directory','secret_directory') ORDER BY name",
      );
      expect(r.rows).toHaveLength(3);
      for (const row of r.rows) {
        expect(String(row.value)).not.toBe('');
        expect(String(row.value).startsWith(home)).toBe(false);
        expect(existsSync(String(row.value))).toBe(false);
      }
    });
  });

  describe('accepts', () => {
    it('WITH x AS (SELECT 1 AS a) SELECT a FROM x', async () => {
      const s = await open();
      const r = await s.run('WITH x AS (SELECT 1 AS a) SELECT a FROM x');
      expect(r.rows).toEqual([{ a: 1 }]);
    });

    it('SELECT count(*) AS n FROM records over both orgs is 5 (orphan excluded)', async () => {
      const s = await open();
      const r = await s.run('SELECT count(*) AS n FROM records');
      expect(Number(r.rows[0]!.n)).toBe(5);
      const ids = await s.run('SELECT source_id FROM records');
      expect(ids.rows.map((row) => row.source_id)).not.toContain(FIXTURE.ids.orphan);
    });

    it('a JSON operator query over records', async () => {
      const s = await open();
      const r = await s.run(
        "SELECT payload->>'$.Action' AS action FROM records WHERE source_id = '" + FIXTURE.ids.a1 + "'",
      );
      expect(r.rows).toEqual([{ action: 'PermSetAssign' }]);
    });

    it('allow-lists exactly the chain-covered record files, and disables spilling', async () => {
      const s = await open();
      const r = await s.run(
        "SELECT current_setting('allowed_paths') AS paths, current_setting('allowed_directories') AS dirs, current_setting('temp_directory') AS tmp, current_setting('max_temp_directory_size') AS max",
      );
      // DuckDB stores the allow-list canonicalised (macOS tmp is a /private symlink).
      const expected = [...new Set(Object.values(files.bySource).flat())].map((p) => realpathSync(p)).sort();
      expect(expected.length).toBeGreaterThan(0);
      expect([...(r.rows[0]!.paths as string[])].sort()).toEqual(expected);
      expect(r.rows[0]!.dirs).toEqual([]);
      expect(r.rows[0]!.tmp).toBe('');
      expect(String(r.rows[0]!.max)).toMatch(/^0(\.0)? ?(bytes|B)$/i);
    });

    it('applies the requested TimeZone, which the lock then pins', async () => {
      const s = await open();
      const r = await s.run("SELECT current_setting('TimeZone') AS tz");
      expect(r.rows).toEqual([{ tz: 'Pacific/Auckland' }]);
    });
  });

  it('archive is byte-identical after a session', async () => {
    const before = await snapshot(root);
    const s = await open();
    await s.run('SELECT * FROM records');
    await s.run('SELECT count(*) FROM records').catch(() => undefined);
    await s.run(`COPY (SELECT 1) TO '${root}/leak.csv'`).catch(() => undefined);
    s.close();
    session = undefined;
    expect(await snapshot(root)).toEqual(before);
  });

  it('limit truncates', async () => {
    const s = await open();
    const r = await s.run('SELECT * FROM records', 2);
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
    const all = await s.run('SELECT * FROM records', 5);
    expect(all.rows).toHaveLength(5);
    expect(all.truncated).toBe(false);
  });
});

/**
 * SELECTs that are not read-only: DuckDB exposes engine controls as table functions, and after
 * `lock_configuration` they still run. `enable_logging(storage='file', ...)` left every later
 * query failing and made close() abort the process (libc++abi, exit 134) before the allowlist.
 */
describe('rejects side-effecting functions', () => {
  const logPath = (): string => join(tmp, 'duck.log');
  const cases: { label: string; sql: () => string }[] = [
    { label: "enable_logging(level='trace')", sql: () => "SELECT * FROM enable_logging(level='trace')" },
    { label: "enable_logging(storage='stdout')", sql: () => "SELECT * FROM enable_logging(storage='stdout')" },
    {
      label: "enable_logging(storage='file', storage_path=<tmp>)",
      sql: () => `SELECT * FROM enable_logging(storage='file', storage_path='${logPath()}')`,
    },
    { label: 'enable_profiling()', sql: () => 'SELECT * FROM enable_profiling()' },
    { label: 'disable_logging()', sql: () => 'SELECT * FROM disable_logging()' },
    { label: 'checkpoint()', sql: () => 'SELECT * FROM checkpoint()' },
    { label: "query('SELECT 1')", sql: () => "SELECT * FROM query('SELECT 1')" },
    { label: "query_table('records')", sql: () => "SELECT * FROM query_table('records')" },
    { label: 'main.ENABLE_LOGGING() (schema and case)', sql: () => 'SELECT * FROM main.ENABLE_LOGGING()' },
    { label: 'in a CTE', sql: () => 'WITH x AS (SELECT * FROM enable_logging()) SELECT * FROM x' },
    { label: 'in a subquery', sql: () => 'SELECT * FROM records WHERE 1 IN (SELECT 1 FROM enable_logging())' },
    { label: 'in a UNION branch', sql: () => 'SELECT 1 UNION ALL SELECT 1 FROM enable_logging()' },
    { label: 'in a join', sql: () => 'SELECT * FROM records JOIN enable_profiling() ON true' },
    { label: 'scalar write_log()', sql: () => "SELECT write_log('x')" },
    { label: 'scalar setseed()', sql: () => 'SELECT setseed(0.5)' },
  ];

  it.each(cases)('$label', async ({ sql }) => {
    const s = await open();
    const err = await s.run(sql()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatementRejected);
    expect((err as Error).message).toMatch(/\(\) (is not allowed; only read-only table functions|changes engine state; only read-only functions)/);
    // Nothing changed: no log file, logging and profiling still off, and the session still answers.
    expect(existsSync(logPath())).toBe(false);
    const settings = await s.run(
      "SELECT name, value FROM duckdb_settings() WHERE name IN ('enable_logging','enable_profiling','logging_storage') ORDER BY name",
    );
    expect(settings.rows).toHaveLength(3);
    for (const row of settings.rows) {
      if (row.name === 'enable_logging') expect(String(row.value)).toMatch(/^(false|0)$/);
      if (row.name === 'enable_profiling') expect(row.value).toBeNull();
      if (row.name === 'logging_storage') expect(String(row.value)).toBe('memory');
    }
    expect(Number((await s.run('SELECT count(*) AS n FROM records')).rows[0]!.n)).toBe(5);
    s.close();
    session = undefined;
    // Reaching this line means close() returned and the process is alive.
    expect(true).toBe(true);
  });

  it('names the refused function', async () => {
    const s = await open();
    await expect(s.run('SELECT * FROM enable_profiling()')).rejects.toThrow(/table function enable_profiling\(\) is not allowed/);
  });

  it.each([
    ['range(3)', 'SELECT * FROM range(3)', 3],
    ['unnest([1,2])', 'SELECT * FROM unnest([1,2])', 2],
    ['generate_series in a CTE', 'WITH g AS (SELECT * FROM generate_series(1, 4)) SELECT * FROM g', 4],
  ] as const)('accepts %s', async (_label, sql, n) => {
    const s = await open();
    expect((await s.run(sql)).rows).toHaveLength(n);
  });

  it('accepts the duckdb_settings() catalog function', async () => {
    const s = await open();
    const r = await s.run("SELECT value FROM duckdb_settings() WHERE name = 'TimeZone'");
    expect(r.rows).toEqual([{ value: 'Pacific/Auckland' }]);
  });

  it('accepts DESCRIBE, which parses over a show ref, not a table function', async () => {
    const s = await open();
    expect((await s.run('DESCRIBE records')).rows.length).toBeGreaterThan(0);
  });
});

describe('session hygiene', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects limit %p with a TypeError', async (limit) => {
    const s = await open();
    await expect(s.run('SELECT 1', limit)).rejects.toThrow(TypeError);
  });

  it('accepts limit 0 and reports truncation', async () => {
    const s = await open();
    const r = await s.run('SELECT * FROM records', 0);
    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  it('close() is idempotent', async () => {
    const s = await open();
    s.close();
    expect(() => s.close()).not.toThrow();
    session = undefined;
  });
});


/**
 * Each guard layer on its own, through a fake port: against real DuckDB the parse check refuses
 * every listed statement first, so without these the count and prepared-type layers would be
 * untested defence in depth.
 */
describe('guardStatement layers', () => {
  function port(o: { count?: number; parses?: boolean; type?: number; prepareError?: Error }): GuardPort<{ t: number }> & { prepared: number; destroyed: number } {
    const p = {
      prepared: 0,
      destroyed: 0,
      extract: async () => ({
        count: o.count ?? 1,
        prepare: async () => {
          p.prepared += 1;
          if (o.prepareError) throw o.prepareError;
          return { t: o.type ?? 1 };
        },
      }),
      serialize: async () => ((o.parses ?? true) ? '{"error":false,"statements":[{}]}' : '{"error":true}'),
      statementType: (x: { t: number }) => x.t,
      destroy: () => {
        p.destroyed += 1;
      },
    };
    return p;
  }

  it('refuses a prepared statement whose type is not SELECT even when the parse check passed', async () => {
    const p = port({ type: 7 });
    await expect(guardStatement('SELECT 1', p)).rejects.toThrow(/only SELECT.*statement type 7/);
    expect(p.destroyed).toBe(1);
  });

  it('refuses more than one statement without preparing any', async () => {
    const p = port({ count: 2 });
    await expect(guardStatement('SELECT 1', p)).rejects.toThrow(/exactly one statement/);
    expect(p.prepared).toBe(0);
  });

  it('refuses a non-SELECT parse without preparing it', async () => {
    const p = port({ parses: false });
    await expect(guardStatement('SELECT 1', p)).rejects.toThrow(/only SELECT/);
    expect(p.prepared).toBe(0);
  });

  it('turns a Permission Error at prepare into a file-access rejection, and passes other errors through', async () => {
    await expect(
      guardStatement('SELECT 1', port({ prepareError: new Error('Permission Error: Cannot access file "/x"') })),
    ).rejects.toThrow(/file access/);
    const binder = new Error('Binder Error: no such column');
    await expect(guardStatement('SELECT 1', port({ prepareError: binder }))).rejects.toBe(binder);
    // Anchored: a message merely mentioning the phrase is not a file-access denial.
    const other = new Error('Binder Error: column "Permission Error" not found');
    await expect(guardStatement('SELECT 1', port({ prepareError: other }))).rejects.toBe(other);
  });

  it('returns the prepared statement for one SELECT', async () => {
    await expect(guardStatement('SELECT 1', port({}))).resolves.toEqual({ t: 1 });
  });
});

describe('loadDuckdb', () => {
  it('wraps a load failure in QueryEngineUnavailable with the underlying message', async () => {
    const err = await loadDuckdb(() => Promise.reject(new Error('dlopen failed: no such binary'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryEngineUnavailable);
    expect((err as Error).message).toMatch(/dlopen failed: no such binary/);
  });

  it('loads the real module by default', async () => {
    const m = await loadDuckdb();
    expect(typeof m.DuckDBInstance.create).toBe('function');
  });
});
