import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { buildExplanation, type Explanation } from '@cclabsnz/sf-evidence-engine';
import { DEFAULT_ARCHIVE, resolveSink } from '@cclabsnz/sf-evidence-engine';
import type { SourceId } from '@cclabsnz/sf-evidence-engine';

const WINDOW_NOTE =
  'The audit-trail <from> and <to> are the collection window, sliced by month and narrowed on timeout.';

export default class EvidenceExplain extends SfCommand<Explanation> {
  public static readonly summary =
    'List every query, file write and network destination before you run anything';

  public static readonly description = `Prints exactly what this plugin will do with the current configuration: the literal SOQL
each collector issues and the permission it needs, the archive paths it writes and in what
order, and every network destination with the source of its credential.

Makes no network calls and requires no org connection. Intended for the security reviewer
who has to sign off on running this, so they do not have to read the source first.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --sink git --format json',
  ];

  public static readonly flags = {
    source: Flags.string({ summary: 'Sources to explain.', default: 'audit-trail,login-history' }),
    sink: Flags.string({ summary: 'Sinks to explain.', default: 'local' }),
    archive: Flags.string({ summary: 'Archive root directory.', default: DEFAULT_ARCHIVE }),
    'instance-url': Flags.string({
      summary: 'Org instance URL to show as the query destination.',
      default: 'https://<your-org>.my.salesforce.com',
    }),
  };

  public async run(): Promise<Explanation> {
    const { flags } = await this.parse(EvidenceExplain);

    const explanation = buildExplanation({
      sources: flags.source.split(',').map((s) => s.trim()) as SourceId[],
      sinks: flags.sink.split(',').map((id) => resolveSink(id.trim(), flags.archive)),
      instanceUrl: flags['instance-url'],
    });

    this.log('QUERIES');
    for (const q of explanation.queries) {
      const scope = q.scope === 'plugin' ? ' [plugin, not a collector]' : '';
      this.log(`  ${q.object}${scope}  (requires: ${q.permission})`);
      this.log(`    ${q.soql}`);
      if (q.note) this.log(`    when: ${q.note}`);
    }
    this.log(`  Note: ${WINDOW_NOTE}`);

    this.log('\nFILE WRITES');
    for (const w of explanation.writes) this.log(`  ${w}`);

    this.log('\nNETWORK DESTINATIONS');
    for (const d of explanation.destinations) {
      this.log(`  ${d.protocol}://${d.host}`);
      this.log(`    purpose:    ${d.purpose}`);
      this.log(`    credential: ${d.credentialSource}`);
    }

    this.log('\nWHAT THIS PLUGIN DOES NOT DO');
    for (const a of explanation.assertions) {
      this.log(`  ${a.claim}`);
      this.log(`    → ${a.mechanism}`);
    }

    return explanation;
  }
}
