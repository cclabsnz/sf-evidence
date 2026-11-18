# DuckDB facts (verified by running code)

Package `@duckdb/node-api@1.5.6-r.2`, `select version()` -> `[{"v":"v1.5.6"}]`. Node v26.12.1, darwin-arm64.
Probes: `<scratch>/duckdb-facts/probe.mjs`, `probe2.mjs`, `probe3.mjs`, `probe4.mjs`. Every line below is verbatim probe output (paths shortened to `<FX>`).

## Stop conditions: NONE hit
- icu/json built in: `[ext] [{"extension_name":"icu","loaded":true,"installed":true,"install_mode":"STATICALLY_LINKED"},{"extension_name":"json","loaded":true,...,"install_mode":"STATICALLY_LINKED"}]` (instance created with autoinstall/autoload false). Also loaded: autocomplete, core_functions, parquet.
- allowed_paths is exact-file: `[direct-read-allowed-file] [{"n":"2"}]` vs `[direct-read-NOT-allowed-sibling] ERROR: Permission Error: Cannot access file "<FX>/.../month=08/part-b.ndjson" - file system operations are disabled by configuration` (part-b is in the same dir as allowed part-a).

## Instance creation
`DuckDBInstance.create(':memory:', { autoinstall_known_extensions:'false', autoload_known_extensions:'false' })` -> settings read back `autoinstall_known_extensions=false`, `autoload_known_extensions=false`. All option values are strings. `import { DuckDBInstance } from '@duckdb/node-api'` works; `StatementReturnType` is NOT exported (prepared.statementReturnType is undefined). Use `statementType`.
`instance` API: `connect`, `closeSync`. `connection` API: `interrupt`, `prepare`, `createPrepared`, `extractStatements`. `[read-timeout-interrupt] ERROR: INTERRUPT Error: Interrupted!` (connection.interrupt() works; use for timeouts).

## Lockdown settings (exact names/values accepted)
| Setting | Result |
|---|---|
| `SET enable_external_access=false` | `ok` |
| `SET allowed_paths=['<abs file>',...]` (VARCHAR[]) | `ok`, list of exact files |
| `SET allowed_directories=[]` | `ok` (VARCHAR[]) |
| `SET disabled_filesystems='HTTPFileSystem,S3FileSystem'` | `ok`; re-setting errors `File system "S3FileSystem" has been disabled previously, it cannot be re-enabled`. `duckdb_settings()` still shows value `""` afterwards (not reliable to read back). Redundant under eea=false: `[post-lock http] ERROR: Permission Error: Cannot access file "https://example.com/a.csv" - file system operations are disabled by configuration` (s3:// same). |
| `SET lock_configuration=true` | `ok` |

ORDER IS MANDATORY: `allowed_paths`/`allowed_directories` must be set BEFORE `enable_external_access=false`:
- `[set-allowed_paths-after-eea] ERROR: Invalid Input Error: Cannot change allowed_paths when enable_external_access is disabled`
- `[set-eea-true-after] ERROR: Invalid Input Error: Cannot enable external access while database is running`

Required order: SET TimeZone, create views, SET allowed_paths, (disabled_filesystems), SET enable_external_access=false, SET lock_configuration=true.

### lock_configuration blocks SET and RESET
- `[SET-after-lock] ERROR: Invalid Input Error: Cannot change configuration option "TimeZone" - the configuration has been locked`
- `[SET-eea-after-lock] ... "enable_external_access" - the configuration has been locked`; `[SET-allowed_paths-after-lock]` same; `[RESET-after-lock] ... "allowed_paths" - the configuration has been locked`.
- Time zone survives lock: `[lock+TZ-effective] [{"tz":"Pacific/Auckland","ty":"TIMESTAMP WITH TIME ZONE"}]`.

### Spilling
- `SET temp_directory=''` on a never-used connection, or `temp_directory:''` as create option, disables spill: `[SET temp_directory='' on fresh (never used) conn] ERROR: Out of Memory Error: could not allocate block of size 256.0 KiB (60.8 MiB/61.0 MiB used)` (64MB memory_limit, big sort). Control with temp dir set succeeds.
- `SET max_temp_directory_size='0B'` also disables: `ERROR: Out of Memory Error: failed to offload data block of size 256.0 KiB (0 bytes/0 bytes used).` Quirk: passing `max_temp_directory_size:'0B'` as a create option did NOT block (`[{"n":"5000000"}]`), so use SET (before lock) for that one.
- `SET temp_directory=''` AFTER the dir was used fails: `Not implemented Error: Cannot switch temporary directory after the current one has been used`. Set it before any query (or as a create option).
- Recommendation: create option `temp_directory:''` plus `SET max_temp_directory_size='0B'` (`[both ''+0B]` -> OOM, i.e. spill disabled). Setting `memory_limit`/`threads` as create options works.

## What the lockdown does and does not block (post-lock, eea=false)
Blocked: reads of non-allowed files, globs (`glob(...)`, `read_ndjson('<dir>/**/*.ndjson')` -> Permission Error even if every match would be allowed), `read_text('/etc/hosts')`, `COPY ... TO`, `ATTACH 'file.db'`, `INSTALL` (`Cannot access directory ".../ext/v1.5.6/osx_arm64"`), `LOAD httpfs` (`Loading external extensions is disabled through configuration`), `EXPORT DATABASE`, http/s3. `getenv` does not exist.
NOT blocked (needs the statementType gate, see below): `[post-lock CREATE VIEW] ok`, `[post-lock CREATE TABLE] ok`, `[post-lock ATTACH] []` (ATTACH ':memory:' succeeds), `PRAGMA database_size` works.
Info leak: `current_setting('allowed_paths')` returns the full absolute file list; `duckdb_views()` lists views; `duckdb_settings()` readable.

## Statement classification
`const e = await connection.extractStatements(sql); e.count; const p = await e.prepare(i); p.statementType` (numeric enum, exported as `StatementType` from the package default export). Enum: 1 SELECT, 2 INSERT, 3 UPDATE, 4 EXPLAIN, 5 DELETE, 6 PREPARE, 7 CREATE, 8 EXECUTE, 9 ALTER, 10 TRANSACTION, 11 COPY, 12 ANALYZE, 13 VARIABLE_SET, 14 CREATE_FUNC, 15 DROP, 16 EXPORT, 17 PRAGMA, 18 VACUUM, 19 CALL, 20 SET, 21 LOAD, 22 RELATION, 23 EXTENSION, 24 LOGICAL_PLAN, 25 ATTACH, 26 DETACH, 27 MULTI, 28 COPY_DATABASE, 29 UPDATE_EXTENSIONS, 30 MERGE_INTO.
Observed (post-lock, views present):
- SELECT -> SELECT; `WITH ... SELECT` -> SELECT; `DESCRIBE v_a`, `DESCRIBE select 1`, `SHOW ALL TABLES`, `SUMMARIZE v`, `TABLE v`, `FROM v`, `UNPIVOT` -> SELECT; `PRAGMA version` -> SELECT; `EXPLAIN` -> EXPLAIN.
- `COPY` -> COPY at parse level, but `prepare` throws Permission Error when it touches a path (post-lock). Pre-lock it is `COPY`(11). `EXPORT DATABASE` -> EXPORT(16) (prepare errors post-lock).
- `ATTACH` -> ATTACH(25); `INSTALL`/`LOAD` -> LOAD(21); `PRAGMA threads=4`, `SET`, `RESET`, `SET VARIABLE`, `USE` -> SET(20); `CHECKPOINT`, `CALL` -> CALL(19); `PREPARE` -> PREPARE(6); `BEGIN`/`ROLLBACK` -> TRANSACTION(10); CREATE VIEW/TABLE -> CREATE(7); DROP -> DROP(15); `with a as (select 1) insert ...` -> INSERT(2); `MERGE` -> MERGE_INTO(30); DETACH -> DETACH(26).
- `PIVOT` becomes count=2: `[stmt-PIVOT] {"count":2,"prepared":["CREATE/undefined","prepare-ERR ..."]}` -> gate on count===1.
- `select 1; select 2` -> count 2. Empty/whitespace/`;`/comment-only -> `extractStatements` throws `Error in native callback` (reject as empty before calling). Syntax error -> throws `Failed to extract statements: Parser Error: ...`.
- Rule: accept only `count===1` and `statementType` in {SELECT, EXPLAIN}. Note `prepare()` of the statement runs the binder, so some rejections come as Permission/Catalog errors instead of a type.

## read_ndjson
- Explicit list works: `read_ndjson(['<abs file>'], hive_partitioning=true, hive_types={'year':'INTEGER','month':'VARCHAR'}, columns={org_id:'VARCHAR',source:'VARCHAR',source_id:'VARCHAR',occurred_at:'TIMESTAMP',payload:'JSON'})` -> `[{"org_id":"00D5j000000AbCdEAK","source":"audit-trail","year":2026,"month":"08","ty":"INTEGER","tm":"VARCHAR","source_id":"x"},...]`.
- Without hive_types: `[{"y":"BIGINT","m":"VARCHAR","month":"08"}]` (month stays VARCHAR because of leading zero; year autocast to BIGINT). With month INTEGER: `"month":8`.
- A `columns={...}` entry that is also a hive key (org_id, source) works, no conflict: `[{"org_id":"00D5...","source":"audit-trail"}]`. Hive columns not in `columns` (year, month) are appended after the declared columns: names `["org_id","source","source_id","occurred_at","payload","month","year"]`, `payload` typed as `VARCHAR` in the column-type report (JSON alias).
- EMPTY LIST is an error, not zero rows: `read_ndjson([]::VARCHAR[], hive_partitioning=true, ${cols})` -> `ERROR: IO Error: read_ndjson needs at least one file to read`; untyped `[]` -> `Binder Error: No function matches ... 'read_ndjson(INTEGER[])'`. A nonexistent glob: `IO Error: No files found that match the pattern`. => For an empty archive/org, do not create the view; create an empty-typed stand-in (e.g. `create view v as select NULL::VARCHAR org_id, ... where false`) with the same column types. `ignore_errors=true` and `format='newline_delimited'` accepted.

## Views are lazy at query time (file contents), eager at CREATE time (file existence)
- `[lazy-before] [{"list_n":"2","glob_n":"2"}]` then after appending lines to a listed file and adding a new file: `[lazy-after-append-and-newfile] [{"list_n":"4","glob_n":"6"}]` (listed view sees appended rows; glob view also sees new files).
- Deleting a listed file after view creation: `[lazy-after-delete-listed-file] ERROR: IO Error: No files found that match the pattern ".../part-lazy.ndjson"` at query time.
- Creating a view over a nonexistent file fails at CREATE: `[view-nonexistent-create] ERROR: IO Error: No files found that match the pattern ".../nope.ndjson"`.
- Views created BEFORE enable_external_access=false still read after lock IF their files are in allowed_paths: `[post-lock view v_a(allowed,hive_types)] [{"source_id":"x","year":2026,"month":"08"},{"source_id":"y","year":2026,"month":"08"}]`. A pre-lock view over a non-allowed file fails at query: `[post-lock view v_b(created pre-lock, file NOT allowed)] ERROR: Permission Error: Cannot access file ".../part-b.ndjson" - file system operations are disabled by configuration`. A glob view fails post-lock (`.../part-*.ndjson` Permission Error), so views must use explicit file lists and allowed_paths must contain every file.

## JSON functions with autoload off
- `[json_keys] [{"k":["Action","DelegateUser"]},{"k":["Action","DelegateUser","n"]}]`
- `[arrow] [{"a":"\"A\"","b":"A","d":null,"n":null},{"a":"\"B\"","b":"B","d":"u1","n":"9007199254740993"}]` (`->` returns JSON (quoted), `->>` returns VARCHAR; `->>'$.n'` preserves a >2^53 integer as a string). `[typeof-arrow] [{"a":"JSON","b":"VARCHAR"}]`. `json_extract_string` works. A JSON null value via `->>` yields SQL NULL.

## Time zone
- `SET TimeZone='Pacific/Auckland'` before lock: `[SET TimeZone] ok`, `[timezone-value] [{"tz":"Pacific/Auckland"}]`.
- `timezone('Pacific/Auckland', occurred_at::TIMESTAMP)` AND `occurred_at::TIMESTAMP AT TIME ZONE 'Pacific/Auckland'` both return TIMESTAMPTZ: `[{"x":"2026-08-14 03:11:09+13","ty":"TIMESTAMP WITH TIME ZONE"},...]` (2026-08-14 02:11:09 is treated as Auckland wall clock, i.e. the instant is 13 hours earlier in UTC; it just re-labels, it does NOT convert). To convert a UTC instant to Auckland wall clock, use `timezone('Pacific/Auckland', occurred_at::TIMESTAMPTZ)` -> TIMESTAMP, or just select a TIMESTAMPTZ (renders in session zone, below). `timezone(tz, timezone(tz, ts))` round-trips to `"2026-08-14 02:11:09"`.
- Caution: `TIMESTAMP '2026-08-14 02:11:09'` (no tz) is the UTC-wall-clock from a `columns` TIMESTAMP; `::TIMESTAMPTZ` interprets it in the session zone, so with session zone Auckland `occurred_at::TIMESTAMPTZ` is `2026-08-14 03:11:09+13` -> wrong instant (off by 13h) if the source is UTC. If values are UTC, declare the column `TIMESTAMPTZ` after `SET TimeZone='UTC'`, or keep the session zone UTC and convert in SELECT. (Design decision for Task 6; this is the verified behaviour.)

## Node API rendering (getRowObjectsJson)
`[post-lock render] [{"b":"9007199254740993","d":1.5,"nan":"NaN","inf":"Infinity","h":"12345678901234567890123","dec":"1.25","ts":"2026-08-14 02:11:09.123456","tstz":"2026-08-14 15:11:09+13","dt":"2026-08-14","tm":"01:02:03","iv":{"months":0,"days":1,"micros":"0"},"n":null,"l":[1,2],"s":{"a":1},"j":"{\"x\":1}","u":"é","i":1,"bo":true,"bl":"\\xAA",...}]`
- BIGINT -> string (precise). HUGEINT -> string. DECIMAL -> string. DOUBLE -> number; NaN/inf -> strings "NaN"/"Infinity". INTEGER -> number.
- TIMESTAMP -> `"YYYY-MM-DD HH:MM:SS[.ffffff]"` (no zone, space separator, no Z). TIMESTAMPTZ -> `"2026-08-14 15:11:09+13"` rendered in the SESSION TimeZone with offset suffix (`+13`, hour-only offset). TIMESTAMP_MS/NS keep fractional digits.
- JSON type -> string of JSON text. INTERVAL -> object. `count(*)` BIGINT -> string `"3"`; `sum(int)` is HUGEINT -> string.
- `getRowObjects()` (non-Json) returns BigInt for BIGINT (`9007199254740993n`) and `{micros: bigint}` for timestamps: not JSON-serialisable, use `getRowObjectsJson()`.
- Result reader API: `columnNames, columnTypes, columnNamesAndTypesJson, getRowObjectsJson, getRowsJson, getColumnsObjectJson, rowsChanged, currentRowCount`.

## ~/.duckdb
- Defaults: `home_directory=""`, `extension_directory=""`, `secret_directory="<HOME>/.duckdb/stored_secrets"` (just a string, `[settings]` row).
- Running instance + simple query + read_ndjson with default settings under a fake HOME created nothing: `[home-contents] []`; real `ls ~/.duckdb` -> `No such file or directory`.
- Redirect all three: create-option or SET (before lock): `[settings-from-create-options] [{"name":"extension_directory","value":"<S>/fh/e"},{"name":"home_directory","value":"<S>/fh/h"},{"name":"secret_directory","value":"<S>/fh/s"}]`. Pass them as `DuckDBInstance.create` options with an empty scratch dir (or a nonexistent path) to guarantee nothing touches `~/.duckdb`. After `enable_external_access=false`, INSTALL/LOAD/secret dirs are denied anyway.
