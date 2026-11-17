# Changelog

## 0.1.0 (unreleased)

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
