# Contributing to Conduit

Thanks for your interest in contributing. This document covers how to get the project running locally, how to submit changes, and how to report issues.

---

## Development setup

**Requirements:** Node.js 20+, npm 10+

```bash
git clone https://github.com/conduit-app/conduit
cd conduit
npm install
make dev
```

Open **http://localhost:3101**. In development, Vite runs on port 3101 and proxies API and WebSocket calls to the Express server on port 3100.

**Useful commands:**

```bash
make dev       # start server + client in watch mode
make build     # production build
make migrate   # run database migrations
make test      # run server tests
make lint      # typecheck both packages
make clean     # remove build artifacts
```

---

## Project structure

```
packages/
  server/          Express API server (Node.js, TypeScript)
    src/
      api/         Route handlers
      auth/        Authentication middleware
      connections/ Platform connection managers
      db/          Drizzle ORM schema and migrations
      sync/        Background sync logic per platform
      update/      Update checker
      websocket/   WebSocket hub
  client/          React UI (Vite, Tailwind CSS, TypeScript)
    src/
      components/  Shared UI components
      hooks/       React hooks
      pages/       Page-level components
      store/       Client state
  openclaw-plugin/ OpenClaw channel plugin
```

The server and client are separate npm workspaces. The server is a standard Express app with better-sqlite3 for synchronous SQLite access via Drizzle ORM. The client is a Vite + React SPA that the server serves in production.

---

## Making changes

1. Fork the repository and create a branch from `main`
2. Make your changes — keep commits focused and atomic
3. Run `make lint` and `make test` before submitting
4. Open a pull request with a clear description of what changed and why

For anything beyond a small bug fix, open an issue first to discuss the approach.

---

## Reporting bugs

Open a GitHub issue with:

- What you were doing when the bug occurred
- What you expected to happen
- What actually happened
- Your OS, Node.js version, and which platform(s) are connected

---

## Code style

- TypeScript throughout — no `any` without a comment explaining why
- No `console.log` in committed code (server uses prefixed `console.error`/`console.log` for structured logging; client has none)
- SQL filters belong in the query, not in JavaScript after the fact
- Comments describe *why*, not *what* — the code describes what

---

## Platform notes

Conduit uses user-account access for Discord (selfbot) and Twitter (cookie auth). Be mindful when testing against live accounts — the connection test and sync commands make real API calls.
