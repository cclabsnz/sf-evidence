import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Org } from '@salesforce/core';
import {
  doctorExitCode,
  formatChecks,
  runChecks,
  setExitCode,
  type Check,
  type DoctorEnv,
} from '@cclabsnz/sf-evidence-engine';
import { DEFAULT_ARCHIVE, resolveSink } from '@cclabsnz/sf-evidence-engine';
import { gitConfig, readVersions, which } from '../../lib/doctorEnv.js';
import { readOrgClock } from '../../lib/orgClock.js';

export interface DoctorResult {
  checks: Check[];
  ok: boolean;
}

export default class EvidenceDoctor extends SfCommand<DoctorResult> {
  public static readonly summary = 'Check this machine and archive are ready to collect evidence';

  public static readonly description = `Environment diagnostics. Needs no org: it contacts Salesforce only when you pass
--target-org, and then only to read the org's clock.

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
      summary: "Also compare this machine's clock with the org's. The only flag that contacts an org.",
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
      orgNow: target ? () => this.orgClock(target) : undefined,
    } satisfies DoctorEnv);

    for (const line of formatChecks(checks)) this.log(line);
    const exit = doctorExitCode(checks);
    // Non-throwing, so --json keeps `result`.
    setExitCode(exit);
    return { checks, ok: exit === 0 };
  }

  /** The only place doctor resolves an org; reached only from an explicit --target-org. */
  protected async orgClock(aliasOrUsername: string): Promise<Date> {
    const org = await Org.create({ aliasOrUsername });
    return readOrgClock(org.getConnection());
  }
}
