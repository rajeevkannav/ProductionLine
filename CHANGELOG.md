# Changelog

All notable changes to **ProductionLine (`mogra`)** are documented in this file.

## [0.2.0] - 2026-11-27

### Added
- Three new stacks: `rails8-pg-hotwire` (Rails 8 + PostgreSQL + Solid Stack + Hotwire + Tailwind CSS v4), `android-hotwire-native` (`clients/android`), and `ios-hotwire-native` (`clients/ios`). Each stack profile now declares `runtime`, `layout`, `verifyProfile`, and `defaultAgent`.
- `outcome.mode: incremental-feature` delivery mode (alongside the default `greenfield-stack`) and `outcome.capabilities` for loading extra skills into a spoke's agents.
- `src/incremental-builder.mjs`: repo-context-aware patch builder with protected-path deletes and stack-specific verify/repair loops (Minitest + RuboCop + Brakeman, Gradle `test lint assembleDebug`, `swift test`).
- Agents `rails-fullstack-builder` and `mobile-native-builder`; skills `rails-multi-tenant-security`, `quantumblack-rails-ui`, `render-free-tier-ops`, and `hotwire-native-mobile`.
- `deployment.target: render | mobile-release` with `deployment.render.{region,health_path,service_name}`; Render deploy hook + `/up` health polling in the deploy job.
- Per-profile verify jobs in `mogra-sdlc.yml`: `verify-node-spa`, `verify-rails-pg` (Postgres service, Brakeman, bundle-audit, CycloneDX Ruby SBOM), `verify-android-apk` (debug APK artifact), `verify-ios-xcode` (macOS runner).
- Issue routing from `android`/`ios` (`mobile:*`) labels and `feat(android)`/`feat(ios)` title prefixes; `plan-agent --stack` picks the stack's default agent.
- `deployment.target: railway` (Railway free plan + Neon free Postgres, no credit card, never billable): `deployment.railway.{health_path,service_name}`, `RAILWAY_APP_URL` health polling in the deploy job, `railway.toml` written by the Rails bootstrap (Dockerfile build, `/up` health check, sleep when idle), and the `railway-neon-free-tier-ops` skill.
- Rails issues can list allowlisted generators under `### Generators` (`authentication`, `model`, `migration`, `controller`, `mailer`, `job`, `channel`, `stimulus`; arguments validated, no shell). mogra runs them before the model, drops generated migrations for tables that already exist, and treats the application files a generator creates as read-only for that run (model edits to them are ignored; generated tests stay editable), so the model builds around known-good code. The spoke-rails feature template gains a Generators field. The route check fails only on missing controllers; missing actions (404) are warnings.
- Sub-issue chains: parent issues labelled `mogra:epic` are never built, sub-issues labelled `mogra:queued` wait when opened, and after a sub-issue merges and deploys the deploy job (`src/sub-issue-chain.mjs`) starts the next open leaf issue in the roadmap -> milestone -> issue tree, closing finished milestone epics and pausing at a milestone without sub-issues.
- One look for every TodoMVC+ stack: the Pages deploy links a shared, framework-neutral light theme (`src/themes/todomvc-qb-light.css`, via `src/pages-theme.mjs`) into each built stack's `index.html`. It replaces the React-only theme that overwrote `react19-ts-vite`'s `src/index.css`, and never edits stack source.
- `templates/spoke-rails/`: Rails 8 spoke template (`.mogra.yaml`, workflow caller, CodeQL, Dependabot, issue templates), defaulting to Railway + Neon, with a setup guide covering secrets, repo settings, Neon/Railway, and mobile clients.

### Changed
- `rails-fullstack-builder` no longer always loads `render-free-tier-ops`; the host skill comes from `outcome.capabilities`. The deploy job's health path is read from the active target (`deployment.<target>.health_path`).
- `verify-and-security` split into the per-profile verify jobs; `deploy-pages` replaced by a unified `deploy` job.
- Incremental-feature issues keep their original title (no `[stack]` suffix); metadata table adds a Delivery / Deploy row when non-default.
- `config.validateConfig` rejects unknown `outcome.mode` and `deployment.target`; `mergeConfig` no longer deep-merges into arrays.
- `yaml-lite` parses block sequences under nested keys (e.g. `outcome.capabilities:` followed by `- item`).
- `run-agent.sh` resolves the working directory from the stack layout (`repo-root`, `subpath`, `stacks/<id>`) and routes incremental runs to the incremental builder.

### Fixed
- Empty `rails8-pg-hotwire` repos are bootstrapped deterministically with `rails new` (`scripts/bootstrap-rails.sh`: PostgreSQL, esbuild, Tailwind, no Kamal/CI files) before the builder agent runs, instead of the model hand-writing framework files.
- Bootstrapped Rails apps encrypt `config/credentials.yml.enc` with the spoke's `RAILS_MASTER_KEY` secret instead of a key generated (and lost) on the runner. The key is passed only to the bootstrap, deleted from the working tree afterwards, and never committed; the bootstrap fails fast when the secret is missing or malformed.
- Rails builder checks and `verify-rails-pg` now fail when `bin/rails` / `config/application.rb` are missing or Minitest reports 0 runs (previously `rails test` outside an app printed `rails new` help and passed). The builder also runs bundler-audit, and yarn-based apps are audited for high-severity advisories.
- Rails changes are rejected (builder loop and `verify-rails-pg`) when a route points at a missing controller or action (`scripts/rails-route-check.rb`), and the builder rejects behaviour changes (controllers, models, jobs, mailers, `lib/`, routes) that come without test changes; view, style and helper changes are covered by the smoke check and UI review instead. Model `Gemfile` edits can only add gems: existing gems and the `gem "rails"` pin are kept even when the model returns a truncated `Gemfile`.
- The Rails builder auto-corrects RuboCop offenses (`rubocop -A`) before checking, instead of spending model repair rounds on style, and allows 6 repair rounds by default (`MOGRA_REPAIR_ROUNDS`).
- Production smoke check (`scripts/rails-production-smoke.rb`, builder loop and `verify-rails-pg`): boots the production configuration, fails when production mail would use SMTP to localhost, and requests every parameterless GET route, failing on any 5xx. Tests only exercise the test environment, so this catches production-only errors (sign-up returned 500 because confirmation mail tried SMTP on localhost:25).
- Issues can limit the model to listed paths under `### Files` (paths or globs; `*` within a folder, `**` across folders); writes and deletes elsewhere are ignored. Keeps small fixes from rewriting working code.
- UI review in `verify-rails-pg` (`scripts/ui-review.mjs`): boots the production app behind a local HTTPS proxy, screenshots every page at 1280px and 320px signed out and signed in (throwaway review account), fails on horizontal overflow at 320px, uploads a `ui-review` artifact, and comments a summary table on the PR. The production smoke check now also fails when the home page's stylesheet or scripts are not served (an env-gated `public_file_server` left the live app unstyled).
- `mckinsey-light-rails-ui` skill: light-only, McKinsey-inspired editorial UI for Rails views (no brand assets); UI skills are now chosen per spoke via `outcome.capabilities`.
- Quality-first free tier for incremental builds: rotate across the stronger Flash models (separate free quotas) and wait out rate limits (30/60/120 s) instead of falling back to Flash-Lite, which repeatedly broke working code; a clear 'quota exhausted, re-run after the reset' error when all are limited. `MOGRA_ALLOW_LITE=1` restores the Lite fallback. Prompts forbid tests on CSS classes or element counts.
- Local builds (`runtime.build: local`): `src/local-runner.mjs build|next` builds an issue on your machine with Claude Code (`src/claude-provider.mjs`: checkpoint, revert disallowed changes, append-only Gemfile, same checks), pushes one commit and opens a PR labelled `mogra:built`; GitHub verifies it (no AI key needed), merges, deploys, and the chain labels the next issue `mogra:next`. Only owner-opened issues and same-repo owner PRs are processed.
- Model output can no longer overwrite lockfiles (`Gemfile.lock`, `yarn.lock`, `package-lock.json`), `db/schema.rb`, or the bootstrap's Solid migration.
- Repair prompts keep the error message: library backtrace frames are dropped and long output keeps head and tail (previously only the last 5,500 characters, which cut off the exception). The Rails check unfreezes the bundle so gems the model adds to the `Gemfile` update `Gemfile.lock`, keeps the existing `gem "rails"` pin, ignores model writes to `.bundle/`, and recreates the test database from the migrations each round (re-dumping `db/schema.rb`, so it cannot drift from the migrations production runs), and prompts note that Minitest 6 has no `stub`/`minitest/mock`.
- Rails spokes deploying to Render or Railway + Neon are bootstrapped for a single `DATABASE_URL` (`scripts/rails-single-db.rb`): Solid Cache/Queue/Cable tables move into a regular migration on the primary database instead of three extra databases the free plan lacks.
- Generated `bin/*` and `*.sh` files are written executable, and `verify-rails-pg` fails before merge if `render.yaml` exists but `bin/render-build.sh` is not executable.
- Ruby version comes from the spoke's `.ruby-version` (else latest 3.4) instead of a pinned 3.4.5 that ubuntu-26.04 runners lack.
- Issue titles already in Conventional Commit form are used as-is for the commit and PR title (no `feat(<stack>): feat(core): ...`).

## [0.1.0] - 2026-11-25

### Added
- Convention-first configuration engine (`mogra.yaml`, `schemas/mogra.schema.json`, `src/conventions.mjs`, `src/config.mjs`).
- GitHub Issue stack router (`src/issue-router.mjs`) supporting `react19-ts-vite`, `vue3-ts-vite`, `svelte5-ts-vite`, `angular-ts`, and `solid-ts-vite`.
- Six SDLC agents (`agents/registry.yaml`) and seven modular `SKILL.md` capability packs covering WCAG 2.2 AA+ `320px` reflow, modern CSS, local-first resilience, OWASP security hardening, Playwright + `axe-core` verification, and evidence-first reporting.
- Pluggable multi-harness runner (`scripts/run-agent.sh`) supporting `gemini-cli` (Free Tier Flash-Lite ready), `antigravity`, `claude-code`, `codex`, `goose`, `openhands`, and `aider`.
- Reusable GitHub Actions workflows (`mogra-sdlc.yml`, `mogra-dispatch.yml`) with least-privilege permissions, protected-path enforcement, Gitleaks CLI secret scanning, CycloneDX SBOM generation, auto-merge, and GitHub Pages deployment.
- Dedicated documentation (`README.md`, `agents/README.md`, `harnesses/README.md`, `skills/README.md`, `templates/spoke/README.md`) with Mermaid architecture and loop diagrams.
