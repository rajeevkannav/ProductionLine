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
- `templates/spoke-rails/`: Rails 8 + Render spoke template (`.mogra.yaml`, workflow caller, CodeQL, Dependabot, issue templates) with a setup guide covering secrets, repo settings, Render Blueprint, and mobile clients.

### Changed
- `verify-and-security` split into the per-profile verify jobs; `deploy-pages` replaced by a unified `deploy` job.
- Incremental-feature issues keep their original title (no `[stack]` suffix); metadata table adds a Delivery / Deploy row when non-default.
- `config.validateConfig` rejects unknown `outcome.mode` and `deployment.target`; `mergeConfig` no longer deep-merges into arrays.
- `yaml-lite` parses block sequences under nested keys (e.g. `outcome.capabilities:` followed by `- item`).
- `run-agent.sh` resolves the working directory from the stack layout (`repo-root`, `subpath`, `stacks/<id>`) and routes incremental runs to the incremental builder.

### Fixed
- Empty `rails8-pg-hotwire` repos are bootstrapped deterministically with `rails new` (`scripts/bootstrap-rails.sh`: PostgreSQL, esbuild, Tailwind, no Kamal/CI files) before the builder agent runs, instead of the model hand-writing framework files.
- Rails builder checks and `verify-rails-pg` now fail when `bin/rails` / `config/application.rb` are missing or Minitest reports 0 runs (previously `rails test` outside an app printed `rails new` help and passed). The builder also runs bundler-audit, and yarn-based apps are audited for high-severity advisories.
- Model output can no longer overwrite lockfiles (`Gemfile.lock`, `yarn.lock`, `package-lock.json`).
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
