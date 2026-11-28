---
name: render-free-tier-ops
description: Enforces Render Free Tier compatibility for Rails 8 apps (render.yaml Blueprint, bin/render-build.sh, /up health check, Solid* on Postgres, TLS proxy headers, and blocked SMTP handling).
---

# Render Free-Tier Operations Contract

1. **Blueprint & Build Script:**
   - Maintain `render.yaml` (`region: oregon`, `plan: free` web service + `plan: free` PostgreSQL) and executable `bin/render-build.sh` running `bundle install`, `rails assets:precompile`, `rails assets:clean`, `rails db:prepare` / `rails db:migrate`, and idempotent demo seeding.
2. **Health & TLS:**
   - Keep `GET /up` returning HTTP `200` with fast DB check.
   - Configure `config.assume_ssl = true` and `config.force_ssl = true` in `config/environments/production.rb` for Render's TLS-terminating proxy.
3. **Free-Tier Constraints:**
   - Render blocks outbound SMTP ports: use HTTP email APIs (`RESEND_API_KEY`) when present, or a safe test-mode delivery fallback when `DEMO_MODE=true` and no email key is set.
   - Keep `WEB_CONCURRENCY` conservative (e.g. `1` or `2` within 512 MB free RAM) and run Solid Queue inside Puma (`SOLID_QUEUE_IN_PUMA=true`) on free tier so no paid background worker is required.
4. **Demo Data Retention:**
   - Guard against the 1 GB Postgres cap with rate limiting and scheduled `DemoDataCleanupJob` pruning.
