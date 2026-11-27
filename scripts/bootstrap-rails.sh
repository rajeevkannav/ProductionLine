#!/usr/bin/env bash
# Deterministic Rails 8 skeleton for an empty repo-root spoke (rails8-pg-hotwire).
# Runs `rails new` instead of asking the LLM to hand-write framework files; the
# builder agent then layers the issue's changes on top.
#
# Usage: bootstrap-rails.sh <spoke-dir> <app-name>
set -euo pipefail

SPOKE_DIR="${1:?spoke dir required}"
APP_NAME="${2:?app name required}"

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

for f in bin/rails config/application.rb Gemfile.lock package.json yarn.lock; do
  [ -e "$f" ] || { echo "[mogra] bootstrap failed: missing $f" >&2; exit 1; }
done
echo "[mogra] Rails skeleton bootstrapped as ${APP_NAME}."
