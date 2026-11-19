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
