---
name: wcag-reflow-a11y
description: Enforces WCAG 2.2 AA+ accessibility, 320px / 400% zoom reflow with zero horizontal overflow, keyboard navigation, and screen-reader announcements.
---

# WCAG 2.2 AA+ & Reflow Contract

- **Reflow (WCAG 1.4.10):** Zero horizontal overflow (`scrollWidth <= innerWidth`) at `320px` CSS width (equivalent to `1280px` at 400% zoom). Use `flex-wrap` and `min-w-0` on headers, forms, and toolbars; never truncate essential controls.
- **Contrast & Visibility:** Meet WCAG AA `>= 4.5:1` text contrast (avoid low-contrast grays like `text-slate-400` on light surfaces). Never hide Edit/Delete row actions with `opacity-0` so touch/mobile users can access them.
- **Landmarks & Semantics:** Use `<main>`, `<header>`, `<section>`, `<ul role="list">` / native `<button>`, `<input>`, `<select>`, and explicit `<label htmlFor>` / `aria-label` associations on every control.
- **Keyboard & Focus:**
  - Every action (create, toggle, inline edit, cancel `Escape`, commit `Enter`, delete, filter, undo/redo) works 100% via keyboard.
  - Restore focus logically after deleting an item (next item, previous item, or new-todo input).
  - High-contrast `:focus-visible` outlines (`>= 3:1` contrast).
- **Target Size (WCAG 2.5.8):** All interactive controls meet at least `24x24px` (aim for `44x44px` on touch/reflow viewports).
- **Live Regions & User Preferences:**
  - Announce add, toggle, delete, clear-completed, and undo actions via an `aria-live="polite"` region.
  - Honor `@media (prefers-reduced-motion: reduce)` and `@media (forced-colors: active)`.
