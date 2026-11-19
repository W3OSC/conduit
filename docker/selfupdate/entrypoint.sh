#!/bin/sh
# Supervisor for the self-updating Conduit container.
#
# Clones CONDUIT_REPO into /src (a volume) on first start, then loops:
# build if HEAD changed since the last successful build, run the server with
# CONDUIT_SUPERVISED=1, and rebuild + relaunch when it exits 0 (which the
# update poller does after pulling new commits on a clean default branch).
# A non-zero exit stops the container so the Docker restart policy applies.
#
# The loop itself is baked into the image on purpose: a script must not change
# on disk while a shell is executing it, and the checkout self-updates. Build
# steps that need to evolve with the repo live in docker/selfupdate/build.sh,
# which is re-read from the (already updated) tree on every iteration.
set -u

REPO="${CONDUIT_REPO:-https://github.com/W3OSC/conduit.git}"
SRC="${CONDUIT_SRC:-/src}"
STAMP="$SRC/.docker-build-stamp"

if [ ! -d "$SRC/.git" ]; then
  echo "[supervise] cloning $REPO into $SRC"
  git clone "$REPO" "$SRC" || exit 1
fi
cd "$SRC"

# Forward docker stop (SIGTERM) to the server and exit cleanly.
pid=""
term() {
  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  exit 0
}
trap term TERM INT

# Force-sync the checkout to the latest default-branch commit. Runs before
# every launch so a container restart always picks up the newest code, and a
# tree accidentally dirtied by tooling (the auto-update gate refuses to touch
# it) self-heals. The checkout is machine-managed — nobody edits it by hand —
# so a hard reset is safe. A checkout deliberately moved to another branch is
# left alone, and a fetch failure (offline) falls through to what's on disk.
sync_checkout() {
  [ "${CONDUIT_AUTO_UPDATE:-1}" = "0" ] && return 0
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  default="$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||')"
  [ -n "$branch" ] && [ -n "$default" ] && [ "$branch" = "$default" ] || return 0
  if git fetch origin 2>/dev/null; then
    git reset --hard "origin/$default" --quiet && echo "[supervise] synced to origin/$default ($(git rev-parse --short HEAD))"
  else
    echo "[supervise] fetch failed — starting with the code on disk"
  fi
}

while :; do
  sync_checkout
  head="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  built="$(cat "$STAMP" 2>/dev/null || true)"
  if [ "$head" = "unknown" ] || [ "$head" != "$built" ]; then
    echo "[supervise] building $head"
    if [ -x docker/selfupdate/build.sh ]; then
      docker/selfupdate/build.sh
    else
      npm install --no-audit --no-fund && npm run build
    fi
    if [ $? -ne 0 ]; then
      echo "[supervise] build failed — exiting so the restart policy can retry"
      exit 1
    fi
    echo "$head" > "$STAMP"
  fi

  echo "[supervise] starting server at $head"
  CONDUIT_SUPERVISED=1 DOCKER=true node packages/server/dist/index.js &
  pid=$!
  wait "$pid"
  code=$?
  pid=""

  if [ "$code" -ne 0 ]; then
    echo "[supervise] server exited $code — stopping container"
    exit "$code"
  fi
  echo "[supervise] server exited 0 — relaunching (self-update applied)"
done
