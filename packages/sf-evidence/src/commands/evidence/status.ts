import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import {
  ArchiveReader,
  COLLECTORS,
  assessStatus,
  formatStatus,
  setExitCode,
  type Gap,
  type SourceId,
  type StatusRow,
  type TimeWindow,
} from '@cclabsnz/sf-evidence-engine';
import { DEFAULT_ARCHIVE, resolveSink } from '../../lib/flags.js';

/**
 * One source in the JSON result (SPEC.md §8.4, plus `kind`, `pending`, `lost` and `stale`
 * from rules R5–R7).
 *
 * `kind: null` means no collector for the source is registered in this release, so its
 * retention window is unknown and nothing was assessed: every assessment field, `atRisk` and
 * `stale` included, is `null`, never a value a consumer could read as a verdict.
 */
export interface StatusSource {
  source: SourceId;
  kind: 'event' | 'snapshot' | null;
  lastRun: string | null;
  lastSuccess: string | null;
  recordCount: number;
  /**
   * Covered intervals inside the evaluation window (all held coverage when not assessed).
   * Null for a snapshot source: it has samples, not coverage.
   */
  coverage: TimeWindow[] | null;
  gaps: Gap[] | null;
  pending: TimeWindow | null;
  lost: TimeWindow[] | null;
  retentionWindowDays: number | null;
  headroomSeconds: number | null;
  atRisk: boolean | null;
  destroyedAfter: string | null;
  stale: boolean | null;
}

export interface StatusResult {
  orgId: string;
  sources: StatusSource[];
  /** True when any assessed source is at risk: exit 3 whatever `--strict` says. */
  atRisk: boolean;
}

/** The row as JSON: SPEC.md §8.4 field names, without the run-status counts. */
function toResultSource(row: StatusRow): StatusSource {
  return {
    source: row.source,
    kind: row.kind,
    lastRun: row.lastRun,
    lastSuccess: row.lastSuccess,
    recordCount: row.recordCount,
    coverage: row.coverage,
    gaps: row.gaps,
    pending: row.pending,
    lost: row.lost,
    retentionWindowDays: row.retentionDays,
    headroomSeconds: row.headroomSeconds,
    atRisk: row.atRisk,
    destroyedAfter: row.destroyedAfter,
    stale: row.stale,
  };
}

export default class EvidenceStatus extends SfCommand<StatusResult> {
  public static readonly summary = 'Show whether the archive is complete, and how long until missing data is destroyed';

  public static readonly description = `Reports, per source: the last run, how many records are held, the intervals covered,
every gap inside the retention window, time not yet collected since the last run (pending),
time Salesforce has already destroyed (lost), and the retention headroom: how long until the
oldest uncollected instant is deleted by Salesforce. Headroom is always measured over the
retention window; --window narrows which gaps are listed, never the headroom.

Contacts no Salesforce org and no network.

Exit codes: 0 complete · 1 when the archive holds nothing for the org and no --source was named · 3 when any source is at risk of losing data (headroom under 10% of
its retention window), or with --strict when any gap exists · 4 when a gap exists but is not
yet at risk, a snapshot source has had no sample for 26 hours, an event source has nothing
collected in the evaluated window, or a source has no collector in this release and could
not be assessed. Time since the last run is pending, not a gap, and does not change the
exit code until it puts the source at risk.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --org-id 00D5j000000AbCdEAK',
    '<%= config.bin %> <%= command.id %> --org-id 00D5j000000AbCdEAK --source audit-trail --strict',
  ];

  public static readonly flags = {
    'org-id': Flags.string({ summary: 'Org id partition to report on.', required: true }),
    archive: Flags.string({ summary: 'Archive root directory.', default: DEFAULT_ARCHIVE }),
    sink: Flags.string({ summary: 'Sink holding the archive.', default: 'local' }),
    source: Flags.string({
      summary: 'Sources to report on (comma-separated). Defaults to every source in the archive.',
      helpValue: 'audit-trail,limits',
    }),
    strict: Flags.boolean({ summary: 'Exit 3 on any gap, not only on coverage at risk.', default: false }),
    window: Flags.integer({
      summary: "Days to evaluate, counting back from now. Defaults to each source's retention window.",
      helpValue: '<days>',
      min: 1,
    }),
  };

  public async run(): Promise<StatusResult> {
    const { flags } = await this.parse(EvidenceStatus);
    const windowDays = flags.window;

    const sink = resolveSink(flags.sink, flags.archive);
    await sink.init();

    const orgId = flags['org-id'];
    const summaries = await new ArchiveReader(sink).summarise(orgId);
    const sources = parseSources(flags.source, [...Object.keys(COLLECTORS), ...summaries.map((s) => s.source)]);

    const status = assessStatus(summaries, new Date(), { windowDays, strict: flags.strict, sources });
    const archive = sink.describe().location;
    for (const line of formatStatus(status.rows, { windowDays, orgId, archive })) this.log(line);
    // Non-throwing, so --json keeps `result`.
    setExitCode(status.exit);

    return { orgId, sources: status.rows.map(toResultSource), atRisk: status.atRisk };
  }
}

/** The `--source` list, each name checked against the registry and the archive. */
function parseSources(csv: string | undefined, available: string[]): SourceId[] | undefined {
  if (csv === undefined) return undefined;
  const known = new Set(available);
  const names = csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (names.length === 0) throw new Error('--source names no source.');
  for (const name of names) {
    if (!known.has(name)) {
      throw new Error(`Unknown source '${name}'. Available: ${[...known].sort().join(', ')}.`);
    }
  }
  return names as SourceId[];
}
