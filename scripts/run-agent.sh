#!/usr/bin/env bash
set -euo pipefail

SPOKE_DIR="${1:?spoke dir required}"
PLAN_JSON="${2:?plan json required}"
ISSUE_NUMBER="${3:?issue number required}"

HARNESS=$(jq -r '.harness' "$PLAN_JSON")
MODEL=$(jq -r '.model' "$PLAN_JSON")
BIN=$(jq -r '.bin' "$PLAN_JSON")
ENV_KEY=$(jq -r '.envKey // empty' "$PLAN_JSON")
export PROMPT_FILE="/tmp/mogra-prompt-${ISSUE_NUMBER}.md"

{
  echo "# ProductionLine (mogra) Task — Issue #${ISSUE_NUMBER}"
  echo "Goal: $(jq -r '.goal' "$PLAN_JSON")"
  echo ""
  echo "## Required Skills"
  jq -r '.skillPaths[]' "$PLAN_JSON" | while read -r skill_path; do
    if [ -f "$skill_path" ]; then
      cat "$skill_path"
      echo ""
    fi
  done
} > "$PROMPT_FILE"

if [ -n "$ENV_KEY" ] && [ -z "${!ENV_KEY:-}" ]; then
  echo "Missing required secret env var: ${ENV_KEY} for harness '${HARNESS}' (${MODEL})." >&2
  exit 1
fi

echo "Configured harness=${HARNESS} bin=${BIN} model=${MODEL} prompt=${PROMPT_FILE} workdir=${SPOKE_DIR}"
cd "$SPOKE_DIR"

case "$HARNESS" in
  antigravity)
    python3 -m pip install --quiet google-antigravity
    python3 -c "
import asyncio, os, pathlib
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
prompt = pathlib.Path(os.environ['PROMPT_FILE']).read_text()
async def main():
    cfg = LocalAgentConfig(system_instructions='Follow all attached mogra skills.', capabilities=CapabilitiesConfig())
    async with Agent(cfg) as agent:
        res = await agent.chat(prompt)
        async for _ in res: pass
asyncio.run(main())
"
    ;;
  gemini-cli|claude-code|codex|goose|openhands|aider)
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
