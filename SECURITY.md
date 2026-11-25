# Security Policy

## Supported Versions

Only the latest `main` branch of **ProductionLine (`mogra`)** receives security updates.

## Reporting a Vulnerability

Do **not** open a public GitHub Issue for security vulnerabilities, leaked tokens, or CI privilege-escalation bugs.

Instead:
1. Use GitHub **Private Vulnerability Reporting** (Security Advisories) on this repository.
2. Include reproduction steps, affected workflow/file paths, and potential impact.

## Built-in Factory Safeguards

- Least-privilege per-job `permissions` on all GitHub Actions workflows.
- Untrusted GitHub Issue fields are always bound via `env:` variables (never interpolated inside `run:` shell commands).
- Protected-path checks fail any automated PR attempting to modify `.github/workflows/` or `.mogra.yaml`.
- Mandatory secret scanning, `npm audit`, and CycloneDX SBOM generation on PR verification.
