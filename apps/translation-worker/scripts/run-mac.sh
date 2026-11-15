#!/usr/bin/env bash
# macOS: a Linux container cannot reach Metal, so llama-server runs on the host
# and only the API runs in Docker.
#
#   ./scripts/run-mac.sh
#
# Export any of the variables below first to override the defaults.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${TRANSLATION_WORKER_TOKEN:?set TRANSLATION_WORKER_TOKEN to the value in .env.translation}"

export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8788}"
export TRANSLATION_MODEL_PATH="${TRANSLATION_MODEL_PATH:-../../models/translation/Index-Translate-9B.Q4_K_M.gguf}"
export RESULT_DIR="${RESULT_DIR:-../../asr-results}"

if [ -z "${LLAMA_SERVER:-}" ]; then
  LLAMA_SERVER="$(command -v llama-server || true)"
  if [ -z "$LLAMA_SERVER" ]; then
    echo "llama-server is not on PATH. Install it with: brew install llama.cpp" >&2
    exit 1
  fi
  export LLAMA_SERVER
fi

exec uv run --python 3.12 python -m translation_worker.main
