#!/usr/bin/env bash
# Packs both workspace packages and checks the CLI tarball depends on the engine by a real
# semver range. A `workspace:` spec left in a published package.json breaks
# `sf plugins install` for every user, and nothing else in the build would notice.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$root"
pnpm --filter @cclabsnz/sf-evidence-engine pack --pack-destination "$tmp" >/dev/null
pnpm --filter @cclabsnz/sf-evidence pack --pack-destination "$tmp" >/dev/null

engine_version="$(node -p "require('./packages/sf-evidence-engine/package.json').version")"
cli_tarball="$(ls "$tmp"/cclabsnz-sf-evidence-[0-9]*.tgz)"
tar -xOf "$cli_tarball" package/package.json > "$tmp/cli-package.json"

node - "$tmp/cli-package.json" "$engine_version" <<'NODE'
const [file, engineVersion] = process.argv.slice(2);
const raw = require('node:fs').readFileSync(file, 'utf8');
if (raw.includes('workspace:')) {
  console.error('packed CLI package.json still contains a workspace: specifier');
  process.exit(1);
}
const range = JSON.parse(raw).dependencies?.['@cclabsnz/sf-evidence-engine'];
if (range !== `^${engineVersion}`) {
  console.error(`expected @cclabsnz/sf-evidence-engine ^${engineVersion}, found ${range}`);
  process.exit(1);
}
NODE

echo "pack ok"
