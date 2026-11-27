#!/usr/bin/env bash
set -euo pipefail

SPOKE_DIR=$(cd "${1:?spoke dir required}" && pwd)
PLAN_JSON="${2:?plan json required}"
ISSUE_NUMBER="${3:?issue number required}"
STACK="${4:-react19-ts-vite}"
ISSUE_FILE="${5:-}"

HARNESS=$(jq -r '.harness' "$PLAN_JSON")
MODEL=$(jq -r '.model' "$PLAN_JSON")
BIN=$(jq -r '.bin' "$PLAN_JSON")
ENV_KEY=$(jq -r '.envKey // empty' "$PLAN_JSON")
DELIVERY_MODE=$(jq -r '.deliveryMode // "greenfield-stack"' "$PLAN_JSON")
LAYOUT=$(jq -r '.stackProfile.layout // "stacks-subpath"' "$PLAN_JSON")
SUBPATH=$(jq -r '.stackProfile.subpath // empty' "$PLAN_JSON")
export PROMPT_FILE="/tmp/mogra-prompt-${ISSUE_NUMBER}.md"
export MOGRA_MODEL="$MODEL"

case "$LAYOUT" in
  repo-root)
    WORKDIR="${SPOKE_DIR}"
    ;;
  subpath)
    WORKDIR="${SPOKE_DIR}/${SUBPATH:-$STACK}"
    ;;
  *)
    WORKDIR="${SPOKE_DIR}/stacks/${STACK}"
    ;;
esac

{
  echo "# ProductionLine (mogra) Task — Issue #${ISSUE_NUMBER} (${STACK})"
  echo "Goal: $(jq -r '.goal' "$PLAN_JSON")"
  echo "Delivery Mode: ${DELIVERY_MODE}"
  if [ -n "$ISSUE_FILE" ] && [ -f "$ISSUE_FILE" ]; then
    echo ""
    cat "$ISSUE_FILE"
  fi
  echo ""
  echo "## Skills"
  jq -r '.skillPaths[]' "$PLAN_JSON" | while read -r skill_path; do
    [ -f "$skill_path" ] && sed '/^---$/,/^---$/d' "$skill_path"
  done
  echo "## Rules"
  if [ "$DELIVERY_MODE" = "incremental-feature" ]; then
    echo "- Work inside '${WORKDIR}' and implement the requested GitHub Issue incrementally without breaking existing features."
    echo "- Include complete tests (Minitest for Rails, Gradle unit/lint for Android, Swift/XCTest for iOS)."
  else
    echo "- Build '${STACK}' inside '${WORKDIR}' with scripts: typecheck, lint, test, build, test:e2e (Playwright + @axe-core/playwright 320px reflow)."
    echo "- Dynamic base path via process.env.VITE_BASE_PATH || '/'."
  fi
  echo "- Never edit .github/workflows/ or .mogra.yaml."
} > "$PROMPT_FILE"

if [ -n "$ENV_KEY" ] && [ -z "${!ENV_KEY:-}" ]; then
  echo "Missing required secret env var: ${ENV_KEY} for harness '${HARNESS}' (${MODEL})." >&2
  exit 1
fi

discover_flash_models() {
  local all
  all=$(curl -fsS -H "x-goog-api-key: ${GEMINI_API_KEY}" \
    "https://generativelanguage.googleapis.com/v1beta/models" \
    | jq -r '.models[] | select((.supportedGenerationMethods // []) | index("generateContent")) | .name | sub("^models/"; "")' \
    | grep -E 'flash' \
    | grep -Ev '(image|tts|audio|live|thinking|robotics|computer-use|exp|omni)' || true)

  {
    printf '%s\n' "$MODEL"
    printf '%s\n' "$all" | grep -E 'flash-lite' | grep -E '3\.1'
    printf '%s\n' "$all" | grep -E 'flash-lite' | grep -v '3\.1' | sort -r
    printf '%s\n' "$all" | grep -v 'flash-lite' | sort -r
  } | awk 'NF && !seen[$0]++'
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONTROL_PLANE_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)

run_free_tier_oneshot() {
  local target_model="$1"
  if [ "$DELIVERY_MODE" = "incremental-feature" ]; then
    node "${CONTROL_PLANE_DIR}/src/incremental-builder.mjs" \
      --workdir "." \
      --stack "$STACK" \
      --model "$target_model" \
      --prompt-file "$PROMPT_FILE"
  else
    node "${CONTROL_PLANE_DIR}/src/free-tier-builder.mjs" \
      --workdir "." \
      --model "$target_model" \
      --prompt-file "$PROMPT_FILE"
  fi
}

run_free_tier_gemini_loop() {
  mapfile -t FLASH_MODELS < <(discover_flash_models)
  echo "[mogra] Free-Tier candidates: ${FLASH_MODELS[*]:-none}" >&2
  export MOGRA_CANDIDATES="${FLASH_MODELS[*]:-}"
  run_free_tier_oneshot "${FLASH_MODELS[0]:-$MODEL}"
}

mkdir -p "$WORKDIR"
echo "Running harness=${HARNESS} model=${MODEL} stack=${STACK} mode=${DELIVERY_MODE} workdir=${WORKDIR}"
cd "$WORKDIR"

case "$HARNESS" in
  antigravity)
    if [[ "$MODEL" == *flash-lite* ]]; then
      echo "[mogra] Free-Tier Flash-Lite model detected; running lean gemini loop directly to stay under 250K TPM." >&2
      run_free_tier_gemini_loop && exit 0
      exit 1
    fi
    python3 -m pip install --quiet --upgrade google-antigravity
    if timeout 120s python3 -u -c "
import asyncio, inspect, os, pathlib, sys
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

prompt = pathlib.Path(os.environ['PROMPT_FILE']).read_text()
kwargs = dict(
    system_instructions='You are ProductionLine (mogra) builder. Implement everything completely in the current working directory, run tests locally, and satisfy every attached skill.',
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
      exit 0
    fi
    run_free_tier_gemini_loop && exit 0
    exit 1
    ;;
  gemini-cli)
    run_free_tier_gemini_loop && exit 0
    exit 1
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
