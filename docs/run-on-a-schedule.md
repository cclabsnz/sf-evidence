# Run sf-evidence on a schedule, on your own infrastructure

Salesforce deletes Setup Audit Trail after 180 days, so `sf evidence collect` has to run
regularly, not once. This guide sets that up on infrastructure you already control:
GitHub Actions, Azure Pipelines, or a server running cron. Nothing in it touches
CloudCounsel infrastructure. The archive ends up in a git repository you own, with every
manifest committed and pushed.

Plan on about 30 minutes. Most of it is the Salesforce side, which you only do once.

Everything referenced here is in [`templates/scheduling/`](../templates/scheduling):

| File | Purpose |
|---|---|
| `run-sf-evidence.sh` | One run: collect, push, status, verify, with a fixed exit-code policy. Every scheduler calls it. |
| `github-actions/sf-evidence.yml` | GitHub Actions workflow. |
| `azure-devops/azure-pipelines.yml` | Azure Pipelines definition. |
| `salesforce/SF_Evidence_Reader.permissionset-meta.xml` | The three permissions `collect` needs, and nothing else. |
| `archive.gitignore` | Keeps the disposable `_state/` cache out of the archive repository. |

## 1. Salesforce: a read-only integration user

1. **Create a dedicated user** for sf-evidence, so its access is reviewable on its own and
   its API calls are attributable. The *Salesforce Integration* user licence (API only) is
   the natural fit. Check that **View Setup and Configuration** can be assigned under that
   licence in your org. If it can't, use a standard licence with the *Minimum Access* profile.
   <!-- TODO: confirm whether the Salesforce Integration licence allows ViewSetup. -->
2. **Grant only what `collect` needs.** Add
   `SF_Evidence_Reader.permissionset-meta.xml` to an sfdx project under
   `force-app/main/default/permissionsets/`, put it into the org through your normal
   change process, and assign it to the user. It grants **API Enabled**,
   **View Setup and Configuration** and **Monitor Login History**. It does not grant View All Data, Modify All Data or
   Manage Users, and sf-evidence needs none of them. The templates collect
   `audit-trail,login-history,limits`. If you copied a template before 0.3.0, or set
   `SF_EVIDENCE_SOURCES` yourself, add `login-history` to your list and assign the updated
   permission set, or `collect` exits 4 without it. `sf evidence explain` lists every
   query it issues, if your reviewer wants to check.

## 2. Salesforce: an External Client App for JWT bearer auth

A scheduled job can't complete a browser login, so it authenticates with a certificate.

1. Generate a key pair on a trusted machine. The private key never goes to Salesforce.

   ```bash
   openssl req -x509 -sha256 -nodes -days 730 -newkey rsa:2048 \
     -keyout server.key -out server.crt -subj "/CN=sf-evidence"
   ```

2. In Setup → **External Client App Manager**, create a new External Client App. A
   classic connected app with *Use digital signatures* works the same way; the sf CLI's own
   JWT docs still describe that route.
   <!-- TODO: confirm the External Client App labels below against current Salesforce help. -->
   - Enable OAuth. Callback URL: `http://localhost:1717/OauthRedirect` (it is never used by the JWT flow).
   - OAuth scopes: *Manage user data via APIs (api)* and *Perform requests at any time
     (refresh_token, offline_access)*.
   - Enable the **JWT Bearer Flow** and upload `server.crt`.
3. In the app's policies, set permitted users to **Admin approved users are
   pre-authorized**, and add the *SF Evidence Reader* permission set. That way only the
   integration user can use this app.
4. Copy the app's **Consumer Key**. That is `SF_CLIENT_ID` below.
5. Test it once from your machine before you touch a scheduler:

   ```bash
   sf org login jwt --client-id <consumer key> --jwt-key-file server.key \
     --username <integration user> --instance-url https://<your-domain>.my.salesforce.com \
     --alias evidence-org
   sf plugins install @cclabsnz/sf-evidence
   mkdir -p ./sf-evidence-archive
   sf evidence doctor --target-org evidence-org --archive ./sf-evidence-archive
   ```

   `doctor` should report the clock-skew check as `ok`. If `sf org login jwt` fails with
   `user hasn't approved this consumer`, the integration user isn't pre-authorised on the
   app: check the permission set is assigned to both the user and the app.

## 3. An archive repository

Create a **private** repository that holds nothing but the archive. Copy
`run-sf-evidence.sh` to its root and `archive.gitignore` to `.gitignore`, then add the
scheduler file for your platform (below).

Then protect the default branch so history can't be rewritten:
**block force pushes** and **block deletion**. Don't require pull requests on that branch,
because the scheduled job pushes to it directly. The protection is what turns `--anchor git`
from "these commits exist locally" into "rewriting this history needs a force-push the host
records independently". `verify` prints which of those you actually have.

## 4a. GitHub Actions

1. Copy `github-actions/sf-evidence.yml` to `.github/workflows/sf-evidence.yml`.
2. Add repository secrets: `SF_CLIENT_ID`, `SF_USERNAME`, `SF_INSTANCE_URL`, and
   `SF_JWT_KEY` (the full contents of `server.key`).
3. Run the workflow once by hand (**Actions → sf-evidence → Run workflow**). The first run
   backfills the full 180 days Salesforce still holds; later runs add only what is new.

The workflow runs every 6 hours. GitHub may start scheduled runs late under load, which is
harmless: `collect` resumes from the archive's own watermark.

## 4b. Azure Pipelines

1. Commit `azure-devops/azure-pipelines.yml` to the archive repository and create a
   pipeline from it.
2. Under **Pipelines → Library**, create a variable group named `sf-evidence` with
   `SF_CLIENT_ID`, `SF_USERNAME` and `SF_INSTANCE_URL`, and upload `server.key` as a secure
   file named `sf-evidence-server.key`. Authorise the pipeline to use both.
3. Give the project's *Build Service* identity **Contribute** on the archive repository, so
   the pipeline can push.

## 4c. Cron on your own server

Log in once as the user cron runs as (`sf org login jwt ...` as in step 2.5, or
`sf org login web`). The sf CLI keeps the auth. Clone the archive repository, then:

```cron
17 */6 * * *  cd /srv/sf-evidence-archive && SF_EVIDENCE_TARGET_ORG=evidence-org PATH=/usr/local/bin:/usr/bin:/bin bash ./run-sf-evidence.sh >> /var/log/sf-evidence.log 2>&1
```

Cron doesn't alert anyone. Point your existing monitoring at the exit code or the log,
because a job that stopped running looks the same as one that never started.

## What the job's result means

The run fails, and so turns your CI red, only when someone needs to act:

| Result | Cause | What to do |
|---|---|---|
| **Fails** | `collect` exit 4: this run reduced coverage (for example, a query slice timed out). | Read the collect output. The data that was collected was still committed and pushed. The next run retries the gap. |
| **Fails** | `status` exit 3: a source is **at risk**, so Salesforce will delete uncollected data soon. | Fix the cause and run it now. This is the alert the whole tool exists for. |
| **Fails** | `verify` exit 3: chain broken or git anchor not satisfied. | Treat as a possible integrity incident. Don't "fix" it by rewriting the archive. |
| **Fails** | `git push` failed, or any command exited 1. | Usually credentials or branch protection. The archive exists only on the runner until a push succeeds. |
| Warning | `status` exit 4: a gap not yet at risk, or a stale `limits` sample. | Usually repaired by the next run. Watch for it repeating. |
| Warning | `verify` exit 4: a manifest records a past degradation. | Expected after any degraded run. `verify` reports it for as long as that manifest exists, so it never fails the job. `status` tells you whether the gap is still open. |

## Signing the manifest commits (recommended)

Unsigned commits prove only that the manifests exist in this history. Signed commits on a
protected branch prove that the holder of the key wrote them. To sign on GitHub Actions:

```bash
ssh-keygen -t ed25519 -N "" -C "sf-evidence" -f sf-evidence-signing
```

Decide before the first run. `verify --require-signed` fails on every unsigned manifest
commit, including ones made before you turned signing on, and those commits can't be signed
afterwards without rewriting the history the anchor depends on. If you start unsigned and
switch later, leave `SF_EVIDENCE_SIGN` off for verification, or start a new archive.

Add the private key as the repository secret `SF_EVIDENCE_SIGNING_KEY`. The workflow then
signs every commit and runs `verify --require-signed`. Keep the public half somewhere your
auditor can get it. On other schedulers, set `SF_EVIDENCE_SIGN=true` and configure git
signing (`gpg.format`, `user.signingkey`) in the archive repository yourself.

## Upgrading

The templates pin the plugin version (`SF_EVIDENCE_VERSION`). Upgrade deliberately: read
the changelog, bump the pin, and run the job once by hand.

The templates install only `@cclabsnz/sf-evidence`, by design: a job that collects has no
use for `sf evidence query`, and leaving the query plugin out means it never downloads
DuckDB. Install the query plugin where you read the archive ([`query.md`](query.md)).
