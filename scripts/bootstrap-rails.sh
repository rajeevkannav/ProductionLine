#!/usr/bin/env bash
# Deterministic Rails 8 skeleton for an empty repo-root spoke (rails8-pg-hotwire).
# Runs `rails new` instead of asking the LLM to hand-write framework files; the
# builder agent then layers the issue's changes on top.
#
# Usage: bootstrap-rails.sh <spoke-dir> <app-name> [deploy-target]
set -euo pipefail

SPOKE_DIR="${1:?spoke dir required}"
APP_NAME="${2:?app name required}"
DEPLOY_TARGET="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SPOKE_DIR"

if [ -f config/application.rb ]; then
  echo "[mogra] Rails app already present; skipping bootstrap."
  exit 0
fi

# Rails app names must be valid Ruby constants once camelized.
APP_NAME=$(printf '%s' "$APP_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g; s/^([0-9])/app_\1/')

command -v yarn >/dev/null 2>&1 || npm install -g yarn@1 >/dev/null
gem install rails --no-document -v '~> 8.1'

# --skip keeps existing spoke files (README, SECURITY, .github/*); --skip-ci avoids
# generating .github/workflows/ci.yml, which the protected-path gate would reject.
rails new . \
  --name="$APP_NAME" \
  --database=postgresql \
  --javascript=esbuild \
  --css=tailwind \
  --skip-git \
  --skip-kamal \
  --skip-ci \
  --skip

bundle lock --add-platform x86_64-linux >/dev/null

# Free Postgres (Render, Neon for Railway) gives one DATABASE_URL: run Solid Cache/Queue/Cable on the primary database.
if [ "$DEPLOY_TARGET" = "render" ] || [ "$DEPLOY_TARGET" = "railway" ]; then
  ruby "$SCRIPT_DIR/rails-single-db.rb" .
  bundle exec rubocop -A db/migrate --format quiet || true
fi

# Railway builds the `rails new` Dockerfile; bin/docker-entrypoint runs db:prepare on boot.
if [ "$DEPLOY_TARGET" = "railway" ] && [ ! -f railway.toml ]; then
  cat > railway.toml <<'TOML'
# Railway config-as-code (free plan): build the Rails Dockerfile, check /up, sleep when idle.
# Set the service variable PORT=80 (Thruster's port) plus DATABASE_URL and RAILS_MASTER_KEY.
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/up"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
sleepApplication = true
TOML
fi

for f in bin/rails config/application.rb Gemfile.lock package.json yarn.lock; do
  [ -e "$f" ] || { echo "[mogra] bootstrap failed: missing $f" >&2; exit 1; }
done
echo "[mogra] Rails skeleton bootstrapped as ${APP_NAME}."
