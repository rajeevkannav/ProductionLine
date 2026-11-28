---
name: quantumblack-rails-ui
description: Enforces the QuantumBlack Design Language (Obsidian dark + Mist light OKLCH tokens, Inter/JetBrains Mono, Tailwind CSS v4, Hotwire Turbo/Stimulus) across Rails ERB views.
---

# QuantumBlack Rails + Hotwire Design System

1. **Tokens & Dual Themes:**
   - Default to QuantumBlack **Obsidian** dark (`--qb-canvas: #090d16`, `--qb-surface: #111827`, hairline `rgba(255,255,255,0.10)`, accent `teal-400`) and support crisp **Mist** light mode (`--qb-canvas: #f8fafc`, `--qb-surface: #ffffff`, accent `teal-700` `#0f766e`).
   - Pair `Inter` (UI & tight headings) with `JetBrains Mono` (`tabular-nums`) for pricing, API tokens, job IDs, and timestamps.
2. **Contrast & Semantics:**
   - Meet WCAG 2.2 AA `>= 4.5:1` contrast in both light and dark modes (never use `text-slate-400` on light surfaces; use `text-slate-600`/`text-slate-700` and `dark:text-slate-300`).
   - Use semantic status colors consistently: `teal` (primary CTA), `sky` (info), `green` (active/paid), `amber` (trial/pending), `rose` (destructive/error).
3. **Reflow & Hotwire Native Compatibility:**
   - All layouts (navbar, account switcher, billing tables, forms, Madmin/admin panels) must reflow cleanly at `320px` width with zero horizontal overflow (`scrollWidth <= innerWidth`).
   - Hide web-chrome navigation cleanly when `turbo_native_app?` is true so Android and iOS Hotwire Native WebViews render native headers seamlessly.
