# Query the archive with SQL

`sf evidence query` runs SQL over your archive on your own machine. Use it for questions
like "who changed profiles through Login-As last month?" or "which limits are nearly
full?". It reads the archive only. It contacts no org and no network, and it writes
nothing.

You need to know SQL. You don't need to know how the archive stores records: three views
flatten them into ordinary tables.

## Install

`query` is a separate plugin, so a scheduled job that only collects never downloads
DuckDB. Install both plugins:

```bash
sf plugins install @cclabsnz/sf-evidence @cclabsnz/sf-evidence-query
```

Neither plugin is signed with Salesforce's plugin-signing scheme, so `sf plugins install`
asks you to confirm each one. To install without the prompts, put both names in
`~/.config/sf/unsignedPluginAllowList.json`:

```json
["@cclabsnz/sf-evidence","@cclabsnz/sf-evidence-query"]
```

The query plugin depends on DuckDB (`@duckdb/node-api`, pinned to 1.5.6). npm downloads
the DuckDB build for your platform only: about 38 MB unpacked on Windows x64, 64 to 71 MB
on Linux and 118 MB on macOS. Check the install with:

```bash
sf evidence doctor
```

The `Query engine` row should say `ok` and show the DuckDB version. If it says
`not installed`, the query plugin isn't installed. If it's a warning, DuckDB failed to
load: reinstall with `sf plugins install @cclabsnz/sf-evidence-query`.

## The three views

| View | One row per | Time column |
|---|---|---|
| `setup_changes` | Setup Audit Trail entry | `occurred_at_utc` |
| `limit_samples` | limit per sample, from `limits` | `sampled_at_utc` |
| `records` | archived record, any source, with the payload as JSON | `occurred_at_utc` |

[`query-views.md`](query-views.md) lists every column with its type and meaning. It is
generated from the view definitions, so it matches what the command runs.

Things in the views that catch people out:

- **Login-As.** `performed_by` is who made the change. Under Login-As that's the admin,
  from Salesforce's `DelegateUser`. `recorded_as` is who Salesforce recorded, which under
  Login-As is the user being impersonated. `via_login_as` tells you which case a row is.
- **`performed_by_id` is NULL for Login-As changes.** Salesforce gives only the admin's
  username there, and turning a username into a user id needs user data this release
  doesn't collect. It never falls back to `CreatedById`, because that's the impersonated
  user.
- **Usernames can be NULL.** `performed_by` and `recorded_as` are NULL wherever Salesforce
  returned no username. In our developer org that was about 12% of entries.
- **Nested limits aren't in `limit_samples`.** Only top-level limits are. A sub-limit such
  as `PermissionSets.CreateCustom` is read from `records.payload`; there's an example at
  the end.
- **There's no action category yet.** Filter on `action` with the codes your org actually
  uses. Question 2 shows how to list them.

## Running a query

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --sql "SELECT count(*) FROM setup_changes"
sf evidence query --org-id 00D5j000000AbCdEAK --file ./who-changed-profiles.sql
sf evidence query --org-id 00D5j000000AbCdEAK --view setup_changes --from 2026-08-01 --to 2026-09-01
```

Give exactly one of `--sql`, `--file` or `--view`. `--view` prints the whole view ordered
by its time column, and only `--view` takes `--from` and `--to`.

| Flag | Meaning |
|---|---|
| `--org-id` / `--all-orgs` | One org's partition, or every org in the archive. One is required. |
| `--archive` | Archive root. Defaults to `./sf-evidence-archive`. |
| `--sink` | `local` (default) or `git`. |
| `--from`, `--to` | With `--view` only. Rows with time `>= from` and `< to`. Takes `2026-08-01` (UTC midnight) or an ISO timestamp with `Z` or an offset, such as `2026-08-21T12:00+12:00`. |
| `--format` | `table` (default), `json`, `csv` or `ndjson`. |
| `--limit` | At most this many rows. Without it, `table` shows the first 100 and says how many more there are; the other formats print everything. |
| `--timezone` | IANA zone for the `*_local` columns. Defaults to `Pacific/Auckland`. |
| `--json` | The full result envelope: columns with types, rows, row count, warnings. |

Exit 0 means the query ran, even if it returned no rows. Exit 1 means DuckDB couldn't
load, the SQL was refused, or the SQL failed. Exit 2 is a usage error, such as two of
`--sql`, `--file` and `--view` together.

### Times: compare like with like

`*_utc` columns are UTC and print with `Z`. The event time in `setup_changes` and the
sample time in `limit_samples` also come as `*_local` columns: the same instant in
`--timezone`, printed with its offset, for example `2026-08-21T11:30:00+12:00`. The offset
is right on each side of a daylight-saving change.

There's one trap. `*_utc` columns are plain timestamps with no zone attached. If you
compare one with a zoned value such as `now()` or `TIMESTAMPTZ '…'`, DuckDB reads the
plain timestamp as `--timezone` local time first. In Auckland that shifts it by 12 or 13
hours, and the query still runs without any error. So:

- compare `*_utc` columns with `TIMESTAMP '2026-08-01'` literals, which are UTC;
- compare `*_local` columns with `now()` or `TIMESTAMPTZ '2026-08-21 12:00:00+12'`;
- use `CAST(occurred_at_local AS DATE)` for the calendar day in `--timezone`.

## Five worked questions

The outputs below come from the test fixture, a small invented archive with two orgs:
`00D5j000000AbCdEAK` (*Fixture Prod*) and `00D000000000002AAA` (*Fixture UAT*). Its
users and changes are made up. Every command was also run against a real developer-org
archive and exits 0 there. The action codes come from that org.

The fixture's audit-trail entries are from August and September 2026. Where a question
says "last 30 days" or "last quarter", the example uses fixed dates so the output isn't
empty, and the rolling form is given alongside it.

### 1. Changes made through Login-As in the last 30 days, and by whom

The rolling form, for your own archive:

```sql
SELECT occurred_at_local, performed_by, recorded_as, action
FROM setup_changes
WHERE via_login_as
  AND occurred_at_local >= now() - INTERVAL 30 DAY
ORDER BY occurred_at_utc
```

It compares `occurred_at_local` with `now()`, because both carry a zone. On the fixture,
the 30 days before 1 September 2026:

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --sql "
SELECT occurred_at_local, performed_by, recorded_as, action
FROM setup_changes
WHERE via_login_as
  AND occurred_at_utc >= TIMESTAMP '2026-08-02'
  AND occurred_at_utc <  TIMESTAMP '2026-09-01'
ORDER BY occurred_at_utc"
```

```
occurred_at_local          performed_by           recorded_as           action
─────────────────────────  ─────────────────────  ────────────────────  ─────────────────────
2026-08-21T11:30:00+12:00  admin@fixture.example  jane@fixture.example  changedprofileforuser
```

`admin@fixture.example` logged in as Jane and changed her profile. Salesforce recorded it
as Jane. Who has used Login-As at all, and how often:

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --sql "
SELECT performed_by, count(*) AS changes
FROM setup_changes
WHERE via_login_as
GROUP BY performed_by
ORDER BY changes DESC"
```

```
performed_by           changes
─────────────────────  ───────
admin@fixture.example  1
```

### 2. Permission-set assignments last quarter

Action codes vary by org and by change. Start by listing the ones your archive holds:

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --sql "
SELECT action, section, count(*) AS n
FROM setup_changes
GROUP BY action, section
ORDER BY n DESC, action"
```

```
action                           section       n
───────────────────────────────  ────────────  ─
PermSetAssign                    Manage Users  1
changedprofileforuser            Manage Users  1
value_MAX_STREAMING_TOPICS_PROV                1
```

In a real developer org, assignment changes used `PermSetAssign`, `PermSetUnassign` and
`PermSetLicenseAssign`. The same org had more than a dozen other `PermSet…` codes for edits to
permission sets themselves, such as `PermSetEnableUserPerm` and `PermSetFlsChanged`.
Profile changes carry suffixes: the fixture has `changedprofileforuser`, and the real org
had `changedprofileforuserstdtostd`. Match those with
`action LIKE 'changedprofileforuser%'`.

Assignments in the third quarter of 2026, across both orgs:

```bash
sf evidence query --all-orgs --sql "
SELECT org_label, occurred_at_utc, action, performed_by, display
FROM setup_changes
WHERE action IN ('PermSetAssign', 'PermSetUnassign', 'PermSetLicenseAssign')
  AND occurred_at_utc >= TIMESTAMP '2026-07-01'
  AND occurred_at_utc <  TIMESTAMP '2026-10-01'
ORDER BY occurred_at_utc"
```

```
org_label     occurred_at_utc       action         performed_by           display
────────────  ────────────────────  ─────────────  ─────────────────────  ──────────────────────────────────────────────────────────────────
Fixture Prod  2026-08-14T02:11:09Z  PermSetAssign  admin@fixture.example  Assigned permission set Fixture Admin to user jane@fixture.example
Fixture UAT   2026-08-15T00:00:00Z  PermSetAssign  ops@fixture.example    Assigned permission set Fixture Ops to user ops@fixture.example
```

For a rolling previous quarter, use
`occurred_at_local >= date_trunc('quarter', now()) - INTERVAL 3 MONTH AND occurred_at_local < date_trunc('quarter', now())`.

### 3. Everything changed in the 48 hours before a date

Something broke at midday on 21 August, Auckland time. `--view` with `--from` and `--to`
gives every column, and both flags take an offset. `--format json` puts one row on its
own lines, so it's readable:

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --view setup_changes \
  --from 2026-08-19T12:00+12:00 --to 2026-08-21T12:00+12:00 --format json
```

```json
[
  {
    "occurred_at_utc": "2026-08-20T23:30:00Z",
    "occurred_at_local": "2026-08-21T11:30:00+12:00",
    "action": "changedprofileforuser",
    "section": "Manage Users",
    "display": "Changed profile for user jane@fixture.example from Standard User to Fixture Admin",
    "via_login_as": true,
    "performed_by": "admin@fixture.example",
    "performed_by_id": null,
    "recorded_as": "jane@fixture.example",
    "recorded_as_id": "005A00000000002AAA",
    "recorded_as_name": "Jane Doe",
    "created_by_context": null,
    "source_id": "0YmA00000000002AAA",
    "org_id": "00D5j000000AbCdEAK",
    "org_label": "Fixture Prod",
    "collected_at_utc": "2026-11-17T09:00:00Z"
  }
]
```

`performed_by_id` is null because the change was made through Login-As.

### 4. Daily API usage trend

`limits` takes one sample per `collect` run, at most one per UTC hour, so you get as
many points per day as you run `collect`. Salesforce counts `DailyApiRequests` over a rolling 24 hours, so each sample
is the usage over the 24 hours before it was taken, and the daily maximum is that day's
peak:

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --sql "
SELECT CAST(sampled_at_local AS DATE) AS day,
       max(used) AS peak_used,
       max(max)  AS daily_limit,
       count(*)  AS samples
FROM limit_samples
WHERE limit_name = 'DailyApiRequests'
GROUP BY day
ORDER BY day"
```

```
day         peak_used  daily_limit  samples
──────────  ─────────  ───────────  ───────
2026-11-17  2          15000        1
```

The fixture has a single sample. Add `--format csv` to take the series into a
spreadsheet.

### 5. Limits at or above 80%

From the newest sample:

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --sql "
SELECT sampled_at_local, limit_name, used, max, round(pct_used, 1) AS pct_used
FROM limit_samples
WHERE pct_used >= 80
  AND sampled_at_utc = (SELECT max(sampled_at_utc) FROM limit_samples)
ORDER BY pct_used DESC"
```

```
sampled_at_local               limit_name     used  max  pct_used
─────────────────────────────  ─────────────  ────  ───  ────────
2026-11-17T21:00:12.482+13:00  DataStorageMB  4     5    80
```

`pct_used` is NULL when a limit's `max` is 0 or missing, so those limits never match this
filter. The subquery takes the newest sample across every org in the query. Run it with
`--org-id` per org: with `--all-orgs`, an org sampled at a different time drops out.

### Reading the raw payload

`records` holds every record with its payload exactly as Salesforce returned it. Use it for
anything the other views leave out, such as a nested limit:

```bash
sf evidence query --org-id 00D5j000000AbCdEAK --sql "
SELECT source_id, payload->>'\$.limits.PermissionSets.CreateCustom.Max' AS create_custom_max
FROM records
WHERE source = 'limits'"
```

```
source_id                                create_custom_max
───────────────────────────────────────  ─────────────────
limits:00D5j000000AbCdEAK:2026-11-17T08  1000
```

## If the answer is going to an auditor, run `verify`

`query` doesn't check the hash chain. Its result says nothing about whether the archive
has been altered. If someone will rely on the answer,
run this as well and keep its output with the result:

```bash
sf evidence verify --org-id 00D5j000000AbCdEAK
```

The [plugin README](../packages/sf-evidence/README.md#what-verify-proves--and-does-not-prove)
explains what `verify` proves and what it doesn't.

## What `query` can't read

`query` reads only the record files that the hash chain's manifests list. It can't read:

- **orphan record files.** A file left by an interrupted `collect` isn't in any manifest,
  so its records are left out and the command warns on stderr. The fixture has one, and
  every example above also printed this warning:

  ```
  Warning: 1 record file(s) in the archive are not covered by the hash chain and were excluded. Run sf evidence verify.
  ```

- **manifests, `head.json`, `archive.json` and `org.json`.** The views use `org.json` for
  `org_label`, but your SQL can't open it.
- **`_state/`**, the disposable cache.
- **`.git/`**, in a git-sink archive.
- **anything else on your machine or the network.** `read_csv('/etc/passwd')` and
  `read_ndjson('https://…')` are refused.

`read_ndjson('…')` works only on those same chain-covered record files, by absolute path.
Use the `records` view instead: it already has every chain-covered record, with typed
envelope columns and `org_id`, `source`, `year` and `month`.

The SQL is checked before it runs. Only a single `SELECT` statement (or `WITH … SELECT`)
is accepted, so `COPY`, `ATTACH`, `INSTALL`, `SET`, `CREATE` and `INSERT` are refused with
exit 1. DuckDB runs inside the command with extension install and autoload off, spilling
to disk off, file access limited to those record files, and its configuration locked before
your SQL runs. `sf evidence explain` states this and names the tests behind it.

**Archive paths can't contain `*`, `?`, `[`, `]`, `{` or `}`.** DuckDB would treat those
as a file pattern instead of a file name, so `query` refuses the archive with a message
naming the file. Move the archive, or make a symlink to it from a path without those
characters, and pass that path to `--archive`.
