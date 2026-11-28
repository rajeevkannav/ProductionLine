---
name: mckinsey-light-rails-ui
description: Light-only, McKinsey-inspired editorial UI for Rails ERB + Tailwind CSS v4 views (deep-blue ink on white, electric-blue actions, serif headlines, hairline rules, square corners), applied consistently to every screen.
---

# McKinsey-Inspired Light UI (Rails + Hotwire + Tailwind v4)

A clean, editorial, consulting-style look: lots of white space, confident typography, one strong action colour. **Light mode only.** It is inspired by that visual language; it must never copy brand assets.

1. **Brand guard:**
   - Never use McKinsey or QuantumBlack names, logos, wordmarks, or proprietary typefaces (Bower, McKinsey Sans). The product name is the app's own ("JumpStart Pro Plus").
2. **Light only:**
   - `color-scheme: light` on `:root`; no `dark:` classes, no `light-dark()`, no `prefers-color-scheme: dark` styles, no theme switcher.
3. **Tokens** (define once in `app/assets/stylesheets/application.tailwind.css` under `@theme` and use them everywhere; no ad-hoc colours):
   - `--color-ink: #051c2c` (deep blue: headings, primary text, top bar background)
   - `--color-action: #2251ff` (electric blue: primary buttons, links, focus rings)
   - `--color-action-hover: #1a3fcc`
   - `--color-accent: #00a9f4` (cyan: thin decorative rules and highlights only; never text)
   - `--color-paper: #ffffff` (page), `--color-mist: #f5f7f9` (subtle sections), `--color-rule: #d9dee3` (hairlines)
   - `--color-muted: #4b5a66` (secondary text, >= 4.5:1 on white)
   - Status: success `#0b7a3e`, warning `#8a5a00` on `#fff7e0`, danger `#c4161c`; text in these colours must stay >= 4.5:1.
4. **Typography** (system fonts only, no external font loading):
   - Headlines: serif stack `Georgia, "Times New Roman", serif`, regular weight, tight leading, sentence case (e.g. `h1` 2.25rem/2.75rem desktop, 1.75rem at 320px).
   - Body and UI: `"Helvetica Neue", Arial, system-ui, sans-serif`, 1rem/1.6, colour `ink`.
   - Eyebrow labels: 0.75rem, uppercase, letter-spacing 0.08em, colour `muted`.
5. **Layout & components:**
   - App shell on every page: a deep-blue (`ink`) top bar with the product name in white serif, nav links in white, and the signed-in email + "Sign out" on the right; content in a centred column (`max-w-5xl`, generous `px-6 py-12`); a simple footer with a 1px `rule` top border.
   - Forms: one column, `max-w-md`, labels above inputs, inputs with a 1px `rule` border, square corners (`rounded-none`), 44px minimum height, visible 2px `action` focus ring; error summary at the top linked to fields.
   - Buttons: primary = solid `action` with white text, square corners, no shadow; secondary = 1px `ink` outline; destructive = `danger`. Text links in `action`, underlined on hover.
   - Flash messages and banners: white or `mist` background with a 4px left border in the status colour; never full-colour blocks.
   - Cards/sections: separated by whitespace and 1px `rule` lines; no drop shadows, gradients, or rounded "bubbly" shapes; at most `rounded-sm`.
6. **Accessibility & reflow:**
   - WCAG 2.2 AA: text contrast >= 4.5:1, focus always visible, one `<main>` landmark, labelled controls, `lang` on `<html>`.
   - Every page reflows at 320px with no horizontal scrolling (`scrollWidth <= innerWidth`); the top bar wraps or collapses nav into a simple menu.
   - Hide web chrome (top bar, footer) when `turbo_native_app?` is true so Hotwire Native apps show native headers.
7. **Consistency:**
   - New screens reuse the shared layout and partials (`app/views/shared/_flash`, form field partials) instead of restyling locally; check that sign-in, sign-up, password reset and settings pages look like one product.
8. **Assets in production:**
   - Leave `config.public_file_server.enabled` at the Rails 8 default (on); never gate it on an env var such as `RAILS_SERVE_STATIC_FILES`, or `/assets` 404s and every page renders unstyled.
