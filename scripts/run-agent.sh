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
RETRY_WAIT="${MOGRA_RETRY_WAIT:-65}"
export PROMPT_FILE="/tmp/mogra-prompt-${ISSUE_NUMBER}.md"
export MOGRA_MODEL="$MODEL"

{
  echo "# ProductionLine (mogra) Task — Issue #${ISSUE_NUMBER} (${STACK})"
  echo "Goal: $(jq -r '.goal' "$PLAN_JSON")"
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
  echo "- Build '${STACK}' inside '${SPOKE_DIR}/stacks/${STACK}' with scripts: typecheck, lint, test, build, test:e2e (Playwright + @axe-core/playwright 320px reflow)."
  echo "- Dynamic base path via process.env.VITE_BASE_PATH || '/'."
  echo "- Never edit .github/workflows/, .mogra.yaml, or other stacks/."
} > "$PROMPT_FILE"

if [ -n "$ENV_KEY" ] && [ -z "${!ENV_KEY:-}" ]; then
  echo "Missing required secret env var: ${ENV_KEY} for harness '${HARNESS}' (${MODEL})." >&2
  exit 1
fi

run_gemini_cli() {
  local target_model="${1:-}"
  export GEMINI_CLI_TRUST_WORKSPACE=true
  local args=(--yolo --skip-trust -p "$(cat "$PROMPT_FILE")")
  [ -n "$target_model" ] && args=(-m "$target_model" "${args[@]}")
  if command -v gemini >/dev/null 2>&1; then
    gemini "${args[@]}"
  else
    npx -y @google/gemini-cli "${args[@]}"
  fi
}

discover_flash_models() {
  local all
  all=$(curl -fsS -H "x-goog-api-key: ${GEMINI_API_KEY}" \
    "https://generativelanguage.googleapis.com/v1beta/models" \
    | jq -r '.models[] | select((.supportedGenerationMethods // []) | index("generateContent")) | .name | sub("^models/"; "")' \
    | grep -E 'flash' \
    | grep -Ev '(image|tts|audio|live|thinking|robotics|computer-use|exp|omni)' || true)

  # Prioritize Free-Tier 500-RPD flash-lite models ahead of 20-RPD flash models.
  {
    printf '%s\n' "$all" | grep -E 'flash-lite' | grep -E '3\.1'
    printf '%s\n' "$all" | grep -E 'flash-lite' | grep -v '3\.1' | sort -r
    printf '%s\n' "$all" | grep -v 'flash-lite' | sort -r
  } | awk '!seen[$0]++'
}

probe_gemini_model() {
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "x-goog-api-key: ${GEMINI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"contents":[{"parts":[{"text":"ok"}]}],"generationConfig":{"maxOutputTokens":1}}' \
    "https://generativelanguage.googleapis.com/v1beta/models/${1}:generateContent" || echo "000"
}

mkdir -p "${SPOKE_DIR}/stacks/${STACK}"
echo "Running harness=${HARNESS} model=${MODEL} stack=${STACK} workdir=${SPOKE_DIR}/stacks/${STACK}"
cd "${SPOKE_DIR}/stacks/${STACK}"

case "$HARNESS" in
  antigravity)
    python3 -m pip install --quiet --upgrade google-antigravity
    if timeout 60s python3 -u -c "
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
      exit 0
    fi

    echo "[mogra] antigravity failed; discovering Free-Tier Flash-Lite models (retry wait=${RETRY_WAIT}s)." >&2
    mapfile -t FLASH_MODELS < <(discover_flash_models)
    echo "[mogra] candidates: ${FLASH_MODELS[*]:-none}" >&2

    for candidate in "${FLASH_MODELS[@]}"; do
      for attempt in 1 2; do
        http_code=$(probe_gemini_model "$candidate")
        echo "[mogra] model='${candidate}' attempt=${attempt} probe=${http_code}" >&2
        if [ "$http_code" != "200" ]; then
          [ "$attempt" -eq 1 ] && [ "$http_code" = "429" ] && { sleep "$RETRY_WAIT"; continue; }
          break
        fi
        if [ "$attempt" -eq 2 ]; then
          printf '\n## Resume Note\nInspect any files already written in the working directory and complete only remaining files/tests.\n' >> "$PROMPT_FILE"
        fi
        if run_gemini_cli "$candidate"; then
          exit 0
        fi
        echo "[mogra] cooling down ${RETRY_WAIT}s before retrying '${candidate}'..." >&2
        sleep "$RETRY_WAIT"
      done
    done

    echo "[mogra] all Gemini Free-Tier candidates exhausted or unavailable." >&2
    exit 1
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
