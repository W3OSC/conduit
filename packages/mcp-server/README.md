# @conduit/mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes a
[Conduit](../../README.md) hub to tool-native AI agents over stdio.

Conduit aggregates the user's Slack, Discord, Telegram, Gmail, Google
Calendar/Meet/Drive, Twitter/X, Notion, Obsidian and SMB accounts behind one
self-hosted API. **Reads are direct; every write queues in an outbox for human
approval.**

This package is an alternative front door to the same hub as the REST +
`SKILL.md` path — use it when your agent speaks MCP natively, and the REST path
when it does not. Both enforce the same per-API-key permissions server-side.

## Why the tools look the way they do

The tools are shaped for token efficiency, not for API completeness:

- **`conduit_digest` is the cheap first call.** One bounded response (~2k
  tokens) answers "what needs my attention": chats needing a reply, an unread
  email rollup, upcoming events, recent meeting-note excerpts and pending
  approvals. It replaces the 6–20 raw list pulls an agent would otherwise make.
- **Every list tool is bounded** — `since`/`from`/`to`/`limit` with small
  defaults. `conduit_meet_notes` requires a `from` window and defaults to 10
  notes, because meeting "summaries" are full transcripts.
- **One file tool** (`conduit_read_file`) covers all three file backends
  instead of nine endpoint-shaped tools.
- **One write tool** (`conduit_queue_action`) which queues rather than sends.

## Tools

| Tool | What it does |
| --- | --- |
| `conduit_digest` | Attention briefing — **start here** for anything open-ended |
| `conduit_activity` | Chronological cross-service feed of messages + email |
| `conduit_search` | Substring search across messages and email |
| `conduit_list_chats` | Chat tree per service, with per-chat unread counts |
| `conduit_read_messages` | Message history for one chat (paged with `before`) |
| `conduit_contacts` | Contact lookup, sorted by activity |
| `conduit_meet_notes` | Google Meet notes — requires a `from` window |
| `conduit_calendar_events` | Calendar events in a window |
| `conduit_read_file` | Read/list files across `obsidian`, `gdrive` and `smb` |
| `conduit_queue_action` | **Queue** an action for the user to approve (never sends) |
| `conduit_outbox_status` | Check queued items: pending → sent / rejected / failed |

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CONDUIT_API_KEY` | **yes** | — | Sent as `X-API-Key`. Create one in the Conduit UI under Settings → API Keys. The server exits immediately with an explanatory message if it is unset. |
| `CONDUIT_URL` | no | `http://localhost:3101` | Base URL of the hub. |
| `CONDUIT_SESSION_ID` | no | `mcp-<uuid>` per process | Sent as `X-Session-Id` so Conduit records this agent's calls for the user's Outbox provenance view. Set it to correlate a longer-lived session. |
| `CONDUIT_TIMEOUT_MS` | no | `30000` | Per-request timeout. |

The API key carries its own permissions (per-service read scopes, per-channel
and per-label allowlists, write toggles). Grant an agent only what it needs — a
`403` surfaces to the agent as "the user has not granted this", with an
instruction not to retry.

## Run

```bash
npm install                                  # from the repo root
npm run build --workspace=packages/mcp-server
CONDUIT_API_KEY=<your-key> node packages/mcp-server/dist/index.js
```

The server speaks MCP over stdio, so it is normally launched by an MCP client
rather than by hand. Logs go to stderr; stdout is reserved for the protocol.

## MCP client configuration

Conduit is deliberately provider-agnostic. Most MCP clients accept some variant
of the following — consult your client's docs for where the file lives and
whether the servers map is named `mcpServers`, `servers` or similar.

```json
{
  "mcpServers": {
    "conduit": {
      "command": "node",
      "args": ["/absolute/path/to/conduit/packages/mcp-server/dist/index.js"],
      "env": {
        "CONDUIT_URL": "http://localhost:3101",
        "CONDUIT_API_KEY": "your-conduit-api-key"
      }
    }
  }
}
```

## Development

```bash
npm run dev   --workspace=packages/mcp-server   # tsx watch
npm run lint  --workspace=packages/mcp-server   # tsc --noEmit
npm run build --workspace=packages/mcp-server   # tsc -> dist/
```

Layout: `src/config.ts` (env, fail-fast), `src/client.ts` (fetch wrapper with
timeout, `{error}` unwrapping and 403 guidance), `src/tools/*` (tool
definitions grouped by area). Tool descriptions are the agent's only
instructions — keep the cost and bounding guidance inline when editing them.
