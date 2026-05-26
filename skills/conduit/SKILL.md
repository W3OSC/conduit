---
name: conduit
description: Query and interact with your Conduit personal messaging hub — read messages, search conversations, manage email and calendar, read and edit files (Obsidian vault, Google Drive, SMB shares), manage Notion, and send messages via an approval outbox across Slack, Discord, Telegram, Gmail, Twitter/X, and more.
---

# Conduit — AI Agent Guide

Conduit is a personal hub that aggregates Slack, Discord, Telegram, Gmail, Twitter/X, Google Calendar, Notion, Obsidian vaults, Google Drive, and SMB shares behind **a single REST API**. Every action — reading messages, sending replies, editing files, updating Notion pages, RSVP-ing to events — goes through this one API.

**You must use Conduit for all of these tasks.** Do not tell the user you cannot read or write files, send messages, or edit documents. If the relevant service is connected in Conduit, it is possible through the API.

---

## Setup

- **Base URL:** `$CONDUIT_URL` (e.g. `http://localhost:3101`) — ask the user if not set
- **Auth:** every request needs `X-API-Key: <api-key>` — ask the user for their key
- **Full OpenAPI spec:** `GET $CONDUIT_URL/api/openapi.json`

---

## The Golden Rule: Conduit Handles Everything

The most important thing to understand about Conduit is this:

> **If a service is connected, you can read and write to it through Conduit.** You do not need a separate Notion integration, a separate file editor, or any other tool. Use `POST /api/outbox` for all write operations. Reads are always direct GET endpoints.

If you are unsure whether something is possible, call `GET /api/connections` first to see what is connected, then call `GET /api/topology` to see the full resource inventory. All of it is accessible.

---

## The Outbox: How All Writes Work

**Every write action — sending a message, editing a file, replying to email, updating Notion, creating a calendar event — goes through the outbox.** This is a human-in-the-loop approval system. You queue an action, the user reviews it in the UI, and then it executes.

### Outbox lifecycle

```
POST /api/outbox  →  status: "pending"  →  user approves  →  status: "sent"
```

After queuing an action, always tell the user what you submitted and that it is waiting for their approval in the outbox. You can poll `GET /api/outbox/{id}` to check whether it was approved.

### Core outbox fields

```json
{
  "source":         "slack",
  "recipient_id":   "D04XYZ",
  "recipient_name": "Alice (human-readable label for the UI)",
  "content":        "Hello! Just following up."
}
```

- `source` — which service: `slack`, `discord`, `telegram`, `twitter`, `gmail`, `calendar`, `notion`, `obsidian`, `smb`, `gdrive`
- `recipient_id` — where to deliver: a channel ID, user ID, file path, email address, etc. (see per-service details below)
- `recipient_name` — a human-readable label shown in the outbox UI (optional but helpful)
- `content` — for messaging platforms this is plain text; **for structured platforms (gmail, calendar, notion, obsidian, smb, gdrive) this must be a JSON string encoding the action payload**

---

## Outbox Actions by Platform

### Messaging: Slack, Discord, Telegram

`content` is plain text. `recipient_id` is the channel/DM ID from `GET /api/chats`.

```json
POST /api/outbox
{
  "source":         "slack",
  "recipient_id":   "C04ABC123",
  "recipient_name": "#general",
  "content":        "Heads up: deployment scheduled for 3pm."
}
```

For DMs when you only have a contact's `platformId`, first call:
```
GET /api/contacts/{source}/{platformId}/dm-channel
```
→ returns `{ "channelId": "D04XYZ", "channelName": "alice" }` — use that `channelId` as `recipient_id`.

Or simply use the shortcut:
```
POST /api/contacts/{source}/{platformId}/message
{ "content": "Hi Alice!" }
```

---

### Gmail

All Gmail actions go through the outbox. `content` is a **JSON string** with an `action` field.

**Reply to an email:**
```json
POST /api/outbox
{
  "source":         "gmail",
  "recipient_id":   "alice@example.com",
  "recipient_name": "Re: Project Update",
  "content": "{\"action\":\"reply\",\"messageId\":\"18f3a...\",\"threadId\":\"18f3a...\",\"to\":[\"alice@example.com\"],\"subject\":\"Re: Project Update\",\"body\":\"Thanks for the update! I'll review by EOD.\"}"
}
```

**Compose a new email:**
```json
{
  "action":  "compose",
  "to":      ["alice@example.com"],
  "subject": "Quick question",
  "body":    "Can we meet Thursday at 2pm?"
}
```

**Other Gmail actions** (no extra fields needed beyond `messageId`):
- `archive`, `trash`, `spam`, `mark_read`, `mark_unread`, `star`, `unstar`, `unsubscribe`

```json
{
  "action":    "archive",
  "messageId": "18f3a..."
}
```

---

### Google Calendar

All calendar changes go through the outbox. `content` is a **JSON string**.

**RSVP to an event:**
```json
{
  "action":      "rsvp",
  "calendarId":  "primary",
  "eventId":     "abc123xyz",
  "rsvpStatus":  "accepted"
}
```
`rsvpStatus` values: `accepted`, `declined`, `tentative`

**Create an event:**
```json
{
  "action":     "create",
  "calendarId": "primary",
  "title":      "Sync with Alice",
  "start":      "2026-04-08T14:00:00Z",
  "end":        "2026-04-08T14:30:00Z",
  "attendees":  ["alice@example.com"]
}
```

**Update an event:**
```json
{
  "action":     "update",
  "calendarId": "primary",
  "eventId":    "abc123xyz",
  "title":      "Updated title",
  "start":      "2026-04-08T15:00:00Z",
  "end":        "2026-04-08T15:30:00Z"
}
```

**Delete an event:**
```json
{
  "action":     "delete",
  "calendarId": "primary",
  "eventId":    "abc123xyz"
}
```

---

### Notion

Notion **reads** are direct GET endpoints. Notion **writes** can use either:
1. **Direct API endpoints** (require `sendEnabled` for notion): `PATCH /api/notion/pages/{pageId}` or `POST /api/notion/pages` — these execute immediately, no outbox
2. **Outbox** for append_blocks, archive, and batch operations

**Update a page property directly:**
```
PATCH /api/notion/pages/{pageId}
{
  "properties": {
    "Status": { "select": { "name": "Done" } }
  }
}
```

**Create a new database row directly:**
```
POST /api/notion/pages
{
  "parent": { "database_id": "db-uuid" },
  "properties": {
    "Name":   { "title": [ { "text": { "content": "New task" } } ] },
    "Status": { "select": { "name": "To Do" } }
  }
}
```

**Archive (trash) a page via direct update:**
```
PATCH /api/notion/pages/{pageId}
{
  "in_trash": true
}
```

---

### Obsidian Vault — File Reads and Writes

**This is fully supported.** You can read any file and write/edit any file in the vault through Conduit. You do not need direct file system access.

#### Reading files

```
GET /api/obsidian/files                          — list all files (full file tree)
GET /api/obsidian/files/{vaultId}/tree           — list files for a specific vault
GET /api/obsidian/files/Daily%20Notes%2F2026-05-26.md   — read a file (URL-encode path)
```

Multi-vault: if multiple vaults are configured, call `GET /api/obsidian/vaults` to list them and their IDs.

#### Writing and editing files — ALL via POST /api/outbox

For all Obsidian file writes, set `source: "obsidian"` and encode the action as a JSON string in `content`. Set `recipient_id` to the file path.

**IMPORTANT: Use `patch_file` when editing an existing file.** Never use `write_file` on an existing file unless you intend to replace the entire contents.

---

**`patch_file` — Targeted edits to an existing file (preferred for editing)**

`patch_file` works by finding an exact anchor string in the file and applying an operation around it. The `search` string must match exactly once in the file.

#### Critical: How to choose a `search` string

The `search` string is matched byte-for-byte against the file. The most common failure is using too much text — especially copying an entire long line — so that the string gets truncated or misrepresents the actual content.

**Rules for reliable `search` strings:**

1. **Use the shortest unique substring, not the whole line.** For a Markdown table row, use just enough to identify the row uniquely — typically the date or key identifier, not the full row.
   - ✅ `| May 18, 2026 | Rob Jones Review |`
   - ❌ `| 7 | May 18, 2026 | Rob Jones Review | Joe, Rob Jones | Google Workspace, GoDaddy, Slack security review; 2FA enforcement; YubiKeys; DKIM | [[2026-05-18 Rob Jones - Google GoDaddy Slack Review]] |`

2. **Always read the file first.** Call `GET /api/obsidian/files/{path}` before composing a `patch_file` edit. Copy the `search` value character-for-character from the actual file content returned by the API — do not reconstruct it from memory.

3. **Avoid anchoring on content that changes.** Don't use dynamic values (status indicators, counts, lists that grow) as the anchor. Prefer stable identifiers: headings, dates, names, IDs.

4. **If the search string would be longer than ~80 characters, shorten it.** Long search strings across table rows are the leading cause of "search string not found" errors. Find a shorter unique fragment instead.

5. **Verify uniqueness before submitting.** After reading the file, mentally confirm that your chosen `search` string appears exactly once. If it could appear multiple times, add one or two surrounding words to make it unique.

Three `position` modes:

- `replace` (default) — replaces the matched text with `replace`:
```json
POST /api/outbox
{
  "source":         "obsidian",
  "recipient_id":   "Notes/meeting-notes.md",
  "recipient_name": "Edit meeting-notes.md",
  "content": "{\"action\":\"patch_file\",\"path\":\"Notes/meeting-notes.md\",\"edits\":[{\"search\":\"## Action Items\",\"replace\":\"## Action Items (Updated)\"}]}"
}
```

- `after` — inserts `content` immediately after the anchor (anchor is unchanged). Use this to append items to a list or section:
```json
{
  "action": "patch_file",
  "path":   "Notes/meeting-notes.md",
  "edits": [
    { "search": "## Action Items", "position": "after", "content": "\n- Follow up with Alice by Friday" }
  ]
}
```

- `before` — inserts `content` immediately before the anchor:
```json
{
  "action": "patch_file",
  "path":   "Notes/meeting-notes.md",
  "edits": [
    { "search": "## Next Steps", "position": "before", "content": "New paragraph above.\n\n" }
  ]
}
```

Multiple edits in one operation (applied in sequence):
```json
{
  "action": "patch_file",
  "path":   "Daily Notes/2026-05-26.md",
  "edits": [
    { "search": "## Tasks", "position": "after", "content": "\n- [ ] Review PR #42" },
    { "search": "status: draft", "replace": "status: published" }
  ]
}
```

---

**`create_file` — Create a new file (fails if file already exists)**
```json
{
  "action":  "create_file",
  "path":    "Notes/new-note.md",
  "content": "# My New Note\n\nContent goes here."
}
```

---

**`write_file` — Overwrite an entire file (or create if absent)**
Only use this when you intend to replace all content. For edits to existing files, use `patch_file`.
```json
{
  "action":  "write_file",
  "path":    "Notes/existing-note.md",
  "content": "# Fully replaced\n\nAll previous content is gone."
}
```

---

**`rename_file` — Move or rename a file**
```json
{
  "action":   "rename_file",
  "oldPath":  "Notes/old-name.md",
  "newPath":  "Notes/new-name.md"
}
```

---

**`delete_file` — Delete a file**
```json
{
  "action": "delete_file",
  "path":   "Notes/to-delete.md"
}
```

---

**Full outbox request example — append to a daily note:**
```json
POST /api/outbox
{
  "source":         "obsidian",
  "recipient_id":   "Daily Notes/2026-05-26.md",
  "recipient_name": "Append to daily note",
  "content": "{\"action\":\"patch_file\",\"path\":\"Daily Notes/2026-05-26.md\",\"edits\":[{\"search\":\"## Evening Notes\",\"position\":\"after\",\"content\":\"\\n- Completed the Conduit skill update\"}]}"
}
```

All Obsidian writes require `sendEnabled` permission for the `obsidian` service.

---

### Google Drive — File Reads and Writes

**Reads** are direct GET endpoints. **Writes** go through `POST /api/outbox`.

#### Reading Drive files

```
GET /api/topology/gdrive                           — list folders and file tree (start here)
GET /api/gdrive/folders                            — list configured Drive folders
GET /api/gdrive/folders/{folderId}/files           — list files in a folder
GET /api/gdrive/folders/{folderId}/files/{fileId}  — read file content (Docs → Markdown, Sheets → CSV)
```

The `folderId` in these paths is the integer **config ID** from `GET /api/gdrive/folders`, not the Google Drive folder ID.

Check the `editability` field on files:
- `direct` — can be fully overwritten
- `find-replace` — can be edited via `patch_file` search/replace (Google Docs, Sheets)
- `read-only` — cannot be modified (PDFs, binaries)

#### Writing to Drive files (via outbox)

**`patch_file` — Edit a Google Doc or Sheet (find/replace):**
```json
POST /api/outbox
{
  "source":         "gdrive",
  "recipient_id":   "1BxiMVs0XRA5...",
  "recipient_name": "Edit Q1 Report",
  "content": "{\"action\":\"patch_file\",\"folderId\":1,\"fileId\":\"1BxiMVs0XRA5...\",\"edits\":[{\"search\":\"draft\",\"replace\":\"final\"}]}"
}
```

**`write_file` — Overwrite an entire file:**
```json
{
  "action":   "write_file",
  "folderId": 1,
  "fileId":   "1BxiMVs0XRA5...",
  "content":  "# Updated content\n\nAll new."
}
```

**`create_file` — Create a new file:**
```json
{
  "action":   "create_file",
  "folderId": 1,
  "fileName": "new-doc.md",
  "content":  "# My Doc\n\nContent.",
  "mimeType": "text/markdown"
}
```

**`rename_file` / `delete_file`:**
```json
{ "action": "rename_file", "folderId": 1, "fileId": "1BxiMVs0XRA5...", "newName": "Better Name.md" }
{ "action": "delete_file", "folderId": 1, "fileId": "1BxiMVs0XRA5..." }
```

For `create_file`, set `recipient_id` to the `fileName`. For all other file actions, set `recipient_id` to the `fileId`.

---

### SMB Shares — File Reads and Writes

**Reads** are direct GET endpoints. **Writes** go through `POST /api/outbox`.

#### Reading SMB files

```
GET /api/smb/shares                        — list all configured shares
GET /api/smb/shares/{id}/files/{path}      — read a file
GET /api/smb/shares/{id}/files             — list top-level directory (pass ?path= for subdirs)
```

#### Writing to SMB files (via outbox)

**`create_file`:**
```json
{
  "action":  "create_file",
  "path":    "Reports/q1.txt",
  "content": "Q1 report content",
  "shareId": 1
}
```

**`write_file` — overwrite or create:**
```json
{ "action": "write_file", "path": "Reports/q1.txt", "content": "Updated", "shareId": 1 }
```

**`rename_file`:**
```json
{ "action": "rename_file", "oldPath": "Reports/old.txt", "newPath": "Reports/new.txt", "shareId": 1 }
```

**`delete_file`:**
```json
{ "action": "delete_file", "path": "Reports/q1.txt", "shareId": 1 }
```

**`create_directory`:**
```json
{ "action": "create_directory", "path": "Reports/2026", "shareId": 1 }
```

---

### Twitter / X

All Twitter actions go through the outbox. `content` is a **JSON string**.

```json
POST /api/outbox
{
  "source":         "twitter",
  "recipient_id":   "tweet-or-user-id",
  "recipient_name": "Reply to @alice",
  "content": "{\"action\":\"reply\",\"text\":\"Great point!\",\"replyToId\":\"1234567890\"}"
}
```

| `action`   | Required fields                     |
|------------|-------------------------------------|
| `tweet`    | `text`                              |
| `reply`    | `text`, `replyToId`                 |
| `quote`    | `text`, `quotedId`                  |
| `retweet`  | `tweetId`                           |
| `like`     | `tweetId`                           |
| `follow`   | `handle`                            |
| `dm`       | `text`, `conversationId`            |

Or use the dedicated endpoint: `POST /api/twitter/actions` with the same JSON body (not as a string).

---

## Read Endpoints Reference

### Unified Feed & Status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activity` | Unified feed of recent messages and emails — **start here for context** |
| GET | `/api/status` | Connection status + message counts per service |
| GET | `/api/connections` | Live connection state for all services |
| GET | `/api/topology` | Full resource inventory across all services (channels, files, folders) |
| GET | `/api/topology/{service}` | Resource inventory for one service (`gdrive`, `obsidian`, `slack`, etc.) |

Always call `GET /api/activity` first before taking any action. It gives you the context you need.

### Conversations & Messages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chats` | All conversations by platform and type — get `chatId` values here |
| GET | `/api/messages` | Messages in a conversation — `?source=slack&chat_id=C123&limit=50` |
| GET | `/api/search` | Full-text search — `?q=<query>` |
| POST | `/api/unread/{service}/{chatId}/read` | Mark a conversation as read |

`GET /api/messages` params: `source`, `chat_id`, `limit`, `before`, `after`, `around`, `include_meta`

### Contacts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contacts` | Contacts sorted by activity score — supports `?q=name&source=slack` |
| GET | `/api/contacts/{source}/{platformId}` | Full contact profile |
| GET | `/api/contacts/{source}/{platformId}/history` | All messages with this contact |
| GET | `/api/contacts/{source}/{platformId}/dm-channel` | Get DM channel ID (for `recipient_id`) |
| POST | `/api/contacts/{source}/{platformId}/message` | Shortcut: queue a message to this contact |

### Gmail

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/gmail/messages` | List emails — `?q=<search>&unread=true&label=INBOX&limit=50` |
| GET | `/api/gmail/messages/{id}` | Single email metadata |
| GET | `/api/gmail/messages/{id}/body` | Full HTML + plain text body + attachments |
| GET | `/api/gmail/threads/{threadId}` | All messages in a thread |
| GET | `/api/gmail/labels` | All Gmail labels |
| POST | `/api/gmail/actions` | Direct action endpoint (same JSON as outbox content, no wrapping) |

### Calendar

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/calendar/calendars` | All Google Calendars — get `calendarId` values here |
| GET | `/api/calendar/events` | Events in a time range — `?from=<iso>&to=<iso>&calendarId=primary` |
| GET | `/api/calendar/events/{id}` | Single event details |
| POST | `/api/calendar/actions` | Direct action endpoint (same JSON as outbox content, no wrapping) |

### Twitter / X

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/twitter/feed` | Home timeline |
| GET | `/api/twitter/search` | Search — `?q=<query>&mode=Latest\|Top\|People` |
| GET | `/api/twitter/notifications/mentions` | Recent @mentions |
| GET | `/api/twitter/dms` | DM conversations |
| GET | `/api/twitter/dms/{conversationId}` | Messages in a DM conversation |
| GET | `/api/twitter/trends` | Trending topics |
| GET | `/api/twitter/me` | Authenticated user's profile |
| GET | `/api/twitter/user/{handle}` | Any user's profile |
| GET | `/api/twitter/user/{handle}/tweets` | Recent tweets from a user |
| GET | `/api/twitter/user/{handle}/followers` | A user's followers |
| GET | `/api/twitter/user/{handle}/following` | Accounts a user follows |
| GET | `/api/twitter/tweet/{id}` | Single tweet |
| GET | `/api/twitter/tweet/{id}/thread` | Full tweet thread |
| GET | `/api/twitter/analytics` | Engagement metrics for the authenticated user's recent tweets |

### Notion

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/notion/search` | Search all pages and databases — `{ "query": "project roadmap" }` |
| GET | `/api/notion/databases` | List all databases |
| POST | `/api/notion/databases/{id}/query` | Query a database with filters and sorts |
| GET | `/api/notion/pages/{pageId}` | Page metadata and properties |
| GET | `/api/notion/blocks/{pageId}/children` | Page body content (blocks) |
| GET | `/api/notion/blocks/{blockId}` | Single block |
| PATCH | `/api/notion/pages/{pageId}` | Update page properties directly (no outbox) |
| POST | `/api/notion/pages` | Create a new page or database row directly (no outbox) |

### Obsidian Vault

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/obsidian/vaults` | List all configured vaults (name, ID, sync status) |
| GET | `/api/obsidian/files` | File tree of the (first/default) vault |
| GET | `/api/obsidian/files/{path}` | Read a file — URL-encode the path |
| GET | `/api/obsidian/sync/status` | Vault sync state |
| POST | `/api/obsidian/sync` | Trigger a manual sync |

### Google Drive

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/gdrive/folders` | List configured Drive folders (get integer `id` values here) |
| GET | `/api/gdrive/folders/{folderId}` | Single folder config |
| GET | `/api/gdrive/folders/{folderId}/files` | Full file tree for a folder |
| GET | `/api/gdrive/folders/{folderId}/files/{fileId}` | Read a file (Docs → Markdown, Sheets → CSV) |

### SMB Shares

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/smb/shares` | List configured SMB shares |
| GET | `/api/smb/shares/{id}/status` | Connection status of a share |
| GET | `/api/smb/shares/{id}/files` | List a directory — `?path=subdirectory` |
| GET | `/api/smb/shares/{id}/files/{path}` | Read a file |

### Outbox

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/outbox` | Queue any action — messages, file writes, email, calendar, etc. |
| GET | `/api/outbox` | List items — `?status=pending` |
| GET | `/api/outbox/{id}` | Get a single item (poll for status) |
| PATCH | `/api/outbox/{id}` | Approve, reject, or edit — `{ "action": "approve" \| "reject" \| "edit", "content": "..." }` |
| DELETE | `/api/outbox/{id}` | Delete an item |
| POST | `/api/outbox/batch` | Queue the same message to multiple recipients on one platform |
| POST | `/api/outbox/batch/multi` | Queue multiple different actions across platforms in one request |
| GET | `/api/outbox/batch/{batchId}` | Get all items in a batch |
| PATCH | `/api/outbox/batch/{batchId}` | Approve or reject all pending items in a batch — `{ "action": "approve" \| "reject" }` |

---

## Common Workflows

### Get context before acting

```
1. GET /api/connections            — confirm which services are connected
2. GET /api/activity?limit=50      — see the recent cross-platform picture
3. GET /api/messages?chat_id=X&include_meta=true  — drill into a conversation
```

### Edit an Obsidian file

```
1. GET /api/obsidian/files                    — find the file path
2. GET /api/obsidian/files/{path}             — read current content
3. Identify a short, unique search string     — copy it exactly from the API response;
                                                for table rows use only a key fragment
                                                (e.g. the date + first column value),
                                                not the entire row
4. POST /api/outbox  (action: patch_file)     — queue the edit
5. Tell the user it's pending approval
```

**You can do this. Conduit supports editing vault files. Use `patch_file` for targeted edits.**

**Common mistake — do not do this:**
```json
{ "search": "| 7 | May 18, 2026 | Rob Jones Review | Joe, Rob Jones | Google Workspace, GoDaddy, Slack ... |" }
```
**Do this instead:**
```json
{ "search": "| May 18, 2026 | Rob Jones Review |" }
```
The shorter string is unique, stable, and will not be truncated.

### Send a message to someone

```
1. GET /api/contacts?q=Alice              — find contact, note source + platformId
2. GET /api/contacts/{src}/{id}/history   — read context
3. POST /api/contacts/{src}/{id}/message  — queue a message
4. Tell the user the message is pending approval
```

### Handle unread emails

```
1. GET /api/gmail/messages?unread=true         — find what needs attention
2. GET /api/gmail/messages/{id}/body           — read the full email
3. POST /api/outbox  (action: reply or archive) — queue a response
```

### Check and update calendar

```
1. GET /api/calendar/events?from=<today>&to=<next-week>  — see upcoming events
2. POST /api/calendar/actions { action: "rsvp", rsvpStatus: "accepted", ... }
```

### Read and update a Notion database

```
1. GET  /api/notion/databases                          — list databases
2. POST /api/notion/databases/{id}/query  { filter: { property: "Status", select: { equals: "In Progress" } } }
3. PATCH /api/notion/pages/{pageId}  { properties: { "Status": { select: { name: "Done" } } } }
```

### Read a Google Drive document and edit it

```
1. GET /api/topology/gdrive                                  — find folder config id and fileId
2. GET /api/gdrive/folders/{folderId}/files/{fileId}         — read file (returns Markdown for Docs)
3. POST /api/outbox  (action: patch_file, with edits array)  — queue targeted edit
```

### Read an SMB file and overwrite it

```
1. GET /api/smb/shares                         — find share id
2. GET /api/smb/shares/{id}/files/{path}       — read current content
3. POST /api/outbox  (action: write_file)       — queue the write
```

### Search Twitter and post a reply

```
1. GET /api/twitter/search?q=your+query         — find the tweet
2. POST /api/twitter/actions { action: "reply", text: "...", replyToId: "..." }
   OR
   POST /api/outbox { source: "twitter", content: "{\"action\":\"reply\",...}" }
```

---

## Key Reminders for AI Agents

1. **File editing IS possible.** Whether it's an Obsidian vault, Google Drive doc, or SMB share — use `POST /api/outbox` with the appropriate JSON-encoded action. Don't tell the user it can't be done.

2. **Use `patch_file` for targeted edits, not `write_file`.** `write_file` replaces the entire file. `patch_file` finds an anchor string and inserts/replaces/adds around it. The `search` value must match exactly once in the file. **Keep `search` strings short and unique — never copy an entire long table row.** The #1 cause of `patch_file` failures is a `search` string that is too long and gets truncated or mismatches. Use just enough text to uniquely identify the location (a date, a heading, a short phrase).

3. **Batch related outbox requests together using `POST /api/outbox/batch/multi`.** When a task requires multiple write actions on the same service (e.g. editing several Obsidian files, archiving multiple emails, creating several calendar events), send them all in a single `POST /api/outbox/batch/multi` call instead of individual `POST /api/outbox` calls. This groups them into a single card in the outbox UI so the user can review and approve/reject them all at once. Use individual `POST /api/outbox` calls only for truly unrelated one-off actions.

   ```json
   POST /api/outbox/batch/multi
   {
     "operations": [
       { "source": "obsidian", "recipient_id": "Notes/a.md", "recipient_name": "Edit a.md", "content": "{...}" },
       { "source": "obsidian", "recipient_id": "Notes/b.md", "recipient_name": "Edit b.md", "content": "{...}" }
     ]
   }
   ```

   The server also automatically groups rapid sequential `POST /api/outbox` calls for the same service into the same batch, but using `batch/multi` explicitly is preferred as it is atomic.

4. **Always read before writing.** Call the relevant GET endpoint first to get the file path, current content, IDs, and confirm the service is connected.

5. **Check permissions with `GET /api/connections` if an action returns 403.** The `sendEnabled` permission must be configured for the relevant service in Conduit Settings → Permissions.

6. **The outbox is not a limitation — it's the workflow.** Tell the user what you queued and ask them to approve it in the Conduit UI. Don't apologize for needing approval; that's by design.

7. **`content` must be a valid JSON string for structured platforms.** For `obsidian`, `smb`, `gdrive`, `gmail`, `calendar`, and `notion` outbox actions, the `content` field is a JSON-encoded string (i.e., the JSON object serialised as a string). For `slack`, `discord`, `telegram`, and `twitter`, `content` is plain text.

8. **URL-encode file paths.** When calling `GET /api/obsidian/files/{path}`, spaces become `%20` and slashes within the path become `%2F`. Example: `Daily Notes/2026-05-26.md` → `Daily%20Notes%2F2026-05-26.md`.

9. **For Notion writes, prefer the direct endpoints.** `PATCH /api/notion/pages/{pageId}` and `POST /api/notion/pages` execute immediately without going through the outbox. Use them for property updates and page creation. The outbox is only needed for `append_blocks` and `archive_page` style operations.

10. **For Google Drive, the `folderId` in URLs is the integer config ID**, not the Google Drive folder ID. Get it from `GET /api/gdrive/folders` or `GET /api/topology/gdrive`.

11. **Use `GET /api/topology` as your discovery tool.** It shows everything Conduit can see — vaults, Drive folders, channels, file trees — in one call.
