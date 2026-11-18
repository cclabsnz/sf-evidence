import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@oclif/core';
import { EXIT } from '@cclabsnz/sf-evidence-engine';
import { FIXTURE, writeQueryFixture } from '@cclabsnz/sf-evidence-engine/testing/query';
import EvidenceQuery, { type QueryCommandResult } from '../../../src/commands/evidence/query.js';
import { QueryEngineUnavailable } from '../../../src/duckdb/session.js';

/**
 * `sf evidence query` end to end over the fixture archive: flag parsing, org selection, the
 * session, the formatter and every exit code.
 *
 * Commands run through `_run()`, not `run()`, so a thrown error goes through `SfCommand.catch`
 * and the exit code asserted is the one the process would really get (a stray TypeError, for
 * example, becomes exit 10 there, not 1). The chalk stub (`jest.config.ts`) and
 * `Config.load({ userPlugins: false, devPlugins: false })` are the harness from
 * `packages/sf-evidence/test/unit/commands/commands.test.ts`. `this.table` writes past
 * `this.log` to stdout, which is one reason the table renderer is our own.
 */

/** Every path under `dir` with its size, mtime and content hash, so any write or touch shows up. */
async function snapshot(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`;
    const s = await stat(join(dir, p));
    const hash = e.isFile() ? createHash('sha256').update(await readFile(join(dir, p))).digest('hex') : 'dir';
    out.push(`${p}|${s.size}|${s.mtimeMs}|${hash}`);
    if (e.isDirectory()) out.push(...(await snapshot(dir, p)));
  }
  return out.sort();
}

const ORPHAN_WARNING =
  '1 record file(s) in the archive are not covered by the hash chain and were excluded. Run sf evidence verify.';

describe('sf evidence query', () => {
  let config: Config;
  let root: string;
  let logged: string[];
  let warned: string[];
  let errors: string[];
  let json: unknown[];
  /** SfCommand.init adds SIGINT/SIGTERM/... handlers per instance; dropped after each test. */
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;
  let listeners: Map<string, Function[]>;

  beforeAll(async () => {
    config = await Config.load({ root: process.cwd(), userPlugins: false, devPlugins: false });
    root = await mkdtemp(join(tmpdir(), 'sfe-query-cmd-'));
    await writeQueryFixture(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    logged = [];
    warned = [];
    errors = [];
    json = [];
    listeners = new Map(SIGNALS.map((s) => [s, process.listeners(s)]));
    delete process.exitCode;
  });

  afterEach(() => {
    delete process.exitCode;
    for (const s of SIGNALS) {
      for (const l of process.listeners(s)) if (!listeners.get(s)!.includes(l)) process.off(s, l as () => void);
    }
  });

  function capture(cmd: EvidenceQuery): EvidenceQuery {
    const c = cmd as unknown as Record<string, unknown>;
    c.log = (m = ''): void => {
      logged.push(m as string);
    };
    // Wrapped, not replaced: SfCommand.warn is what puts the warning into the --json envelope.
    const warn = (c.warn as (m: string) => string).bind(cmd);
    c.warn = (m: string): string => {
      warned.push(m);
      return warn(m);
    };
    c.logToStderr = (m = ''): void => {
      errors.push(m as string);
    };
    c.logJson = (j: unknown): void => {
      json.push(j);
    };
    return cmd;
  }

  interface Outcome {
    result: QueryCommandResult | undefined;
    error: Error | undefined;
    exit: number;
  }

  async function query(argv: string[], setup?: (cmd: EvidenceQuery) => void, archive = root): Promise<Outcome> {
    const cmd = capture(new EvidenceQuery([...argv, '--archive', archive], config));
    setup?.(cmd);
    let result: QueryCommandResult | undefined;
    let error: Error | undefined;
    try {
      result = (await (cmd as unknown as { _run(): Promise<QueryCommandResult> })._run()) as QueryCommandResult;
    } catch (err) {
      error = err as Error;
    }
    const exit = typeof process.exitCode === 'number' ? process.exitCode : 0;
    return { result, error, exit };
  }

  const orgA = ['--org-id', FIXTURE.orgA];
  const out = (): string => logged.join('\n');

  it('--view setup_changes --format json gives org A rows ordered by occurred_at_utc, with the orphan warning', async () => {
    const { result, exit } = await query([...orgA, '--view', 'setup_changes', '--format', 'json']);

    expect(exit).toBe(EXIT.OK);
    expect(result!.rows.map((r) => r.source_id)).toEqual([FIXTURE.ids.a1, FIXTURE.ids.a2, FIXTURE.ids.a3]);
    expect(result!.rowCount).toBe(3);
    expect(result!.truncated).toBe(false);
    expect(result!.warnings).toContain(ORPHAN_WARNING);
    expect(warned).toContain(ORPHAN_WARNING);
    expect(result!.columns.find((c) => c.name === 'occurred_at_utc')?.type).toBe('TIMESTAMP');
    const printed = JSON.parse(out()) as Record<string, unknown>[];
    expect(printed.map((r) => r.source_id)).toEqual([FIXTURE.ids.a1, FIXTURE.ids.a2, FIXTURE.ids.a3]);
    expect(printed[0]!.occurred_at_utc).toBe('2026-08-14T02:11:09Z');
  });

  it('--json keeps the result and carries the orphan warning in the envelope', async () => {
    const { exit } = await query([...orgA, '--view', 'setup_changes', '--json']);
    expect(exit).toBe(EXIT.OK);
    expect(json).toHaveLength(1);
    const envelope = json[0] as { status: number; result: QueryCommandResult; warnings: string[] };
    expect(envelope.status).toBe(0);
    expect(envelope.result.rowCount).toBe(3);
    expect(envelope.result.warnings).toEqual([ORPHAN_WARNING]);
    expect(envelope.warnings).toContain(ORPHAN_WARNING);
    expect(logged).toEqual([]);
  });

  it('--json reports a failure as exit 1 in the error envelope', async () => {
    const { exit } = await query([...orgA, '--sql', 'SELECT nope FROM records', '--json']);
    expect(exit).toBe(EXIT.ERROR);
    expect((json[0] as { status: number; message: string }).status).toBe(EXIT.ERROR);
    expect((json[0] as { message: string }).message).toMatch(/Binder Error/);
  });

  describe('view date bounds are UTC and half-open', () => {
    const ids = (r: QueryCommandResult | undefined): unknown[] => r!.rows.map((row) => row.source_id);

    it('--from 2026-08-14 --to 2026-08-15 gives exactly the 14 August row', async () => {
      const { result, exit } = await query([...orgA, '--view', 'setup_changes', '--from', '2026-08-14', '--to', '2026-08-15']);
      expect(exit).toBe(EXIT.OK);
      expect(ids(result)).toEqual([FIXTURE.ids.a1]);
    });

    it('--to 2026-08-14 excludes it', async () => {
      const { result, exit } = await query([...orgA, '--view', 'setup_changes', '--to', '2026-08-14']);
      expect(exit).toBe(EXIT.OK);
      expect(ids(result)).not.toContain(FIXTURE.ids.a1);
    });

    it('an offset timestamp is converted to UTC, and --from is inclusive to the second', async () => {
      // 2026-08-14T14:11:09+12:00 is exactly a1's 02:11:09Z.
      const at = await query([...orgA, '--view', 'setup_changes', '--from', '2026-08-14T14:11:09+12:00', '--to', '2026-08-15']);
      expect(ids(at.result)).toEqual([FIXTURE.ids.a1]);
      const after = await query([...orgA, '--view', 'setup_changes', '--from', '2026-08-14T02:11:09.001Z', '--to', '2026-08-15']);
      expect(ids(after.result)).toEqual([]);
    });

    it('rejects a date that does not exist rather than rolling it over', async () => {
      const { exit, error } = await query([...orgA, '--view', 'setup_changes', '--from', '2026-02-30']);
      expect(exit).toBe(EXIT.USAGE);
      expect(error!.message).toMatch(/--from/);
    });

    it('rejects a timestamp without a zone', async () => {
      const { exit } = await query([...orgA, '--view', 'setup_changes', '--from', '2026-08-14T02:00:00']);
      expect(exit).toBe(EXIT.USAGE);
    });
  });

  it('--format csv prints an RFC 4180 header and rows', async () => {
    const { exit } = await query([
      ...orgA,
      '--sql',
      'SELECT action, count(*) AS n FROM setup_changes GROUP BY 1 ORDER BY 1',
      '--format',
      'csv',
    ]);
    expect(exit).toBe(EXIT.OK);
    expect(logged).toEqual(['action,n', 'PermSetAssign,1', 'changedprofileforuser,1', 'value_MAX_STREAMING_TOPICS_PROV,1']);
  });

  it('csv quotes fields holding a comma, a quote or a newline, and leaves NULL empty', async () => {
    const { exit } = await query([
      ...orgA,
      '--sql',
      `SELECT 'a,b' AS c1, 'say "hi"' AS c2, E'two\\nlines' AS c3, NULL AS c4, 'plain' AS c5`,
      '--format',
      'csv',
    ]);
    expect(exit).toBe(EXIT.OK);
    expect(out()).toBe('c1,c2,c3,c4,c5\n"a,b","say ""hi""","two\nlines",,plain');
  });

  it('serialises bigint results', async () => {
    const { exit } = await query([
      ...orgA,
      '--sql',
      'SELECT 9007199254740993::BIGINT AS big, 2::BIGINT AS small',
      '--format',
      'ndjson',
    ]);
    expect(exit).toBe(EXIT.OK);
    expect(logged).toEqual(['{"big":"9007199254740993","small":2}']);
  });

  it('converts DECIMAL only when the number round-trips, and integers inside lists', async () => {
    const { result } = await query([
      ...orgA,
      '--sql',
      'SELECT 1.50::DECIMAL(5,2) AS d, 12345678901234567.89::DECIMAL(38,2) AS wide, [1, 9007199254740993]::BIGINT[] AS l, 1::HUGEINT AS h',
    ]);
    expect(result!.rows).toEqual([{ d: 1.5, wide: '12345678901234567.89', l: [1, '9007199254740993'], h: 1 }]);
  });

  it('--file reads the SQL from a file', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sfe-query-sql-')), 'q.sql');
    await writeFile(file, 'SELECT source_id FROM setup_changes ORDER BY occurred_at_utc LIMIT 1\n');
    try {
      const { result, exit } = await query([...orgA, '--file', file, '--format', 'json']);
      expect(exit).toBe(EXIT.OK);
      expect(result!.rows).toEqual([{ source_id: FIXTURE.ids.a1 }]);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('--all-orgs reads every org in the archive', async () => {
    const { result } = await query(['--all-orgs', '--view', 'setup_changes', '--format', 'json']);
    expect(result!.rows.map((r) => r.source_id)).toEqual([FIXTURE.ids.a1, FIXTURE.ids.b1, FIXTURE.ids.a2, FIXTURE.ids.a3]);
  });

  it('zero rows exits 0', async () => {
    const { result, exit } = await query([...orgA, '--sql', 'SELECT * FROM setup_changes WHERE false', '--format', 'csv']);
    expect(exit).toBe(EXIT.OK);
    expect(result!.rowCount).toBe(0);
    expect(result!.rows).toEqual([]);
    // A header still prints, so a consumer can tell "no rows" from "no output".
    expect(logged[0]).toMatch(/^occurred_at_utc,/);
  });

  it('rejected SQL exits 1, and the message names the reason', async () => {
    const { exit, error } = await query([...orgA, '--sql', "COPY (SELECT 1) TO '/tmp/sfe-x.csv'"]);
    expect(exit).toBe(EXIT.ERROR);
    expect(error!.message).toMatch(/only SELECT statements/);
  });

  it('SQL error exits 1', async () => {
    const { exit, error } = await query([...orgA, '--sql', 'SELECT nope FROM records']);
    expect(exit).toBe(EXIT.ERROR);
    expect(error!.message).toMatch(/Binder Error.*nope/);
  });

  describe('usage errors exit 2', () => {
    it('no --sql, --file or --view', async () => {
      expect((await query([...orgA])).exit).toBe(EXIT.USAGE);
    });

    it('two of --sql, --file and --view', async () => {
      expect((await query([...orgA, '--sql', 'SELECT 1', '--view', 'records'])).exit).toBe(EXIT.USAGE);
    });

    it('both --org-id and --all-orgs', async () => {
      expect((await query([...orgA, '--all-orgs', '--sql', 'SELECT 1'])).exit).toBe(EXIT.USAGE);
    });

    it('neither --org-id nor --all-orgs', async () => {
      expect((await query(['--sql', 'SELECT 1'])).exit).toBe(EXIT.USAGE);
    });

    it('--from without --view', async () => {
      expect((await query([...orgA, '--sql', 'SELECT 1', '--from', '2026-08-14'])).exit).toBe(EXIT.USAGE);
    });

    it('--timezone Mars/Olympus', async () => {
      const { exit, error } = await query([...orgA, '--sql', 'SELECT 1', '--timezone', 'Mars/Olympus']);
      expect(exit).toBe(EXIT.USAGE);
      expect(error!.message).toMatch(/Mars\/Olympus/);
    });

    it('an unknown view', async () => {
      expect((await query([...orgA, '--view', 'nope'])).exit).toBe(EXIT.USAGE);
    });

    it('a negative --limit', async () => {
      expect((await query([...orgA, '--sql', 'SELECT 1', '--limit', '-1'])).exit).toBe(EXIT.USAGE);
    });

    it('a 15-character --org-id', async () => {
      const { exit, error } = await query(['--org-id', '00D5j000000AbCd', '--sql', 'SELECT 1']);
      expect(exit).toBe(EXIT.USAGE);
      expect(error!.message).toMatch(/--org-id.*18/);
    });

    it('an --org-id that is a path', async () => {
      expect((await query(['--org-id', '../x', '--sql', 'SELECT 1'])).exit).toBe(EXIT.USAGE);
    });
  });

  it('engine load failure exits 1', async () => {
    const { exit, error } = await query([...orgA, '--sql', 'SELECT 1'], (cmd) => {
      jest
        .spyOn(cmd as unknown as { engineLoader: () => unknown }, 'engineLoader')
        .mockReturnValue(() => Promise.reject(new QueryEngineUnavailable('boom')));
    });
    expect(exit).toBe(EXIT.ERROR);
    expect(error!.message.startsWith('Query engine could not load: boom')).toBe(true);
    expect(error!.message).toContain('sf plugins install @cclabsnz/sf-evidence-query');
  });

  it('table default caps at 100 rows', async () => {
    const { result, exit } = await query([...orgA, '--sql', 'SELECT range AS i FROM range(150)']);
    expect(exit).toBe(EXIT.OK);
    // header + rule + 100 rows + footer
    expect(logged).toHaveLength(103);
    expect(logged[2]!.trim()).toBe('0');
    expect(logged[101]!.trim()).toBe('99');
    expect(logged.at(-1)).toBe('… 50 more rows. Use --limit or --format csv.');
    // The cap is a display limit: the result (what --json emits) keeps every row.
    expect(result!.rowCount).toBe(150);
    expect(result!.truncated).toBe(false);
  });

  it('--limit applies to every format and marks the result truncated', async () => {
    const { result } = await query([...orgA, '--sql', 'SELECT range AS i FROM range(150)', '--format', 'ndjson', '--limit', '5']);
    expect(logged).toEqual(['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}', '{"i":4}']);
    expect(result!.rowCount).toBe(5);
    expect(result!.truncated).toBe(true);
  });

  /** A fresh archive root per test, for cases that change the archive or its permissions. */
  async function scratchArchive(fixture: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sfe-query-scratch-'));
    if (fixture) await writeQueryFixture(dir);
    return dir;
  }

  (process.getuid?.() === 0 ? it.skip : it)('reads a read-only archive root', async () => {
    // root ignores permission bits, hence the skip.
    const ro = await scratchArchive(true);
    await chmod(ro, 0o555);
    try {
      const { result, exit, error } = await query([...orgA, '--view', 'setup_changes', '--format', 'json'], undefined, ro);
      expect(error?.message).toBeUndefined();
      expect(exit).toBe(EXIT.OK);
      expect(result!.rowCount).toBe(3);
    } finally {
      await chmod(ro, 0o755);
      await rm(ro, { recursive: true, force: true });
    }
  });

  it('archive is byte-identical after the command', async () => {
    const before = await snapshot(root);
    await query([...orgA, '--view', 'setup_changes']);
    await query(['--all-orgs', '--sql', 'SELECT count(*) FROM records']);
    await query([...orgA, '--sql', "COPY (SELECT 1) TO 'x.csv'"]);
    expect(await snapshot(root)).toEqual(before);
  });
});
