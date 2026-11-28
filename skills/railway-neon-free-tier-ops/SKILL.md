---
name: railway-neon-free-tier-ops
description: Keeps Rails 8 apps deployable on Railway's free plan with Neon free Postgres (railway.toml + Dockerfile, /up health check, single DATABASE_URL for Solid*, sleep-friendly, never billable).
---

# Railway + Neon Free-Tier Operations Contract

1. **Build & Deploy Config:**
   - Keep `railway.toml` at the repository root: `builder = "DOCKERFILE"`, `healthcheckPath = "/up"`, `sleepApplication = true`. Never add replicas, cron services, volumes, or regions (paid-plan features).
   - Keep the `rails new` `Dockerfile` and `bin/docker-entrypoint` working: `bin/docker-entrypoint` runs `rails db:prepare` before `./bin/thrust ./bin/rails server`. Do not add `render.yaml` or `bin/render-build.sh`.
2. **Database (Neon):**
   - Production reads one `DATABASE_URL` (Neon's direct, non-pooled connection string with `sslmode=require`). Solid Cache, Queue, and Cable tables live in the primary database via `db/migrate`; never reintroduce separate `cache`/`queue`/`cable` databases or `connects_to`.
   - Migrations must be idempotent and safe to run on every boot.
3. **Stay Asleep When Idle:**
   - Do not run anything that polls continuously: no `SOLID_QUEUE_IN_PUMA`, no always-on workers, no frequent recurring jobs. Polling keeps the Railway service and Neon compute awake and burns the free credit.
   - Background work uses `perform_later` only where the feature tolerates delay; prefer inline work for the free tier.
4. **Health & TLS:**
   - `GET /up` returns HTTP `200` quickly. Keep `config.assume_ssl = true` and `config.force_ssl = true` (Railway terminates TLS at its proxy).
   - Outbound SMTP is unreliable on free hosts: use HTTP email APIs (`RESEND_API_KEY`) when present, or a test-mode delivery fallback.
5. **Data Hygiene:**
   - Neon free storage is small (0.5 GB): rate-limit writes and prune demo data.
