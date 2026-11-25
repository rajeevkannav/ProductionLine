# Changelog

All notable changes to **ProductionLine (`mogra`)** are documented in this file.

## [0.1.0] - 2026-11-25

### Added
- Convention-first configuration engine (`mogra.yaml`, `schemas/mogra.schema.json`, `src/conventions.mjs`, `src/config.mjs`).
- GitHub Issue stack router (`src/issue-router.mjs`) supporting `react19-ts-vite`, `vue3-ts-vite`, `svelte5-ts-vite`, `angular-ts`, and `solid-ts-vite`.
- Six SDLC agents (`agents/registry.yaml`) and seven modular `SKILL.md` capability packs covering WCAG 2.2 AA+ `320px` reflow, modern CSS, local-first resilience, OWASP security hardening, Playwright + `axe-core` verification, and evidence-first reporting.
- Pluggable multi-harness runner (`scripts/run-agent.sh`) supporting `gemini-cli` (Free Tier Flash-Lite ready), `antigravity`, `claude-code`, `codex`, `goose`, `openhands`, and `aider`.
- Reusable GitHub Actions workflows (`mogra-sdlc.yml`, `mogra-dispatch.yml`) with least-privilege permissions, protected-path enforcement, Gitleaks CLI secret scanning, CycloneDX SBOM generation, auto-merge, and GitHub Pages deployment.
- Dedicated documentation (`README.md`, `agents/README.md`, `harnesses/README.md`, `skills/README.md`, `templates/spoke/README.md`) with Mermaid architecture and loop diagrams.
