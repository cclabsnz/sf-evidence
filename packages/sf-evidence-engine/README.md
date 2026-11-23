# @cclabsnz/sf-evidence-engine

The library behind [`sf evidence`](https://www.npmjs.com/package/@cclabsnz/sf-evidence): collectors for Salesforce audit data (Setup Audit Trail, Login History and org limits),
canonicalisation and hashing, manifests and the hash chain, the `local` and `git` sinks, the
archive reader, and the collect pipeline. It's everything in sf-evidence that doesn't need the
`sf` CLI.

Use it when you want to collect or verify sf-evidence archives somewhere the `sf` CLI doesn't
run, such as a scheduled function. If you only read or verify archives, the
`@cclabsnz/sf-evidence` package re-exports the read-only subset and is the more stable
surface to depend on.

It has one runtime dependency, [`@cclabsnz/sf-core`](https://www.npmjs.com/package/@cclabsnz/sf-core),
for its read-only Salesforce client interfaces. You supply an implementation of `SoqlClient`;
the engine never opens a connection itself. A test fails the build if the engine depends on,
or imports, oclif or `@salesforce/core`.

Archives written through the engine are byte-identical to archives written by the CLI, and
`sf evidence verify` checks both the same way. Component boundaries and the archive format
are specified in the sf-evidence specification (§3.1 and §5).

It also holds the query views as data (`VIEWS`), their compilation to DuckDB SQL, and the
list of chain-covered record files a query may read. It has no DuckDB dependency itself:
[`@cclabsnz/sf-evidence-query`](https://www.npmjs.com/package/@cclabsnz/sf-evidence-query)
runs the SQL.

`@cclabsnz/sf-evidence-engine/testing` exports the specification's test vectors, which were
computed independently of this implementation. `@cclabsnz/sf-evidence-engine/testing/query`
writes the small fixture archive the query tests use.

## License

Apache-2.0
