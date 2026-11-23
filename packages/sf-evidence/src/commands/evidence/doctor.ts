import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Org, type Connection } from '@salesforce/core';
import {
  doctorExitCode,
  formatChecks,
  runChecks,
  setExitCode,
  type Check,
  type DoctorEnv,
} from '@cclabsnz/sf-evidence-engine';
import { API_VERSION, DEFAULT_ARCHIVE, resolveSink } from '@cclabsnz/sf-evidence-engine';
import { gitConfig, readVersions, which } from '../../lib/doctorEnv.js';
import { readOrgClock } from '../../lib/orgClock.js';

export interface DoctorResult {
  checks: Check[];
  ok: boolean;
}

const malformed = (name: string, detail: string): Check => ({ name, level: 'warn', detail, checked: true });

/** The shape `formatChecks` and `doctorExitCode` dereference; a plugin's rows are untrusted input. */
function isCheck(v: unknown): v is Check {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.name === 'string' &&
    typeof c.detail === 'string' &&
    (c.level === 'ok' || c.level === 'warn' || c.level === 'fail') &&
    typeof c.checked === 'boolean' &&
    (c.remediation === undefined || typeof c.remediation === 'string')
  );
}

export default class EvidenceDoctor extends SfCommand<DoctorResult> {
  public static readonly summary = 'Check this machine and archive are ready to collect evidence';

  public static readonly description = `Environment diagnostics. Needs no org: it contacts Salesforce only when you pass
--target-org, and then only to read the org's clock and test read access to LoginHistory.

It writes nothing. Archive writability is judged by asking the sink whether the target exists
and is writable; no file is created to find out. Checks that do not apply to this release are
listed as such, so a line reading "ok" never stands for something that was not looked at.

Exit codes: 0 all ok · 4 any warning · 1 any failure.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --sink git --org-id 00D5j000000AbCdEAK',
    '<%= config.bin %> <%= command.id %> --target-org prod',
  ];

  public static readonly flags = {
    // Deliberately not Flags.optionalOrg(): that flag resolves the configured default org when
    // the flag is absent, so an unflagged run would contact an org. Here an org is resolved
    // only from an explicit value.
    'target-org': Flags.string({
      char: 'o',
      summary: "Also compare this machine's clock with the org's and test Login History access. The only flag that contacts an org.",
      helpValue: '<alias or username>',
    }),
    'org-id': Flags.string({ summary: 'Also read the chain head for this org id partition.' }),
    archive: Flags.string({ summary: 'Archive root directory.', default: DEFAULT_ARCHIVE }),
    sink: Flags.string({ summary: 'Sink holding the archive.', default: 'local' }),
  };

  public async run(): Promise<DoctorResult> {
    const { flags } = await this.parse(EvidenceDoctor);
    const target = flags['target-org'];

    const checks = await runChecks({
      nodeVersion: process.version,
      versions: await readVersions(),
      sink: resolveSink(flags.sink, flags.archive),
      orgId: flags['org-id'],
      which,
      gitConfig: (key) => gitConfig(flags.archive, key),
      extraChecks: () => this.hookChecks(),
      orgNow: target ? () => this.orgClock(target) : undefined,
      probeLoginHistory: target ? () => this.probeLoginHistory(target) : undefined,
    } satisfies DoctorEnv);

    for (const line of formatChecks(checks)) this.log(line);
    const exit = doctorExitCode(checks);
    // Non-throwing, so --json keeps `result`.
    setExitCode(exit);
    return { checks, ok: exit === 0 };
  }

  /**
   * Rows contributed by other plugins through the `sf-evidence:doctor-checks` hook (the query
   * plugin's "Query engine" row). Nothing a plugin does may take `doctor` down or pass unnoticed:
   * a hook that throws, a runHook that rejects, and a result that is not an array of well-formed
   * rows each become one warning row. A `fail` a plugin reports itself is kept as it is.
   */
  protected async hookChecks(): Promise<Check[]> {
    let ran: Awaited<ReturnType<typeof this.config.runHook>>;
    try {
      ran = await this.config.runHook('sf-evidence:doctor-checks', {});
    } catch (err) {
      return [malformed('Doctor hook', `the hook could not run: ${err instanceof Error ? err.message : String(err)}`)];
    }
    const rows: Check[] = [];
    for (const s of ran.successes) {
      const who = `Doctor hook (${s.plugin.name})`;
      if (!Array.isArray(s.result)) {
        rows.push(malformed(who, 'malformed result: expected an array of checks'));
        continue;
      }
      for (const row of s.result as unknown[]) {
        rows.push(isCheck(row) ? row : malformed(who, 'malformed result: an entry is not a well-formed check'));
      }
    }
    for (const f of ran.failures) {
      rows.push({
        name: f.plugin.name,
        level: 'warn',
        detail: `its doctor check failed: ${f.error.message}`,
        remediation: `Reinstall it with \`sf plugins install ${f.plugin.name}\`.`,
        checked: true,
      });
    }
    return rows;
  }

  private connections = new Map<string, Promise<Connection>>();

  /** One connection per --target-org, at the API version collect uses, shared by every org check. */
  protected connect(aliasOrUsername: string): Promise<Connection> {
    let conn = this.connections.get(aliasOrUsername);
    if (!conn) {
      conn = Org.create({ aliasOrUsername }).then((org) => org.getConnection(API_VERSION));
      this.connections.set(aliasOrUsername, conn);
    }
    return conn;
  }

  /** One-row read of LoginHistory, at the API version collect will query it with. */
  protected async probeLoginHistory(aliasOrUsername: string): Promise<void> {
    await (await this.connect(aliasOrUsername)).query('SELECT Id FROM LoginHistory LIMIT 1');
  }

  /** The only place doctor resolves an org; reached only from an explicit --target-org. */
  protected async orgClock(aliasOrUsername: string): Promise<Date> {
    return readOrgClock(await this.connect(aliasOrUsername));
  }
}
