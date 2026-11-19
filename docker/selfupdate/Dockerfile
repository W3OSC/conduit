# Self-updating Conduit container.
#
# This image contains NO application code — only a Node toolchain and a small
# supervisor. On first start it clones the repository (CONDUIT_REPO) into the
# /src volume, builds it, and runs the server with CONDUIT_SUPERVISED=1. The
# app's own update poller then pulls new commits on the default branch and
# exits 0; the supervisor rebuilds and relaunches. Set it up once and it keeps
# itself current — no image rebuilds, no registry, works with any fork.
#
# The full (non-slim) image ships git + python3/make/g++, which native modules
# (better-sqlite3) need, and glibc so prebuilt binaries are used when available.
FROM node:20-bookworm

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /src /data
EXPOSE 3101

ENTRYPOINT ["/entrypoint.sh"]
