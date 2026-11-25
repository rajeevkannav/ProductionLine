---
name: issue-stack-router
description: Resolves the target stack from a GitHub Issue and updates the issue labels, title/metadata block, and run ledger with the stack name.
---

# Issue Stack Router

1. Inspect the incoming GitHub Issue labels (`stack:*`) and template form fields.
2. Fall back to convention default `react19-ts-vite` when no stack is specified.
3. Validate the stack against `mogra.yaml` supported stacks (`react19-ts-vite`, `vue3-ts-vite`, `svelte5-ts-vite`, `angular-ts`, `solid-ts-vite`).
4. Update the GitHub Issue immediately:
   - Apply label `stack:<stack-id>` and `mogra:active`.
   - Upsert the `<!-- mogra:meta -->` header block inside the issue body showing **Blueprint**, **Stack**, **Harness**, and **Mode (Autonomous / HITL)**.
