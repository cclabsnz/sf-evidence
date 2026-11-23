# @cclabsnz/sf-evidence-query

`sf evidence query`: read-only SQL over an [sf-evidence](https://www.npmjs.com/package/@cclabsnz/sf-evidence)
archive, run in DuckDB inside the command. It contacts no Salesforce org and no network,
and writes nothing.

It's a separate plugin from `@cclabsnz/sf-evidence` so that a scheduled job that only
collects never downloads DuckDB. Install both:

```bash
sf plugins install @cclabsnz/sf-evidence @cclabsnz/sf-evidence-query
```

Neither is signed with Salesforce's plugin-signing scheme. To install without the
confirmation prompts, list both in `~/.config/sf/unsignedPluginAllowList.json`:
`["@cclabsnz/sf-evidence","@cclabsnz/sf-evidence-query"]`.

The plugin depends on `@duckdb/node-api` 1.5.6, pinned exactly. npm installs the DuckDB
build for your platform only, between about 38 MB (Windows x64) and 118 MB (macOS)
unpacked. `sf evidence doctor` shows a `Query engine` row with the DuckDB version once it
loads.

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --view setup_changes --from 2026-08-01 --to 2026-09-01
sf evidence query --all-orgs --sql "SELECT org_label, action, count(*) AS n FROM setup_changes GROUP BY ALL ORDER BY n DESC" --format csv
sf evidence query --org-id 00D5j000000AbCdEAK --file ./who-changed-profiles.sql --format ndjson
```

There are four views: `setup_changes` (Setup Audit Trail, with Login-As resolved),
`limit_samples` (one row per limit per sample), `login_history` (one row per login
attempt) and `records` (every record, with its
payload as JSON). [Query the archive with SQL](https://github.com/cclabsnz/sf-evidence/blob/main/docs/query.md)
covers the flags, time zones and six worked questions.
[`query-views.md`](https://github.com/cclabsnz/sf-evidence/blob/main/docs/query-views.md)
lists every column.

## What it will and won't do

- It reads only the record files listed in the hash chain's manifests. It can't read
  orphan files from an interrupted run, manifests, `_state/`, `.git/`, or anything else on
  disk or the network. Use the `records` view for raw records.
- It runs a single `SELECT` (or `WITH … SELECT`) and refuses everything else, including
  `COPY`, `ATTACH`, `INSTALL`, `LOAD`, `SET` and `CREATE`.
- DuckDB runs with extension install and autoload off, spilling to disk off, file access
  limited to those record files, and its configuration locked before your SQL runs.
  `sf evidence explain` states this and names the tests behind it.
- `performed_by_id` is NULL for Login-As changes, and nested sub-limits (such as
  `PermissionSets.CreateCustom`) aren't in `limit_samples`; read them from `records.payload`.
- Its results are **not verified**. Run `sf evidence verify` as well when the answer is
  going to an auditor.
- An archive path containing `* ? [ ] { }` is refused, because DuckDB would read it as a
  file pattern. Move the archive, or link to it from a path without those characters.

Exit codes: 0 success, including zero rows; 1 no archive for the requested org (or no orgs
under `--all-orgs`), DuckDB could not load, or the SQL was refused or failed; 2 usage error,
including an `--org-id` that is not 18 characters.

## License

Apache-2.0. See [`LICENSE`](https://github.com/cclabsnz/sf-evidence/blob/main/LICENSE).
