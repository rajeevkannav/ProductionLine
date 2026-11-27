---
name: ultra-modern-web-css
description: Applies modern web platform APIs and CSS features (Container Queries, :has(), Subgrid, View Transitions, Popover/Anchor API, OKLCH, light-dark()).
---

# Ultra-Modern Web Platform & CSS

- **QuantumBlack Design Language Tokens:**
  - **Typography:** Load `Inter` (`400`, `500`, `600`, `700`) for UI & tight display headings (`letter-spacing: -0.025em`) paired with `JetBrains Mono` (`400`, `500`, `font-variant-numeric: tabular-nums`) for technical counters, IDs, timings, and metadata.
  - **Dark-First Obsidian & Light Mist Surfaces:** Default to dark obsidian surfaces (`--bg-canvas: oklch(12.9% 0.042 264.695)` / `#090d16`, `--bg-surface: oklch(20.8% 0.042 265.755)`, hairline border `oklch(100% 0 0 / 0.10)`) and support crisp light `Mist` mode (`--bg-canvas: oklch(98.5% 0.004 248)`, `--bg-surface: oklch(100% 0 0)`, border `oklch(12.9% 0.042 264.695 / 0.12)`).
  - **Semantic Accents & Accessible Contrast:** Use QuantumBlack `teal-400` (`oklch(77.7% 0.152 181.912)`) / `teal-700` on light, `sky-400/500`, `green-400/700`, `amber-400/700`, and `rose-400/600` for semantic statuses while maintaining WCAG AA `>= 4.5:1` contrast in both themes.
- **Responsive Components:** Use CSS Container Queries (`container-type: inline-size`, `@container`) so task rows and filter bars adapt cleanly inside any layout or 320px viewport.
- **Modern Selectors & Cascade:** Organize styles with `@layer`; use `:has()` for zero-JS parent state styling (e.g., completed or editing task rows) and CSS Grid / Subgrid for aligned counters and actions.
- **Perceptual Color & Adaptive Theming:** Define design tokens in `OKLCH` with `color-mix()` and CSS `light-dark()` supporting system, light, dark, and high-contrast themes.
- **Native UI Primitives:**
  - Use `document.startViewTransition()` for filter switches and item reordering, guarded by `prefers-reduced-motion`.
  - Use native HTML `popover` (and CSS Anchor Positioning with graceful fallback) for keyboard-shortcut help and export/theme menus.
