---
name: rails-multi-tenant-security
description: Enforces Rails 8 authentication, multi-tenant Account/Current.account scoping, sudo mode, Solid Stack, Minitest coverage, and Brakeman security hygiene.
---

# Rails 8 Multi-Tenant SaaS & Security Contract

1. **Multi-Tenancy & IDOR Prevention:**
   - Every tenant-owned model MUST `belongs_to :account` and be queried through `Current.account` (or `ActsAsTenant` scoped to `Current.account`), NEVER unscoped `Model.find(params[:id])`.
   - Write Minitest integration tests proving Account A cannot read, update, or delete Account B records.
2. **Authentication & Sudo Mode:**
   - Use Rails 8 DB-backed `Session` cookies (`httponly`, `secure` in production, `SameSite=Lax`) and Bearer `ApiToken` (stored hashed via `has_secure_token` / digest) for `/api/v1/*`.
   - Protect sensitive flows (email change, 2FA, API token creation, account deletion, ownership transfer) behind `sudo` mode verification and Rails `rate_limit`.
3. **XSS, SQLi & Mass Assignment:**
   - Never use `.html_safe`, `.raw`, string-interpolated SQL (`where("... #{...}")`), `eval`, or `params.permit!`. Always use strong parameters and ERB auto-escaping.
4. **Solid Stack & Render Free-Tier Data Hygiene:**
   - Use **Solid Queue**, **Solid Cache**, and **Solid Cable** backed by PostgreSQL (`config/queue.yml`, `config/cache.yml`, `config/cable.yml`).
   - Protect against 1 GB free-tier DB bloat via `DemoDataCleanupJob` recurring TTL cleanup (`config/recurring.yml`) when `DEMO_MODE=true`.
5. **Testing & Static Analysis:**
   - Use **Minitest** (`test/models/`, `test/controllers/`, `test/integration/`, `test/system/`) with deterministic fixtures.
   - Keep `bundle exec rubocop` and `bundle exec brakeman -q --no-pager` passing with zero warnings.
   - Rails 8 `rate_limit` counts requests in `Rails.cache`, and `config/environments/test.rb` uses `:null_store` by default, so limits never trigger in tests. To test rate limits, set `config.cache_store = :memory_store` in the test environment (or pass `store: ActiveSupport::Cache::MemoryStore.new` to `rate_limit`) and call `Rails.cache.clear` in `setup`.
   - `rate_limit` requires `to:` and `within:`; over the limit it responds `429` by default unless `with:` is given.
