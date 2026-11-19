#!/bin/sh
# Build steps for the self-updating container (docker/selfupdate/entrypoint.sh
# calls this after every update, re-reading it from the freshly pulled tree —
# so build changes ship with the code that needs them).
set -eu

npm install --no-audit --no-fund
npm run build
