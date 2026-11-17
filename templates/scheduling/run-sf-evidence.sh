#!/usr/bin/env bash
# One scheduled sf-evidence run: collect into a git archive, push it, then report status and
# verify the chain. Every scheduler template in this directory (GitHub Actions, Azure DevOps,
# cron) calls this script, so the exit-code policy below is defined once.
#
# It never provisions anything. The archive must already be a git repository, the org must
# already be authenticated under SF_EVIDENCE_TARGET_ORG, and the plugin must already be
# installed. It only pushes to a remote you configured yourself.
#
# Environment:
#   SF_EVIDENCE_TARGET_ORG  required  sf CLI alias or username of the authenticated org
#   SF_EVIDENCE_ARCHIVE     optional  archive root, a git repository        (default: .)
#   SF_EVIDENCE_SOURCES     optional  comma-separated sources       (default: audit-trail,limits)
#   SF_EVIDENCE_SIGN        optional  "true" to sign each manifest commit   (default: false)
#   SF_EVIDENCE_PUSH        optional  "false" to skip pushing to origin     (default: true)
#   SF_EVIDENCE_BRANCH      optional  branch to push to from a detached HEAD (default: main)
#
# Exit-code policy (the codes are the plugin's, see the README's "Exit codes"):
#   collect 4   FAIL  coverage was reduced today. Data was written and pushed; a human must look.
#   status  3   FAIL  a source is at risk: Salesforce will destroy uncollected data soon.
#   status  4   WARN  a gap not yet at risk, or a stale snapshot. The next run usually repairs it.
#   verify  3   FAIL  chain broken, or the git anchor could not be satisfied.
#   verify  4   WARN  a manifest records a past degradation. verify keeps returning 4 for as
#                     long as that manifest exists, so failing on it would leave the job red
#                     forever. Use `status` to see whether the gap is still open.
#   any     1   FAIL  unexpected error, or nothing archived for the org.
#   push fails  FAIL  the archive did not leave this machine.

set -uo pipefail

org="${SF_EVIDENCE_TARGET_ORG:?set SF_EVIDENCE_TARGET_ORG to the sf alias of the authenticated org}"
archive="${SF_EVIDENCE_ARCHIVE:-.}"
sources="${SF_EVIDENCE_SOURCES:-audit-trail,limits}"
sign="${SF_EVIDENCE_SIGN:-false}"
push="${SF_EVIDENCE_PUSH:-true}"

failed=0
warned=0

report() { # level message
  local level="$1" msg="$2"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::${level}::${msg}"
  elif [[ -n "${TF_BUILD:-}" ]]; then
    echo "##vso[task.logissue type=${level}]${msg}"
  else
    echo "$(echo "$level" | tr a-z A-Z): ${msg}" >&2
  fi
}
fail() { failed=1; report error "$1"; }
group() { if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::group::$1"; else echo "== $1"; fi; }
endgroup() { if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::endgroup::"; fi; }
warn() { warned=1; report warning "$1"; }

if ! git -C "$archive" rev-parse --git-dir >/dev/null 2>&1; then
  fail "$archive is not a git repository. Create it yourself: git -C $archive init -b main"
  exit 1
fi

org_id="$(sf org display --target-org "$org" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).result.id||"")}catch{}})')"
if [[ -z "$org_id" ]]; then
  fail "could not resolve the org id for '$org'. Is it authenticated? Try: sf org display --target-org $org"
  exit 1
fi
echo "org: $org ($org_id)  archive: $archive  sources: $sources"

sign_flags=()
verify_flags=()
if [[ "$sign" == "true" ]]; then
  sign_flags=(--sign)
  verify_flags=(--require-signed)
  # SSH-signed commits read as unverifiable (%G? = N) unless git knows which keys to trust.
  # When the archive signs with SSH and no allowed-signers file is configured, trust the
  # signing key's own public half, so verify can check the commits this run just made.
  if [[ "$(git -C "$archive" config gpg.format)" == "ssh" ]] \
    && [[ -z "$(git -C "$archive" config gpg.ssh.allowedSignersFile)" ]]; then
    key="$(git -C "$archive" config user.signingkey)"
    email="$(git -C "$archive" config user.email)"
    signers="$(git -C "$archive" rev-parse --absolute-git-dir)/allowed_signers"
    pub="$(ssh-keygen -y -f "$key" 2>/dev/null || cat "${key}.pub" 2>/dev/null || true)"
    if [[ -n "$pub" && -n "$email" ]]; then
      echo "$email $pub" > "$signers"
      git -C "$archive" config gpg.ssh.allowedSignersFile "$signers"
    fi
  fi
fi

group collect
sf evidence collect --target-org "$org" --source "$sources" --sink git --archive "$archive" ${sign_flags[@]+"${sign_flags[@]}"}
collect_rc=$?
endgroup
case $collect_rc in
  0) ;;
  4) fail "collect: coverage was reduced on this run (exit 4). Data was written; read the collect output above." ;;
  *) fail "collect exited $collect_rc." ;;
esac

if [[ "$push" != "false" ]] && git -C "$archive" remote get-url origin >/dev/null 2>&1; then
  # A detached HEAD (Azure Pipelines checks out by commit) has no branch name to push to.
  if git -C "$archive" symbolic-ref -q HEAD >/dev/null; then
    refspec=HEAD
  else
    refspec="HEAD:refs/heads/${SF_EVIDENCE_BRANCH:-main}"
  fi
  if ! git -C "$archive" push origin "$refspec"; then
    fail "git push failed: the archive has not left this machine."
  fi
elif [[ "$push" != "false" ]]; then
  warn "no 'origin' remote configured: the archive exists only on this machine."
fi

group status
sf evidence status --org-id "$org_id" --sink git --archive "$archive"
status_rc=$?
endgroup
case $status_rc in
  0) ;;
  3) fail "status: a source is at risk of losing data (exit 3). Collect now, before Salesforce deletes it." ;;
  4) warn "status: a gap or stale source that is not yet at risk (exit 4). See the status output." ;;
  *) fail "status exited $status_rc." ;;
esac

group verify
sf evidence verify --org-id "$org_id" --sink git --archive "$archive" --anchor git ${verify_flags[@]+"${verify_flags[@]}"}
verify_rc=$?
endgroup
case $verify_rc in
  0) ;;
  3) fail "verify: chain broken or git anchor not satisfied (exit 3)." ;;
  4) warn "verify: a manifest records a past degradation (exit 4). This persists by design; check status for open gaps." ;;
  *) fail "verify exited $verify_rc." ;;
esac

if [[ $failed -ne 0 ]]; then
  exit 1
fi
if [[ $warned -ne 0 && -n "${TF_BUILD:-}" ]]; then
  echo "##vso[task.complete result=SucceededWithIssues;]"
fi
exit 0
