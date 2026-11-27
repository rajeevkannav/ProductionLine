# Rails 8 + Render Spoke (built by ProductionLine / `mogra` v0.2.0)

Template for a repository where `mogra` grows **one Rails app feature by feature**, one GitHub Issue at a time, and deploys it to **Render**. Reference spoke: [`JumpStart_Pro_Plus`](https://github.com/rajeevkannav/JumpStart_Pro_Plus).

Unlike the TodoMVC+ showcase (one new app per stack under `stacks/<id>/`), this spoke uses `outcome.mode: incremental-feature`: the Rails app lives at the repo root, and each issue becomes a focused change on `mogra/issue-<N>` that goes through the full verification gates before merge.

| Concern | Value |
| :--- | :--- |
| Stack | `rails8-pg-hotwire`: Rails 8 + PostgreSQL + Hotwire + Tailwind CSS v4 + esbuild; Solid Queue/Cache/Cable on Postgres (no Redis) |
| Mobile (optional) | `android-hotwire-native` (`clients/android`, `.apk` artifact), `ios-hotwire-native` (`clients/ios`, Simulator build) |
| Agents | `rails-fullstack-builder`, `mobile-native-builder` |
| Verify job | `verify-rails-pg`: Postgres service, Minitest, RuboCop, Brakeman, bundler-audit, Playwright axe + 320px reflow, Gitleaks, CycloneDX SBOM |
| Deploy | `deployment.target: render`: Render auto-deploys `main`; `mogra` optionally triggers the deploy hook and polls `/up` |

---

## Setup

### 1. Copy the template
Copy everything in this folder (including the dot-files) to the root of the new repository:

- `.mogra.yaml`: set `deployment.render.service_name` (and `region` if not `oregon`). Pick the harness and model under `runtime` / `agents`.
- `.github/workflows/mogra.yml`: the workflow caller. It pins `mogra-sdlc.yml@feat/v0.2.0`; switch both the `uses:` ref and `control_plane_ref` to `v0.2.0` once that tag exists.
- `.github/workflows/codeql.yml`: scans `actions` now; Ruby and JS analysis switches on once those files exist.
- `.github/dependabot.yml`, issue templates (`Target Stack` dropdown read by the router), `SECURITY.md`, `.gitignore`.

Automated PRs may not change `.github/workflows/` or `.mogra.yaml`, so get these right before opening the first issue.

### 2. Repository settings
- **Settings → Actions → General:** Workflow permissions **Read and write**; enable **Allow GitHub Actions to create and approve pull requests**.
- **Settings → General → Pull Requests:** enable **Allow auto-merge** (and *Automatically delete head branches*).
- **Settings → Code security:** enable **Private vulnerability reporting**, Dependabot alerts, secret scanning, and push protection.

```sh
R=<owner>/<repo>
gh api -X PUT repos/$R/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true
gh api -X PATCH repos/$R -F allow_auto_merge=true -F delete_branch_on_merge=true
gh api -X PUT repos/$R/private-vulnerability-reporting
```

### 3. Secrets

| Secret | Needed | Purpose |
| :--- | :--- | :--- |
| `MOGRA_BOT_TOKEN` | Yes | Fine-grained PAT. Its **Repository access must include this repo**, with **Contents, Issues, Pull requests: Read and write** (Metadata: Read). |
| `GEMINI_API_KEY` | Yes (default harness) | `gemini-cli`. Use `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` instead when `.mogra.yaml` selects `claude-code` / `codex`. |
| `RENDER_DEPLOY_HOOK_URL` | Optional | Render deploy hook; `mogra` triggers it after merge. |
| `RENDER_APP_URL` | Optional | e.g. `https://<service>.onrender.com`; `mogra` polls `<url>/up` and comments the live URL. |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` | Mobile only | Signed release `.apk`. Debug `.apk` needs none. |

```sh
gh secret set MOGRA_BOT_TOKEN -R <owner>/<repo>
gh secret set GEMINI_API_KEY -R <owner>/<repo>
```

**About `MOGRA_BOT_TOKEN`:** a repo secret is just a stored copy of the token value. The same token can be stored in several repos, but it only works in a repo that the token's own *Repository access* list includes. An `HTTP 403: Resource not accessible by personal access token` during intake means the stored token cannot write Issues on this repo. The control-plane repo (`ProductionLine`) is only read (public checkout), so the token never needs write access there.

### 4. First issue: the walking skeleton
Open a **Feature** issue with `Target Stack: rails8-pg-hotwire` asking for the Rails 8 skeleton: Postgres, Solid Queue/Cache/Cable, Tailwind, `/up`, `render.yaml` (free web service + free Postgres, `RAILS_MASTER_KEY` with `sync: false`), and an executable `bin/render-build.sh` running `bundle install`, `assets:precompile`, `assets:clean`, `db:prepare`.

### 5. Connect Render (after the skeleton PR merges)
1. Render Dashboard → **New → Blueprint** → select the repository (`render.yaml`).
2. Set `RAILS_MASTER_KEY` on the web service (value of `config/master.key`, which is never committed).
3. Optional: copy the service's **Deploy Hook** URL into `RENDER_DEPLOY_HOOK_URL` and set `RENDER_APP_URL`.

Render free-tier notes (see [`render-free-tier-ops`](../../skills/render-free-tier-ops/SKILL.md)): cold start after ~15 min idle, free Postgres expires after 30 days (keep `db/seeds.rb` idempotent), SMTP ports are blocked (use an HTTP email API).

### 6. Mobile clients (after the web app is live)
Open issues labelled `android` / `ios` (or titled `feat(android): …` / `feat(ios): …`). The router selects the matching Hotwire Native stack, builds under `clients/android` or `clients/ios`, and runs `verify-android-apk` (Ubuntu) or `verify-ios-xcode` (macOS). A signed `.ipa` requires an Apple Developer account.

---

## Re-running an issue
Add the `mogra:run` label (remove it first if it is already there). With `human_in_the_loop.enabled: true`, add `mogra:approved` to let the build proceed.
