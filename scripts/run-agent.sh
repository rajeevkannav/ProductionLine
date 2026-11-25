#!/usr/bin/env bash
set -euo pipefail

SPOKE_DIR="${1:?spoke dir required}"
PLAN_JSON="${2:?plan json required}"
ISSUE_NUMBER="${3:?issue number required}"
STACK="${4:-react19-ts-vite}"
ISSUE_FILE="${5:-}"

HARNESS=$(jq -r '.harness' "$PLAN_JSON")
MODEL=$(jq -r '.model' "$PLAN_JSON")
BIN=$(jq -r '.bin' "$PLAN_JSON")
ENV_KEY=$(jq -r '.envKey // empty' "$PLAN_JSON")
export PROMPT_FILE="/tmp/mogra-prompt-${ISSUE_NUMBER}.md"
export MOGRA_MODEL="$MODEL"

{
  echo "# ProductionLine (mogra) Build Assignment — Issue #${ISSUE_NUMBER}"
  echo "- Target Stack: \`${STACK}\`"
  echo "- Goal: $(jq -r '.goal' "$PLAN_JSON")"
  echo ""
  if [ -n "$ISSUE_FILE" ] && [ -f "$ISSUE_FILE" ]; then
    echo "## GitHub Issue Specification"
    cat "$ISSUE_FILE"
    echo ""
  fi
  echo "## Required ProductionLine Skills & Acceptance Contracts"
  jq -r '.skillPaths[]' "$PLAN_JSON" | while read -r skill_path; do
    if [ -f "$skill_path" ]; then
      cat "$skill_path"
      echo ""
    fi
  done
  echo "## Execution Rules"
  echo "- Build the '${STACK}' TodoMVC+ app inside '${SPOKE_DIR}/stacks/${STACK}'."
  echo "- Include complete package.json scripts: typecheck, lint, test, build, and Playwright + @axe-core/playwright 320px reflow tests (test:e2e)."
  echo "- Configure base path dynamically via process.env.VITE_BASE_PATH || '/'."
  echo "- Never modify .github/workflows/, .mogra.yaml, or other stacks under stacks/."
} > "$PROMPT_FILE"

if [ -n "$ENV_KEY" ] && [ -z "${!ENV_KEY:-}" ]; then
  echo "Missing required secret env var: ${ENV_KEY} for harness '${HARNESS}' (${MODEL})." >&2
  exit 1
fi

run_gemini_cli() {
  local target_model="$1"
  export GEMINI_CLI_TRUST_WORKSPACE=true
  if command -v gemini >/dev/null 2>&1; then
    gemini -m "$target_model" --yolo --skip-trust -p "$(cat "$PROMPT_FILE")"
  else
    npx -y @google/gemini-cli -m "$target_model" --yolo --skip-trust -p "$(cat "$PROMPT_FILE")"
  fi
}

mkdir -p "${SPOKE_DIR}/stacks/${STACK}"
echo "Running harness=${HARNESS} model=${MODEL} stack=${STACK} workdir=${SPOKE_DIR}/stacks/${STACK}"
cd "${SPOKE_DIR}/stacks/${STACK}"

case "$HARNESS" in
  antigravity)
    python3 -m pip install --quiet --upgrade google-antigravity
    if ! timeout 240s python3 -u -c "
import asyncio, inspect, os, pathlib, sys
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

prompt = pathlib.Path(os.environ['PROMPT_FILE']).read_text()
kwargs = dict(
    system_instructions='You are ProductionLine (mogra) frontend-builder. Implement everything completely in the current working directory, run tests locally, and satisfy every attached skill.',
    capabilities=CapabilitiesConfig(),
)
sig = inspect.signature(LocalAgentConfig)
if 'model' in sig.parameters:
    kwargs['model'] = os.environ['MOGRA_MODEL']

async def main():
    cfg = LocalAgentConfig(**kwargs)
    async with Agent(cfg) as agent:
        res = await agent.chat(prompt)
        async for token in res:
            sys.stdout.write(token)
            sys.stdout.flush()
        print(flush=True)
asyncio.run(main())
"; then
      echo "[mogra] antigravity failed or timed out; falling back to gemini-cli (gemini-3.8-flash)." >&2
      run_gemini_cli "gemini-3.8-flash"
    fi
    ;;
  gemini-cli)
    run_gemini_cli "$MODEL"
    ;;
  claude-code|codex|goose|openhands|aider)
    if ! command -v "$BIN" >/dev/null 2>&1; then
      echo "Harness CLI '${BIN}' is not installed on runner." >&2
      exit 1
    fi
    mapfile -t ARGS < <(jq -r '.args[]' "$PLAN_JSON")
    "$BIN" "${ARGS[@]}"
    ;;
  *)
    echo "Unsupported harness: ${HARNESS}" >&2
    exit 1
    ;;
esac
