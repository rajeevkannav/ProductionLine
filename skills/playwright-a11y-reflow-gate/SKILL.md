---
name: playwright-a11y-reflow-gate
description: Runs independent Playwright E2E, 320px/400% reflow overflow checks, keyboard-only journeys, cross-tab sync, and axe-core WCAG 2.2 AA gates.
---

# Independent Browser, Reflow & Accessibility Gate

1. **Test Runner Isolation:** Configure `vitest.config.ts` with `exclude: ['e2e/**', 'node_modules/**']` so `npm test` (`vitest run`) never executes Playwright `.spec.ts` files. Use `page.getByRole(...)` / `page.getByLabel(...)` in Playwright (avoid nested double quotes in CSS selectors).
2. **Multi-Viewport Reflow:** Verify `document.documentElement.scrollWidth <= window.innerWidth` across `320x568`, `768x1024`, and `1280x800`.
2. **Axe-Core Zero-Violation Gate:** Run `@axe-core/playwright` with `['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']` across empty, populated, editing, and popover-open states; fail on any violation.
3. **Keyboard-Only E2E:** Complete full TodoMVC CRUD, inline edit, `Escape` cancel, filter switching, clear-completed, and Undo/Redo using only keyboard events.
4. **Cross-Tab Sync:** Open two Playwright pages in the same context and verify changes made in Tab A appear in Tab B via `BroadcastChannel` + persistence.
