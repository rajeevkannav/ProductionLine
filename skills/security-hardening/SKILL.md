---
name: security-hardening
description: Enforces OWASP frontend security, strict input sanitization, secret hygiene, supply-chain integrity, and protected CI boundary rules.
---

# Security & Vulnerability Hardening

1. **Zero Unsafe DOM Execution:** Never use `eval()`, `new Function()`, `dangerouslySetInnerHTML`, `v-html`, or unsanitized `[innerHTML]` bindings.
2. **Safe Persistence & JSON Import:** Validate imported JSON with strict schema/type guards and strip `__proto__`, `constructor`, and `prototype` keys to prevent prototype pollution.
3. **CSP & External Links:** Keep inline scripts out of `index.html`, apply strict Content-Security-Policy meta/headers where applicable, and set `rel="noopener noreferrer"` on external links.
4. **Secret Hygiene:** Never commit `.env` files, API keys, or tokens; read runtime credentials strictly from CI environment variables.
5. **Immutable Verification Boundary:** Builder agents must never alter `.github/workflows/`, `.mogra.yaml` security gates, or weaken test assertions.
