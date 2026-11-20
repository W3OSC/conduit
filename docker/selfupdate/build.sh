#!/bin/sh
# Build steps for the self-updating container (docker/selfupdate/entrypoint.sh
# calls this after every update, re-reading it from the freshly pulled tree —
# so build changes ship with the code that needs them).
set -eu

npm install --no-audit --no-fund
# npm install may rewrite the lockfile (platform-specific optional deps); a
# dirty tree would block the in-app auto-updater, so restore it. node_modules
# is unaffected — this only keeps git clean.
git checkout -- package-lock.json 2>/dev/null || true
npm run build

# Claude Code CLI for the AI runner (cloud/ai.ts) — installed into the data
# volume so it survives container recreates, refreshed on every rebuild so it
# tracks upstream. The server auto-discovers this path when DOCKER=true
# (cloud/ai-config.ts); auth comes from a setup token pasted in Settings → AI
# (or CLAUDE_CODE_OAUTH_TOKEN). Skipped outside the container (no /data) or
# with CONDUIT_INSTALL_CLAUDE_CLI=0; a failed install is non-fatal — the
# runner just stays unavailable.
CLI_DIR="${CONDUIT_CLI_DIR:-/data/claude-cli}"
if [ "${CONDUIT_INSTALL_CLAUDE_CLI:-1}" != "0" ] && [ -d "$(dirname "$CLI_DIR")" ]; then
  echo "[build] installing/refreshing Claude Code CLI in $CLI_DIR"
  mkdir -p "$CLI_DIR"
  (cd "$CLI_DIR" && npm install --no-audit --no-fund @anthropic-ai/claude-code@latest) \
    || echo "[build] Claude CLI install failed — the AI runner stays unavailable"
fi
