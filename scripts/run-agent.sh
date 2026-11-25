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

mkdir -p "${SPOKE_DIR}/stacks/${STACK}"
echo "Running harness=${HARNESS} model=${MODEL} stack=${STACK} workdir=${SPOKE_DIR}/stacks/${STACK}"
cd "${SPOKE_DIR}/stacks/${STACK}"

case "$HARNESS" in
  antigravity)
    python3 -m pip install --quiet --upgrade google-antigravity
    python3 -c "
import asyncio, os, pathlib, sys
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

prompt = pathlib.Path(os.environ['PROMPT_FILE']).read_text()
async def main():
    cfg = LocalAgentConfig(
        system_instructions='You are ProductionLine (mogra) frontend-builder. Implement everything completely, run tests locally, and satisfy every attached skill.',
        capabilities=CapabilitiesConfig(),
    )
    async with Agent(cfg) as agent:
        res = await agent.chat(prompt)
        async for token in res:
            sys.stdout.write(token)
        print()
asyncio.run(main())
"
    ;;
  gemini-cli)
    if command -v gemini >/dev/null 2>&1; then
      gemini -m "$MODEL" --yolo -p "$(cat "$PROMPT_FILE")"
    else
      npx -y @google/gemini-cli -m "$MODEL" --yolo -p "$(cat "$PROMPT_FILE")"
    fi
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
