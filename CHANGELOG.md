# Changelog

## 0.3.0 (unreleased)

- Upgrade note: login history is now collected by default, so the default sources are
  `audit-trail,login-history`. It needs the **Monitor Login History** permission
  (`MonitorLoginHistory`). Until the running user has it, `collect` exits 4 (degraded) on
  every run. Grant it, for example by redeploying `SF_Evidence_Reader.permissionset-meta.xml`
  from the templates, which now includes it. A schedule copied from an earlier template, or
  one that sets `SF_EVIDENCE_SOURCES` or `--source`, keeps its own list, so add
  `login-history` to it. `sf evidence doctor --target-org` now has a `Login History access`
  row that tells you whether the permission is missing.
- New source, `login-history`: the `LoginHistory` object, with a 180-day backfill on the
  first run and all 25 fields. If the org rejects ForwardedForIp, AuthMethodReference or
  AuthContextClassRef at v67.0, they are dropped for the rest of the run. The source is still
  `complete`, the manifest records an `INVALID_FIELD` degradation listing the dropped fields,
  and `collect` exits 4. Every request now uses API version 67.0 (it was 64.0), for every
  source. Each record still states the version it came from in `api_version`.
- Collection is committed in rounds of 7 days. A first backfill on one org writes one
  manifest per 7 days (about 26 for 180 days), and the record files of later rounds get an
  `-rNN` suffix. Daily runs still write one manifest.
- A source the running user cannot read (a missing permission, or an object the org doesn't
  expose to them) is queried once per run. The first refusal stops that source for the rest
  of the run, and one degraded entry records it over the whole remaining window. So an org
  without **Monitor Login History** whose audit trail is up to date still writes one
  manifest per daily run, recording the login-history denial once, instead of 26 degraded
  manifests.
- `sf evidence query --view login_history` returns one row per login attempt.
  `docs/query-views.md` lists the columns.
- `explain` default sources now match `collect`.
- The scheduling permission set grants `MonitorLoginHistory` alongside `ApiEnabled` and
  `ViewSetup`.
- Known gaps: login history has no usernames. Salesforce documents no retention for
  `LoginHistory`, so the 180-day window is an assumption. A backfill interrupted partway
  resumes without the API-budget check, and the remainder is planned as a normal incremental
  window.
- All three packages release at 0.3.0, and the plugins depend on the engine at `^0.3.0`.
  The GitHub Actions and Azure DevOps templates now pin `SF_EVIDENCE_VERSION` to 0.3.0
  (they pinned 0.1.0, which can't collect login history).

### Fixes

- Permission errors, query timeouts and field rejections from Salesforce are now
  recognised. Before, a missing permission made `collect` fail instead of exiting 4 and
  continuing with the other sources, and a timed-out slice wasn't split. This affected 0.1.0
  and 0.2.0.
- A query returning more than 10,000 rows in one time slice is now split instead of
  silently cut short. Before, the rows past 10,000 were dropped and the slice was still
  recorded as covered. A slice that's still too big at one hour is recorded as a
  `QUERY_TRUNCATED` degradation with its bounds, and isn't counted as covered. This affected
  0.1.0 and 0.2.0.

## 0.2.0 (2026-11-19)

- New plugin, `@cclabsnz/sf-evidence-query`, adds `sf evidence query`: one read-only SQL
  `SELECT` over the archive, run in DuckDB inside the command. Install it next to the main
  plugin with `sf plugins install @cclabsnz/sf-evidence @cclabsnz/sf-evidence-query`, and
  allow-list both. The main plugin still doesn't depend on DuckDB, so the scheduling
  templates are unchanged and install only `@cclabsnz/sf-evidence`.
- Three views: `setup_changes` (with Login-As resolved into `performed_by` and
  `recorded_as`), `limit_samples` and `records`. `--view` prints one, with `--from` and
  `--to`. Output as `table`, `json`, `csv` or `ndjson`. `*_local` columns print in `--timezone`,
  default `Pacific/Auckland`; SQL itself always computes in UTC, so comparing `*_utc` with
  `now()` is exact. `docs/query-views.md` lists every column, and
  `docs/query.md` works through five questions.
- `query` reads only the record files the hash chain covers. Orphan files are left out and
  counted in a warning, and so are manifest paths outside the record layout. It only reads,
  so it works on a read-only archive. An org with no chain is exit 1, not zero rows, and an
  `--org-id` that isn't 18 characters is a usage error (exit 2). DuckDB runs with extensions, spilling and file access outside those
  files turned off, and its configuration locked. `explain` and `docs/security-statement.md`
  state this and name the tests.
- `sf evidence doctor` replaces the "DuckDB on PATH" check with a `Query engine` row. The
  query plugin fills it in when installed; otherwise it says `not installed`, which is not
  a fault.
- Engine and library users: the `Sink` interface has three new required methods,
  `queryRoot()`, `listOrgs()` and `checkReadable()`. A custom sink must implement them.
  `resolveSink`, `DEFAULT_ARCHIVE`, `VIEWS`, `resolveQueryFiles` and `isOrgId` are now
  exported from the engine.
- Known gaps: there's no action category column yet, `performed_by_id` is NULL for
  Login-As changes, nested sub-limits aren't in `limit_samples`, and an archive path
  containing `* ? [ ] { }` can't be queried.
- All three packages release at 0.2.0. Parquet is no longer planned for this release.

## 0.1.0 (2026-11-17)

First public release.

- `sf evidence collect` archives Setup Audit Trail and samples org limits into a hash-chained
  archive, on the `local` or `git` sink. The first run backfills the full 180 days, and later
  runs collect incrementally and repair gaps. Slices that time out are halved, down to one
  hour. Long collections are refused when they would exhaust the org's daily API budget.
- `sf evidence status` reports coverage, gaps, pending time, lost time and retention headroom.
  It exits 3 when a source is at risk of losing data.
- `sf evidence verify` walks the chain and, with `--anchor git`, the commit history. It prints
  what the result proves and what it does not.
- `sf evidence explain` prints every query, file write and network destination. `docs/security-statement.md` is generated from it.
- `sf evidence doctor` checks the machine and archive, and the org clock with `--target-org`.
- Scheduling templates for GitHub Actions, Azure Pipelines and cron, with a setup guide:
  `docs/run-on-a-schedule.md`.
