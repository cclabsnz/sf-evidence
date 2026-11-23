# sf-evidence

Salesforce deletes Setup Audit Trail records after 180 days. sf-evidence copies them out
before that happens, into a hash-chained archive you own and can verify without us.

It's a read-only `sf` CLI plugin. It needs **View Setup and Configuration**, **Monitor Login History** and **API
Enabled**, and nothing else: no View All Data, no Modify All Data. It runs no DML, sends no
telemetry, and creates no infrastructure. The only network destination it contacts is your
org. `sf evidence explain` prints every query, file write and network destination before you
run anything, and [`docs/security-statement.md`](docs/security-statement.md) is that output,
generated from the code.

```bash
sf plugins install @cclabsnz/sf-evidence
sf evidence collect --target-org my-org
sf evidence status  --org-id <your-org-id>
sf evidence verify  --org-id <your-org-id>
```

The first `collect` backfills the 180 days Salesforce still holds. Every run after that adds
only what's new. `status` tells you whether anything is missing and how long until Salesforce
destroys it. `verify` checks the chain, and says what that check does and does not prove.

## Keep it running

One run is a snapshot, and the 180-day clock keeps going.
[Run sf-evidence on a schedule](docs/run-on-a-schedule.md) sets it up on GitHub Actions,
Azure Pipelines or cron in about 30 minutes. It uses a read-only integration user, JWT auth,
and a private git repository with branch protection, all in your accounts. The job fails only
when someone has to act. The most important case is `status` reporting that uncollected data
is close to being deleted.

## What's in this release

| | |
|---|---|
| Sources | `audit-trail` (Setup Audit Trail) and `login-history` (Login History), collected by default; `limits` (org limits, sampled each run), opt in |
| Sinks | `local` filesystem, `git` (with optional signed commits) |
| Commands | `collect`, `status`, `verify`, `explain`, `doctor`, and `query` in a separate plugin |
| Format | NDJSON records, JCS + SHA-256 hash chain, Merkle root per source |

S3 with Object Lock, Parquet and rule packs are specified but not built
yet.

## Ask the archive questions in SQL

`sf evidence query` runs SQL over the archive on your machine, through four views:
`setup_changes`, `limit_samples`, `login_history` and `records`. It's a separate plugin, so a scheduled job
that only collects never downloads DuckDB:

```bash
sf plugins install @cclabsnz/sf-evidence @cclabsnz/sf-evidence-query
sf evidence query --org-id <your-org-id> --sql "SELECT performed_by, count(*) AS n FROM setup_changes WHERE via_login_as GROUP BY ALL"
```

It contacts no org and no network, writes nothing, and reads only the record files the
hash chain covers. Its results aren't verified, so run `verify` too when the answer is
going to an auditor. [Query the archive with SQL](docs/query.md) has install notes and
six worked questions, and [`docs/query-views.md`](docs/query-views.md) lists every
column. The [plugin README](packages/sf-evidence/README.md) lists the
limitations plainly. Read them before you rely on it.

## Packages

| Package | |
|---|---|
| [`@cclabsnz/sf-evidence`](packages/sf-evidence) | The `sf evidence` plugin. Start here. |
| [`@cclabsnz/sf-evidence-query`](packages/sf-evidence-query) | `sf evidence query`: read-only SQL over the archive, in a sandboxed in-process DuckDB. |
| [`@cclabsnz/sf-evidence-engine`](packages/sf-evidence-engine) | Collectors, chain, sinks and archive reader, usable without the `sf` CLI. |

## Development

```bash
pnpm install
pnpm build
pnpm test
bash scripts/check-pack.sh   # packed plugins depend on the engine by semver, not workspace:
```

## License

Apache-2.0. Built by [CloudCounsel](https://github.com/cclabsnz).
