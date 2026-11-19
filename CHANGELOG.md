# Changelog

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
