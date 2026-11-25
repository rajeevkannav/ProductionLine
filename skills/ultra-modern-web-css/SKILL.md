---
name: ultra-modern-web-css
description: Applies modern web platform APIs and CSS features (Container Queries, :has(), Subgrid, View Transitions, Popover/Anchor API, OKLCH, light-dark()).
---

# Ultra-Modern Web Platform & CSS

- **Responsive Components:** Use CSS Container Queries (`container-type: inline-size`, `@container`) so task rows and filter bars adapt cleanly inside any layout or 320px viewport.
- **Modern Selectors & Cascade:** Organize styles with `@layer`; use `:has()` for zero-JS parent state styling (e.g., completed or editing task rows) and CSS Grid / Subgrid for aligned counters and actions.
- **Perceptual Color & Adaptive Theming:** Define design tokens in `OKLCH` with `color-mix()` and CSS `light-dark()` supporting system, light, dark, and high-contrast themes.
- **Native UI Primitives:**
  - Use `document.startViewTransition()` for filter switches and item reordering, guarded by `prefers-reduced-motion`.
  - Use native HTML `popover` (and CSS Anchor Positioning with graceful fallback) for keyboard-shortcut help and export/theme menus.
