# @cclabsnz/sf-evidence

Read-only Salesforce audit-data archival for the `sf` CLI: extracts Setup Audit Trail, and
samples org limits, to a hash-chained, verifiable archive you own — before Salesforce
deletes it.

## The gap

Salesforce destroys audit-relevant data on short, non-configurable windows. Setup Audit Trail
retains "at least the last 180 days," and **"after 180 days, setup entity records are
deleted"** — see the
[Object Reference: SetupAuditTrail](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_setupaudittrail.htm)
and the
[Security Guide: Monitor Setup Changes](https://developer.salesforce.com/docs/atlas.en-us.securityImplGuide.meta/securityImplGuide/admin_monitorsetup.htm).
Shield's Field Audit Trail does not help — it extends retention for *field history on
records*, not for Setup Audit Trail. Regulated organisations (NZ/AU public health, banking,
government) routinely face multi-year records obligations against that 180-day clock.
`sf-evidence` closes the gap by copying the data out, before it is gone, into an archive you
control, whose hash chain you can independently verify — see *What `verify` proves* below
for exactly what that chain does and does not establish.

## The 60-second path

```bash
sf plugins install @cclabsnz/sf-evidence
sf evidence collect
sf evidence verify --org-id <your-org-id>
```

`sf plugins install` asks you to confirm installing an unsigned plugin: sf-evidence is not
signed with Salesforce's plugin-signing scheme. To install non-interactively, as a scheduled
job must, allow-list it by name in `~/.config/sf/unsignedPluginAllowList.json`:
`["@cclabsnz/sf-evidence"]`. If you also install the query plugin, list both:
`["@cclabsnz/sf-evidence","@cclabsnz/sf-evidence-query"]`.

`collect` writes NDJSON records plus a hash-chained manifest under
`./sf-evidence-archive/` by default. `verify` walks the chain and reports whether it is
internally consistent — nothing more is required to get a first archive and a first
integrity check. See the next section for exactly what that check does and does not prove.

The first `collect` backfills the whole 180-day window Salesforce still holds; every run after
that adds only what is new. Run `sf evidence status --org-id <your-org-id>` afterwards to see
whether the archive is complete and how long until anything missing is destroyed. Read
*Limitations* at the end of this document before you rely on it.

## Run it on a schedule

One run is a snapshot. Salesforce keeps deleting, so `collect` has to keep running.
[Run sf-evidence on a schedule](https://github.com/cclabsnz/sf-evidence/blob/main/docs/run-on-a-schedule.md) sets it up on GitHub Actions, Azure Pipelines or
cron, in about 30 minutes, with a read-only integration user, JWT auth and a protected git
repository you own. Each run collects, pushes, then runs `status` and `verify`, and fails only
when someone has to act.

## Commands

| Command | What it does |
|---|---|
| `collect` | Reads the configured sources from the org and appends them to the archive. |
| `status` | Reports coverage, gaps and retention headroom from the archive alone. Contacts no org. |
| `verify` | Walks the hash chain and says what that does and does not prove. |
| `explain` | Prints every query, file write and network destination, before you run anything. |
| `doctor` | Checks this machine and archive are ready. Contacts an org only if you pass `--target-org`. |
| `query` | SQL over the archive. In the separate [`@cclabsnz/sf-evidence-query`](https://www.npmjs.com/package/@cclabsnz/sf-evidence-query) plugin; see below. |

### `collect`

```bash
sf evidence collect --target-org my-org --source audit-trail,limits
sf evidence collect --since P30D            # the last 30 days, as a duration
sf evidence collect --since PT12H           # the last 12 hours
sf evidence collect --since 2026-03-01      # or an ISO date
sf evidence collect --backfill              # re-collect the whole window; duplicates are skipped
sf evidence collect --dry-run               # query the org, write nothing
sf evidence collect --sink git --sign       # commit each manifest, signed with your own key
```

| Flag | Meaning |
|---|---|
| `--source` | `audit-trail` (default) and/or `limits`, comma-separated. |
| `--since` | An ISO date or datetime with a zone, or a duration (`P30D`, `PT12H`). Defaults to the watermark, else the full window. |
| `--until` | Collect up to this ISO date or datetime with a zone, or a duration ago (`P1D`, `PT12H`). Defaults to now. A `--since` or `--until` later than now is a usage error (exit 2). |
| `--backfill` | Re-collect the whole retention window even where the archive already covers it. Records already archived are deduplicated, not duplicated. |
| `--api-floor` | Refuse a collection spanning more than 7 days when fewer than this many daily API requests remain. On a source the archive already covers, only gap repair is refused; the routine incremental window always runs. Defaults to the larger of 5000 and 10% of the org's daily limit. |
| `--dry-run` | Query the org and compute everything, but write nothing. |
| `--fail-on-degraded` | Exit 1 instead of 4 when coverage was reduced, for strict CI. |
| `--sink` | `local` (default) or `git`. |
| `--sign` | git sink only: sign each manifest commit with your own key. |
| `--archive` | Archive root directory. Defaults to `./sf-evidence-archive`. |

Sources:

- `audit-trail` is an event source: Setup Audit Trail, kept by Salesforce for 180 days.
- `limits` is a snapshot source: one sample of the org's `/limits` per run, keyed to the hour
  (`limits:{org_id}:{YYYY-MM-DDTHH}`), so two runs in one hour write one sample. Salesforce
  stores no limits history, so a missed hour cannot be recovered afterwards. Run `collect` at
  least daily to keep `limits` current.

Every request is pinned to API version 64.0, and each record states the version it came from
in `api_version`.

### `status`

```bash
sf evidence status --org-id <your-org-id>
sf evidence status --org-id <your-org-id> --source audit-trail --strict
sf evidence status --org-id <your-org-id> --window 30 --json
```

For each event source it reports the last run, the records held, the intervals covered, and:

- **gaps**: intervals inside the retention window that no run covered.
- **pending**: time since the last run that has not been collected yet. This is not a gap.
- **lost**: time Salesforce has already destroyed, which can no longer be collected.
- **headroom**: how long until the oldest uncollected instant is destroyed. Always measured
  over the retention window; `--window` narrows which gaps are listed, never the headroom.
- **at-risk**: headroom under 10% of the retention window.
- **stale**: a snapshot source with no sample for 26 hours. Only snapshot sources are ever
  stale. An event source with nothing collected is not stale but at risk: its oldest
  uncollected instant is the one Salesforce is deleting now.

A snapshot source such as `limits` has samples, not coverage: `status` shows the sample count,
the newest sample and whether it is stale, and `--json` reports `coverage: null` for it.

These are computed from the intervals the manifests record. They show which time ranges a
run completed, not that every record inside a range was returned.

| Flag | Meaning |
|---|---|
| `--org-id` | Required. The org id partition to report on. |
| `--source` | Sources to report on. Defaults to every source in the archive. |
| `--strict` | Exit 3 on any gap, not only on coverage at risk. |
| `--window` | Days to evaluate, counting back from now. Defaults to each source's retention window. |
| `--sink`, `--archive` | Where the archive is held. |

Exit 0 means complete. Exit 1 means the archive holds nothing for the org and no `--source`
was named: check `--org-id` and `--archive`, as `verify` does on an empty chain. Exit 3 means a source is at risk of losing data (or, with `--strict`,
that any gap exists). Exit 4 means a gap that is not yet at risk, a stale snapshot source, an
event source with nothing in the window, or a source this release has no collector for and so
could not assess.

### `doctor`

```bash
sf evidence doctor --archive ./sf-evidence-archive
sf evidence doctor --archive ./sf-evidence-archive --target-org my-org
```

Checks the Node version, the plugin and engine versions, whether the archive location is
writable, the query engine, and (with `--org-id`) the chain head. The `Query engine` row
comes from the query plugin when it's installed: it loads DuckDB in its sandbox and reports
the version, or a warning with the load error. Without the query plugin the row says
`not installed`, which is not a fault. It writes nothing. Without `--target-org` it contacts no org and
no network. With it, the one thing it reads from the org is the org's clock, to compare with
this machine's: a single `GET /services/data/`, whose `Date` header is read. `explain` lists it.
Skew over five minutes is a warning, not advisory: `collect` makes the same read on every run
and ends its windows at the earlier of the two clocks, but when it cannot read the org's it
falls back to this machine's, and a clock ahead of the org leaves events uncollected. Checks that do not apply to this release are listed as such rather than as
`ok`. Exit 0 all ok, 4 any warning, 1 any failure.

### `query` (separate plugin)

```bash
sf plugins install @cclabsnz/sf-evidence-query
sf evidence query --org-id <your-org-id> --view setup_changes --from 2026-08-01 --to 2026-09-01
sf evidence query --org-id <your-org-id> --sql "SELECT action, count(*) AS n FROM setup_changes GROUP BY ALL ORDER BY n DESC"
```

`query` runs one read-only `SELECT` over four views, `setup_changes`, `limit_samples`, `login_history` and
`records`, in DuckDB inside the command. It is its own plugin so that installing
`sf-evidence` for a scheduled job never downloads DuckDB. It contacts no org and no
network, writes nothing, and reads only the record files the hash chain covers. Its results
are not verified: run `verify` as well when the answer is going to an auditor.
[Query the archive with SQL](https://github.com/cclabsnz/sf-evidence/blob/main/docs/query.md) has install notes and six worked
questions; [`query-views.md`](https://github.com/cclabsnz/sf-evidence/blob/main/docs/query-views.md) lists every column.

### `_state/` is a disposable cache

Each org's directory holds a `_state/` folder: a derived cache that speeds up `status` and
`collect`. It is safe to delete. Deleting it changes speed, never answers, and `verify` never
reads it. The git sink never stages it, so it is not part of the chain.

If your archive is a git repository, do not commit it. `collect` stages named paths only, so
do not run `git add -A` in the archive; add `_state/` to the repository's `.gitignore` if you
commit by hand.

## What `verify` proves — and does not prove

A hash chain alone is **not** enough for a third party who trusts neither the storage
provider nor us: every link is recomputable by whoever holds the archive. An adversary with
write access can edit a record, re-hash it, rebuild every later manifest, and hand back a
perfectly self-consistent chain. Chain-only verification catches *careless* tampering, not
*competent* tampering. Closing that gap needs an anchor the archive holder cannot forge —
which is why `verify` never describes an unanchored archive as tamper-evident. That word
applies only once an anchor is configured and evaluated.

| Mode | What it proves | What it still does not prove |
|---|---|---|
| `--anchor none` (the default) | Internal consistency. Any single-point edit, truncation, or reordering is detected — truncation only because `verify` compares `head.json` against the chain it walked. | Nothing against an adversary who can rewrite the whole chain. |
| `--anchor git`, repository pushed to a host with branch protection, commits signed | Each manifest was committed at a point in the repository's history, by a holder of the signing key. Rewriting history requires the key **and** a force-push the host logs independently. | That the signer was honest. Protects against third parties and after-the-fact edits, not against the key holder at the time of writing. |
| `--anchor git`, local-only repository, unsigned commits (**what you get by default**) | That the manifests exist as commits in this local history, in this order. | Anything an adversary could not manufacture. Rewriting a local, unsigned history requires only write access to the archive directory — the same access they needed to edit the archive. Commit author and date are values the writer chose. |
| `--anchor object-lock` **(not available in this release)** | Each manifest object carries an S3 Object Lock (or Azure immutable blob) retention in `COMPLIANCE` mode with a future `RetainUntilDate`. Rewriting requires the storage provider to break its own retention guarantee. | That the object was written when it claims. Object Lock proves immutability from write, not time of collection. |

The two `git` rows are the same flag. Which one you get depends on your repository, not on
this tool, and `verify` works out which and says so: it prints the signed/unsigned/rejected
commit counts and whether a remote is configured, and the "Proves" sentence it emits is
assembled at runtime from those facts rather than picked from a table. So the wording you
see will not match this table word for word — but a local repository of unsigned commits
gets text equivalent to the second row, including the sentence saying a rewrite costs an
attacker nothing beyond the access they already had. The table is the map; the output is the
territory, and the output is the one generated from what actually happened.

If the anchor could not be evaluated at all — `--anchor git` against a `--sink local`
archive, say — `verify` says it established nothing about the anchor, rather than describing
the guarantee a working one would have given.

To get the first row you need both halves yourself, since we never generate or hold a key.
The archive root must exist and be a git repository before `collect` will use it: we verify
and instruct, we never provision.

```bash
mkdir -p ./sf-evidence-archive
git -C ./sf-evidence-archive init -b main
git -C ./sf-evidence-archive config user.email you@example.com   # commits need an identity
git -C ./sf-evidence-archive config user.name  "Your Name"

sf evidence collect --sink git --sign        # git commit -S, with your key
git -C ./sf-evidence-archive remote add origin <your protected repo>
git -C ./sf-evidence-archive push -u origin main   # we never push for you
sf evidence verify --org-id <org> --sink git --anchor git --require-signed
```

If the commit step fails — no identity configured, or `-S` with no usable key — the batch is
still archived: records, manifest and head are written before the commit is attempted.
`collect` says so and exits 4, rather than claiming nothing was archived. Fix the cause and
commit the working tree yourself; the chain is intact either way.

`object-lock` is listed for completeness but is **not usable in this release** — it needs the
`s3`/`azure` sinks, which are not built yet (see Limitations below).

`verify` always prints the "proves" / "does not prove" pair for whichever mode ran — on a
clean result as well as a broken one — so its output can never be read as claiming more than
it checked.

### What `verify` will not call a pass

- **Nothing checked.** An org id or archive path that matches no manifests prints
  `chain: NOTHING VERIFIED` and exits 1. A green verification of an empty archive is
  indistinguishable from a mistyped `--org-id`.
- **A subrange.** `--from` / `--to` echo the range walked and label it as a subrange. `--to`
  additionally suppresses the `head.json` comparison, so that run does not claim to detect
  truncation.
- **Reduced coverage.** A chain can be intact over an archive that is missing a month.
  `verify` prints what the manifests record about degraded sources and exits 4, however long
  ago the `collect` that warned about it scrolled past.
- **A file it could not read.** A permission error is reported as `unreadable-file`, never as
  `missing-file`. "We could not look" and "it is gone" are different findings.
- **A missing `head.json`.** Not a break — it is a pointer, not evidence — but `collect`
  writes it last on every batch, so its absence over a non-empty chain means an interrupted
  run or a deletion, and it removes the only artifact that would reveal truncation. Exit 4.

## Exit codes

Uniform across every command, because CI reads the exit code, not the text.

| Code | Meaning |
|---|---|
| 0 | Success, full coverage. |
| 1 | Unexpected error, unreadable archive, or `verify` or `status` finding nothing for the org. |
| 2 | Usage error. |
| 3 | Integrity failure — chain broken, or the requested anchor could not be satisfied. |
| 4 | Degraded — the run completed but coverage was reduced. Data was written; a human must look. |

Exit 4 is the one that matters. `collect` returns it on the day a source degrades; `status`
returns it for a gap not yet at risk and the other cases listed under `status` above; `verify`
returns it for as long as a manifest records a degradation. All three keep their full `--json`
`result` payload on a non-zero exit, so the degradation detail and `breaks[]` survive the code.

## Two sinks, two archives

`--sink local,git` against a single `--archive` root is rejected up front. It is not a mirror:
the `git` sink already writes every file the `local` sink does and adds a commit on top, so
the two would be a single chain with two writers claiming the same manifest sequence.

There is no flag combination that fixes this in one command — `--archive` takes a single root
and applies it to every sink named in `--sink`. If you genuinely want two archives, run
`collect` twice, each with its own `--archive`:

```bash
sf evidence collect --sink local --archive ./archive-local
sf evidence collect --sink git   --archive ./archive-git
```

Note that these are two independent chains over two separate collections, not one chain
mirrored. Most people want one sink.

## The permission you need

Running `sf evidence collect` requires **View Setup and Configuration**, plus the standard
**API Enabled** permission every API integration needs. The `limits` source reads the
`/limits` REST resource under the same permissions. This is documented for Setup UI
access and for the `/limits` REST resource; Salesforce's Object Reference does not state
explicitly whether SOQL against `SetupAuditTrail` requires precisely this permission, so
treat it as the best-documented answer rather than a guarantee from Salesforce.

Explicitly **not required** — and worth telling your security reviewer this directly:
**View All Data**, **Modify All Data**, and **Manage Users**. `sf-evidence` never reads
business data and never touches user administration; it only reads the Setup Audit Trail
object and the `/limits` resource.

## Run `sf evidence explain` first

Before you point this at a production org, run:

```bash
sf evidence explain
sf evidence explain --source audit-trail,limits --sink git
```

The output for every source and both sinks is published as
[`docs/security-statement.md`](https://github.com/cclabsnz/sf-evidence/blob/main/docs/security-statement.md). It is generated from the same
code and a test fails if the two differ, so the page cannot go stale.

It requires no org connection and makes no network calls. It prints, for the configuration
as it stands:

1. **Every query** — the literal SOQL or REST read each configured collector issues, with the
   object, fields, and the permission it requires. Plus the reads no collector owns, each
   marked `[plugin, not a collector]`: the two `Organization` queries `collect` issues to
   resolve the archive's partition key and describe the org; the `GET /services/data/` whose
   `Date` header gives the org's clock (every `collect` run, and `doctor --target-org`); and,
   when an event source is configured, the `GET /limits/` API budget check `collect` makes
   before collecting more than 7 days. Reads not issued on every run say when they are.

   Scoped precisely, because this is the sentence a reviewer leans on hardest: **no SOQL query or
   REST request this plugin issues is missing from this list.** That is not the same as "your API log will
   contain nothing else". Authenticating and opening a connection is `@salesforce/core`'s job,
   not ours — `Flags.requiredOrg()` and `getConnection()` can perform their own calls for API
   version negotiation and identity before a single line of this plugin's code runs. Those
   calls belong to the Salesforce CLI you already trust enough to have logged in with, and we
   neither make nor can enumerate them. Everything this plugin asks the org for is above.
2. **Every file write** — the exact archive paths, and the order they're written in (records,
   then the manifest, then the head pointer — an interruption can leave orphan record files,
   never a manifest pointing at a file that doesn't exist).
3. **Every network destination** — for a default configuration this is exactly one entry: the
   org's My Domain host. Nothing else is contacted.

It also states its negative assertions — no DML, no telemetry, no third-party endpoint, no
infrastructure creation — each paired with the mechanism that backs it (a static invariant
test enforced in this repo's own CI, or a fact about the code you can re-verify by reading
it), rather than as an unqualified claim. This is intended to be the first thing a security
reviewer runs, so they don't have to read the source to decide whether to approve it.

## Verifying the archive yourself, without this tool

A third party should be able to check the chain with nothing but the archive, a JCS
implementation, and SHA-256 — no CloudCounsel software, and no network. The four formulas:

```
record_hash   = SHA-256( JCS(record) )
records_root  = Merkle root over record_hash values, in leaf order,
                binary tree, last node duplicated when a level has odd length
file_sha256   = SHA-256( raw bytes of the .ndjson file )
manifest_hash = SHA-256( JCS(manifest) )
```

**Leaf order for `records_root` is defined across the whole source entry, not per file.**
Take the files of `sources[i].files` in that array's order, and within each file its records
in line order, then concatenate: one source entry has exactly one root even when the run
wrote several monthly files. That is the normal case rather than the exotic one — the first
run backfills 180 days and partitions by calendar month, so a default first archive has
roughly seven files under one root.

A source that produced no records has an empty leaf list, and its `records_root` is the
SHA-256 of the empty byte string:
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

`JCS` is RFC 8785 JSON Canonicalization: object keys sorted by UTF-16 code unit, no
insignificant whitespace, shortest-form numbers, UTF-8 output. Each NDJSON line is already
canonical, so a record can be hashed directly from the file with no re-serialisation. A
manifest never stores its own hash — it appears only in the next manifest's
`prev_manifest_hash` and in `head.json`.

`head.json` is `{ seq, manifest_hash, updated_at }`. It is a pointer, not evidence — but it
is the only artifact that names the newest sequence, so a verifier that never compares it
against the manifests it walked cannot detect manifests removed from the end of the chain.
Every remaining link in a truncated chain still verifies.

Run `sf evidence verify --explain-algorithm` to print this from the tool itself, so the
procedure is self-documenting from the artifact and never depends on this README staying in
sync with the code.

## Using it as a library

This package's programmatic exports (`ArchiveReader`, `verifyChain`, the hashing primitives,
the sinks) are for reading and verifying an existing archive. The code behind them lives in
[`@cclabsnz/sf-evidence-engine`](https://www.npmjs.com/package/@cclabsnz/sf-evidence-engine), which this package re-exports
unchanged. A program that collects and writes archives without the `sf` CLI, such as a
scheduled job, uses the engine directly: it also exports `runCollect` and the collectors.

## Release notes for library users

In 0.2.0, the `Sink` interface has two new required methods, so a custom sink no longer
compiles until it implements them:

- `queryRoot(): string | null`: the absolute archive root for a sink on local disk, or null
  for one that can't be queried in place.
- `listOrgs(): Promise<string[]>`: the org ids with a partition in the sink, sorted.

`LocalSink` and `GitSink` implement both. The engine also exports `resolveSink`,
`DEFAULT_ARCHIVE`, the query view definitions (`VIEWS`) and `resolveQueryFiles`.

In 0.1.0, these API changes were not backward compatible:

- `VerifyReport.notes` is a new required field.
- `CollectResult.metadata` is a new required field.
- `GAP_NOTICE` and `hasCoverageGap` are removed. Use `assessStatus` and `formatStatus`.

## Limitations

This release is intentionally narrow. Stated plainly, so it isn't discovered the hard way:

- **Two sources**: `audit-trail` (Setup Audit Trail) and `limits`. `login-history` is
  specified but not implemented.
- **Two sinks only**: `local` (plain filesystem) and `git`. `s3`, `azure` and `siem` are
  specified but not implemented, and so is the `object-lock` anchor mode that depends on
  `s3`/`azure`.
- **NDJSON only.** No Parquet.
- **`query` is a separate plugin, and its results are unverified.** It reads only
  chain-covered record files, but it does not check the chain: that is `verify`'s job. The
  views have no action category yet, so filter on Salesforce's own `Action` codes.
  `performed_by_id` is NULL for Login-As changes, and nested sub-limits are not in
  `limit_samples`. An archive path containing `* ? [ ] { }` can't be queried; move or
  link the archive.
- **No `check`, `score`, or `report` commands.** There is no rule-pack evaluation, no
  scoring, and no auditor-facing report generation in this release.
- **Commit signing is opt-in and yours to configure.** `collect --sink git --sign` runs
  `git commit -S` with your key; we never generate, hold or manage one. Without it, and
  without a remote, `--anchor git` proves less than the chain does not; see the anchor table
  above for the exact wording `verify` prints in that case.
- **Gap detection works on coverage intervals, not on records.** `status` finds time ranges
  no run covered, and reports how long until Salesforce destroys them. It cannot tell that a
  run which covered a range returned every record in it. Nothing in this tool can compare
  against Salesforce's own count.
- **`limits` history starts when you start collecting.** Salesforce keeps none, and a
  missed sample cannot be back-filled.
- **Nothing runs on a schedule unless you set it up.** Run `collect` from cron or CI at least
  daily; the [scheduling guide](https://github.com/cclabsnz/sf-evidence/blob/main/docs/run-on-a-schedule.md) has ready-made templates. `status` exits non-zero when
  the archive has fallen behind far enough to matter.

Shipping a retention tool that implied complete coverage before it could actually verify
complete coverage would be exactly the kind of overclaim this product exists to avoid.

## License

Apache-2.0. See [`LICENSE`](https://github.com/cclabsnz/sf-evidence/blob/main/LICENSE).
