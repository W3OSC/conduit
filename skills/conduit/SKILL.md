---
name: conduit
description: Read and act on the user's messages, email, calendar, meeting notes, and files (Slack, Discord, Telegram, Gmail, Google Calendar/Meet/Drive, Twitter/X, Notion, Obsidian, SMB) through their Conduit hub — all writes queue in a human-approval outbox.
---

# Conduit — Agent Guide

Conduit aggregates the user's accounts behind one REST API. Reads are direct;
**every write queues in an outbox for human approval** before it executes.

## Setup

- **Base URL:** `$CONDUIT_URL` (e.g. `http://localhost:3101`) — ask the user if unset
- **Auth:** send `X-API-Key: <key>` on every request
- Optionally send `X-Session-Id: <your-session-id>` — Conduit then records your
  API calls so the user can inspect what you did and why.

## The efficient workflow

Call the cheap, purpose-built endpoints first. Do NOT start by pulling raw
message lists, and do not fetch `/api/openapi.json` (it is ~30k tokens; use it
only when a parameter you need is not documented here).

1. **`GET /api/digest`** — one call, ~2k tokens: chats needing a reply, unread
   email rollup, upcoming events (7 days), recent meeting-note excerpts,
   pending outbox items, per-service unread counts. Params: `since` (ISO,
   default 24h ago), `meetings_days` (default 14). **This answers most
   "what needs my attention / what should I follow up on" questions alone.**
2. **`GET /api/context`** — connected services + capabilities (cached, ETag).
3. Drill into specifics only for items the digest surfaced (endpoints below).
4. Queue any actions via `POST /api/outbox`, then tell the user what is
   awaiting their approval.

## Read endpoints

Costs assume default limits; keep `limit` small — you can always fetch more.

### Cross-service
```
GET /api/digest                                  — attention briefing (START HERE)
GET /api/activity?since=&until=&sources=&limit=  — chronological feed of messages+email (max 200)
GET /api/search?q=&source=&limit=                — text search across services
GET /api/chats                                   — chat tree per service, with per-chat `unread` counts
GET /api/messages?source=&chat_id=&limit=&before=&after=&around=&include_meta=true
GET /api/topology                                — channel/label/folder structure per service (cached)
```
`/api/messages` params are exactly those listed — there is no `search` or
`offset` param. Page with `before` (ISO timestamp).

### Contacts
```
GET /api/contacts?source=&q=&criteria=&limit=&offset=   — sorted by activity score
GET /api/contacts/{source}/{platformId}                 — one contact
GET /api/contacts/{source}/{platformId}/history?limit=  — messages with that person
GET /api/contacts/{source}/{platformId}/dm-channel      — resolve the DM channel id
```

### Gmail
```
GET /api/gmail/messages?q=&label=&unread=true&starred=true&thread_id=&limit=&offset=
GET /api/gmail/messages/{gmailId}                — one message (metadata + snippet)
GET /api/gmail/messages/{gmailId}/body           — full body (live fetch — large)
GET /api/gmail/threads/{threadId}                — whole thread
GET /api/gmail/labels                            — label list
```

### Calendar & Meetings
```
GET /api/calendar/events?from=&to=&calendarId=&limit=   — default window −7d..+30d
GET /api/calendar/events/{eventId}
GET /api/calendar/calendars
GET /api/meet-notes?from=&to=&q=&limit=&offset=  — Google Meet AI notes (list incl. summaries)
GET /api/meet-notes/{id}                         — one note with full transcript text
```
**Always pass `from`/`to` on `/api/meet-notes`** ("past 2 weeks" =
`?from=<now-14d ISO>`) — summaries are full meeting transcripts, so unbounded
pulls are extremely expensive.

### Files — Obsidian vaults
```
GET /api/obsidian/vaults                         — list vaults (get the {id})
GET /api/obsidian/vaults/{id}/files              — file tree for a vault
GET /api/obsidian/vaults/{id}/files/{path}       — read a file (URL-encode the path)
```

### Files — Google Drive
```
GET /api/gdrive/folders                          — configured folders (integer config ids)
GET /api/gdrive/folders/{folderId}/files         — file tree ({folderId} = config id)
GET /api/gdrive/folders/{folderId}/files/{fileId} — read (Docs→Markdown, Sheets→CSV)
```
Check each file's `editability`: `direct` (overwritable), `find-replace`
(patchable), `read-only`.

### Files — SMB shares
```
GET /api/smb/shares                              — list shares
GET /api/smb/shares/{id}/files?path=             — directory listing
GET /api/smb/shares/{id}/files/{path}            — read a file
```

### Twitter/X and Notion
```
GET /api/twitter/dms?limit=          GET /api/twitter/dms/{conversationId}
GET /api/twitter/feed?count=         GET /api/twitter/notifications/mentions
GET /api/notion/databases            POST /api/notion/databases/{id}/query
GET /api/notion/pages/{pageId}       GET /api/notion/blocks/{blockId}/children
```

### Outbox
```
GET  /api/outbox?status=&source=&limit=&offset=  — your queued items
GET  /api/outbox/{id}                            — check approval status
POST /api/outbox/{id}/retry                      — re-dispatch a failed item
```

## Writes — the outbox

Everything you send is created `pending` and executes only after the user
approves it in the Conduit UI. Always tell the user what you queued.

```json
POST /api/outbox
{
  "source":         "slack",
  "recipient_id":   "C04ABC123",
  "recipient_name": "#general (label shown in the approval UI)",
  "content":        "Heads up: deployment at 3pm."
}
```

- `source`: `slack` | `discord` | `telegram` | `twitter` | `gmail` | `calendar` | `notion` | `obsidian` | `smb` | `gdrive`
- `recipient_id`: channel/DM id (from `/api/chats` or `.../dm-channel`), email
  address, file path, or file id — see per-service notes
- `content`: plain text for messaging platforms; **a JSON-encoded string of the
  action payload for all other services**
- Recommended: send an `Idempotency-Key: <unique-string>` header — a retried
  POST after a timeout then returns the original item instead of queueing a
  duplicate.

Response: `{ id, status, ... }`. Poll `GET /api/outbox/{id}` for
`pending → sent | rejected | failed`. `failed` items can be retried with
`POST /api/outbox/{id}/retry` once the underlying problem is fixed.

### Gmail (`content` = JSON string)
- Reply: `{"action":"reply","messageId":"…","threadId":"…","to":["a@x.io"],"subject":"Re: …","body":"…"}`
- Compose: `{"action":"compose","to":["a@x.io"],"subject":"…","body":"…"}`
- One-field actions with `messageId`: `archive`, `trash`, `spam`, `mark_read`,
  `mark_unread`, `star`, `unstar`, `unsubscribe`

### Calendar (`content` = JSON string)
- RSVP: `{"action":"rsvp","calendarId":"primary","eventId":"…","rsvpStatus":"accepted|declined|tentative"}`
- Create: `{"action":"create","calendarId":"primary","title":"…","start":"ISO","end":"ISO","attendees":["a@x.io"]}`
- Update: `{"action":"update","calendarId":"primary","eventId":"…", …changed fields}`
- Delete: `{"action":"delete","calendarId":"primary","eventId":"…"}`

### Twitter/X (`content` = JSON string)
`tweet {text}` · `reply {text, replyToId}` · `quote {text, quotedId}` ·
`retweet {tweetId}` · `like {tweetId}` · `follow {handle}` ·
`dm {text, conversationId}`

### Notion
Reads are direct GETs. Writes: `PATCH /api/notion/pages/{pageId}` and
`POST /api/notion/pages` execute **immediately** (they require the notion
write permission — mention to the user what you changed).

### Obsidian / Drive / SMB file writes (`content` = JSON string)

Actions: `patch_file` (edit — **always prefer this for existing files**),
`create_file`, `write_file` (full overwrite), `rename_file`, `delete_file`,
and for SMB `create_directory`.

Per-service payload fields:
- **obsidian**: `path` (+ `vaultId` when more than one vault is configured;
  `recipient_id` = the path). `rename_file` uses `oldPath`/`newPath`.
- **gdrive**: `folderId` (integer config id) + `fileId` (`recipient_id` =
  fileId; for `create_file` use `fileName` + optional `mimeType`, and
  `recipient_id` = fileName).
- **smb**: `path` + `shareId` (`recipient_id` = the path).

`patch_file` edit list — applied in order:
```json
{"action":"patch_file","path":"Notes/x.md","edits":[
  {"search":"## Tasks","position":"after","content":"\n- [ ] Review PR #42"},
  {"search":"status: draft","replace":"status: published"}
]}
```
`position`: `replace` (default, uses `replace` field) | `after` | `before`
(insert `content` around the anchor, anchor unchanged).

Choosing `search` strings:
1. **Read the file first** and copy the anchor character-for-character.
2. Use the **shortest unique substring** (a heading, date, or id), not a whole
   long line; keep it under ~80 chars.
3. It must match exactly once — add a neighbouring word if ambiguous.
4. Near-miss anchors are rescued by fuzzy matching (≥90% similar, unambiguous);
   the approval UI shows the user exactly what was matched. Ambiguous or
   too-different anchors still fail with a clear error — fix and resubmit.

### Messaging shortcut
`POST /api/contacts/{source}/{platformId}/message` with `{"content":"Hi!"}`
resolves the DM channel and queues the outbox item in one call.

## Key reminders

1. **Digest first.** One `/api/digest` call beats ten raw list pulls.
2. **Bound everything**: `since`/`from`/`to`/`limit` on every list call.
3. **Never claim you sent something.** You queued it; the user approves it.
4. **Read before you edit** any file; prefer `patch_file` over `write_file`.
5. Permissions are enforced server-side per API key (read scopes, per-channel
   and per-label allowlists, write toggles). A 403 means the user has not
   granted that access — say so instead of retrying.
6. Timestamps are ISO-8601 UTC everywhere.
