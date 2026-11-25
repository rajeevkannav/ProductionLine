# Contributing to ProductionLine (`mogra`)

Thank you for helping build **ProductionLine (`mogra`)**!

## Engineering Principles
- **Small, modular files:** Keep scripts, skills, and helpers focused and easy to read.
- **Convention over configuration:** Provide sensible defaults in [`src/conventions.mjs`](src/conventions.mjs) so spoke repos need minimal config.
- **DRY:** Share primitives across harnesses, skills, and workflows rather than duplicating logic.
- **Security & Evidence first:** Never weaken CI/security gates or report unverified test results.

## Local Setup & Checks

Requires **Node.js >= 22**:

```sh
npm run validate
npm test
bash -n scripts/run-agent.sh
```

## Ways to Contribute
1. **Add a Skill:** Create `skills/<skill-name>/SKILL.md` and bind it in [`agents/registry.yaml`](agents/registry.yaml).
2. **Add a Harness / Model Adapter:** Register the adapter in [`src/conventions.mjs`](src/conventions.mjs), [`schemas/mogra.schema.json`](schemas/mogra.schema.json), and [`scripts/run-agent.sh`](scripts/run-agent.sh), then update [`harnesses/README.md`](harnesses/README.md).
3. **Add a Stack Blueprint:** Register the stack in `SUPPORTED_STACKS` and add unit tests in [`tests/mogra.test.mjs`](tests/mogra.test.mjs).

Use Conventional Commits (`feat(...)`, `fix(...)`, `ci(...)`, `docs(...)`) when opening a Pull Request.
