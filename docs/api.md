# Conduit API Reference

Conduit exposes a REST API designed for AI agents and custom integrations. All endpoints are under `/api` and require an API key.

The machine-readable OpenAPI 3.0 spec is available at **`GET /api/openapi.json`** once the server is running. You can import it into any OpenAPI-compatible tool (Postman, Insomnia, etc.).

---

## Authentication

All requests require an `X-API-Key` header.

```
X-API-Key: your-api-key-here
```

Generate a key in **Settings → Permissions** in the web UI. API keys bypass the UI login session — agents always authenticate with the key, not a cookie.

---

## Base URL

```
http://localhost:3101/api
```

---

## Outbox / Approval Flow

Most write actions (send message, reply to email, RSVP, tweet, etc.) do **not** execute immediately. They create an **outbox item** with `status=pending`. A human approves or rejects it in the UI before anything is sent. (If the service's `requireApproval` permission is switched off for the actor, the item is created pre-approved and dispatched immediately.)

After submitting a write action, poll `GET /outbox/{id}` or `GET /outbox?status=pending` to check status.

**Exception:** the Notion direct write endpoints — `PATCH /notion/pages/{pageId}` and `POST /notion/pages` — execute immediately against the Notion API with no outbox item (see the Notion section).

---

## Response Conventions

- **`rawJson` is never returned.** List endpoints strip the raw serialised platform payload from every row. API-key actors additionally do not receive `attachments`/`embeds` on message rows.
- **`GET /messages` returns a real `total`** — the true count of matching rows across all queried sources, suitable for pagination.
- **Per-chat unread counts** appear as an `unread` field on each chat entry in `GET /chats`.
- **Source filters apply everywhere.** The user can restrict each platform to selected sources (Discord servers, Slack channels, Telegram groups/channels) in Settings → service → Sources. Excluded sources are omitted from `/chats`, `/digest`, `/activity` and `/search`; direct messages are always included.

---

## Data Models

### Message

A single message from any connected platform.

| Field | Type | Description |
|---|---|---|
| `source` | string | Platform: `slack`, `discord`, `telegram`, `twitter`, `gmail` |
| `messageId` | string | Platform-native message ID |
| `chatId` | string | ID of the conversation/channel this message belongs to |
| `chatName` | string \| null | Human-readable name of the conversation |
| `content` | string | Message text or email snippet |
| `senderName` | string | Display name, resolved from contacts table when available |
| `senderAvatarUrl` | string \| null | Avatar URL |
| `isMe` | boolean | True when sent by the authenticated Conduit user |
| `timestamp` | datetime | ISO 8601 timestamp |

### ActivityItem

A unified activity event — either a message or an email.

| Field | Type | Description |
|---|---|---|
| `type` | string | `message` or `email` |
| `source` | string | Platform: `slack`, `discord`, `telegram`, `twitter`, `gmail` |
| `timestamp` | datetime | ISO 8601 |
| `messageId` | string | |
| `chatId` | string | |
| `chatName` | string \| null | |
| `content` | string | Message text or email snippet |
| `senderName` | string | |
| `isMe` | boolean | |
| `context` | string | `dm`, `group`, or `channel` |
| `subject` | string \| null | Email subject (only for `type=email`) |
| `isRead` | boolean | Email read state (only for `type=email`) |

### Contact

A person you have communicated with across any connected platform.

| Field | Type | Description |
|---|---|---|
| `source` | string | Platform |
| `platformId` | string | The user's ID on their platform |
| `displayName` | string \| null | |
| `username` | string \| null | |
| `phone` | string \| null | |
| `avatarUrl` | string \| null | |
| `bio` | string \| null | |
| `mutualGroupIds` | string[] | IDs of groups/channels you both participate in |
| `criteria.hasDm` | boolean | You have exchanged DMs |
| `criteria.isFromSmallGroup` | boolean | You share a small group |
| `criteria.isNativeContact` | boolean | In your platform contact list |
| `lastMessageAt` | datetime \| null | |
| `activityScore` | number | DM messages × 3 + shared channel messages × 1 |
| `messageCount` | number | Total messages from this contact in the local database |

### Tweet

| Field | Type | Description |
|---|---|---|
| `id` | string | Tweet ID — use for reply/quote/retweet/like actions |
| `text` | string | Full tweet text |
| `authorName` | string | Display name |
| `authorHandle` | string | Twitter @handle (without the @) |
| `authorId` | string | Numeric Twitter user ID |
| `timestamp` | datetime | |
| `likes` | integer | |
| `retweets` | integer | |
| `replies` | integer | |
| `isRetweet` | boolean | |
| `quotedTweetId` | string \| null | ID of the quoted tweet, if this is a quote tweet |
| `replyToId` | string \| null | ID of the parent tweet, if this is a reply |
| `isMe` | boolean | True if posted by the authenticated user |

### OutboxItem

| Field | Type | Description |
|---|---|---|
| `id` | integer | |
| `source` | string | |
| `recipientId` | string | |
| `recipientName` | string \| null | |
| `content` | string | |
| `status` | string | `pending`, `approved`, `sent`, `rejected`, `failed` |
| `createdAt` | datetime | |
| `sentAt` | datetime \| null | |

---

## Endpoints

### Context & Activity

---

#### `GET /activity`

Returns a chronological feed of recent messages and emails across all connected platforms. This is the primary endpoint for getting context — use it before taking any action.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `since` | datetime | Start of the time window (ISO 8601). Default: 24 hours ago. |
| `until` | datetime | End of the time window. Default: now. |
| `limit` | integer | Max items to return. Default 50, max 200. |
| `sources` | string | Comma-separated platforms to include. Default: all. Options: `slack`, `discord`, `telegram`, `twitter`, `gmail`. |

**Response**

```json
{
  "items": [ ActivityItem ],
  "total": 142,
  "since": "2026-04-05T00:00:00Z",
  "until": "2026-04-06T00:00:00Z"
}
```

**Example**

```
GET /api/activity?since=2026-04-01T00:00:00Z&limit=100
```

---

#### `GET /digest`

The one-call agent briefing: answers "what needs my attention?" in a single bounded response instead of many raw-list round trips. Fine-grained permissions apply — API keys only see sources, chats, and labels their key can read.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `since` | datetime | ISO 8601. Bounds the `needsReply` window. Default: 24 hours ago. |
| `meetings_days` | integer | How many days back to include in `recentMeetings`. Default 14, max 60. |

**Response**

```json
{
  "generatedAt": "2026-04-06T12:00:00Z",
  "window": { "since": "2026-04-05T12:00:00Z", "until": "2026-04-06T12:00:00Z" },
  "needsReply": [
    {
      "source": "slack",
      "chatId": "D04XYZ",
      "chatName": "Alice",
      "lastMessage": { "senderName": "Alice", "excerpt": "Any update on…", "timestamp": "2026-04-06T11:00:00Z" },
      "unread": 3
    }
  ],
  "unreadEmail": {
    "count": 12,
    "topSenders": [ { "name": "Alice", "count": 4 } ],
    "latest": [
      { "gmailId": "18f3a...", "threadId": "18f3a...", "from": "Alice", "subject": "Project update", "receivedAt": "2026-04-06T09:00:00Z" }
    ]
  },
  "upcomingEvents": [
    { "eventId": "abc123", "title": "Team standup", "startTime": "2026-04-07T09:00:00Z", "endTime": "2026-04-07T09:30:00Z", "meetLink": null, "attendeeCount": 4 }
  ],
  "recentMeetings": [
    { "id": 12, "title": "Planning sync", "meetingDate": "2026-04-03T15:00:00Z", "excerpt": "Discussed Q2 roadmap…" }
  ],
  "pendingOutbox": {
    "count": 2,
    "items": [ { "id": 42, "source": "slack", "recipientName": "Alice", "preview": "Sounds good…", "createdAt": "2026-04-06T10:30:00Z" } ]
  },
  "unreadBySource": { "slack": 5, "telegram": 2, "gmail": 12 }
}
```

| Section | Contents |
|---|---|
| `needsReply` | Chats whose latest message is from someone else and newer than the chat's read cursor (max 15). |
| `unreadEmail` | Unread count + top 5 senders + latest 5 unread subjects. `null` when Gmail read access is not permitted. |
| `upcomingEvents` | Events in the next 7 days (max 10). |
| `recentMeetings` | Meet notes within `meetings_days`, excerpted (max 10). |
| `pendingOutbox` | Outbox items awaiting approval (`count` is the full total; `items` max 10). |
| `unreadBySource` | Per-service unread totals. |

---

#### `GET /context`

Self-description endpoint for agent bootstrap — **no authentication required**. Returns Conduit's version, capabilities with example calls, the live connection state of every configured service (including per-account/vault/share detail), and helpful links (settings, OpenAPI spec, topology). Cached for 1 hour (`ETag` + `Cache-Control`); the cache invalidates automatically when a service connects or disconnects.

**Response**: `{ "conduit": { version, description, baseUrl, authMethod, capabilities: [...] }, "services": [ ... ], "helpfulLinks": { ... } }`

---

#### `GET /skill`

Returns the Conduit agent skill definition (`SKILL.md`) as raw Markdown — **no authentication required**. Response `Content-Type` is `text/markdown`. Returns `404` if the skill file is missing.

---

#### `GET /status`

Returns connection status for all platforms, total message counts in the local database, and information about any currently-running syncs.

**Response**

```json
{
  "slack": {
    "connected": true,
    "messageCount": 4821,
    "chatCount": 37,
    "lastSync": "2026-04-06T08:00:00Z",
    "activeSyncs": 0,
    "error": null
  },
  "telegram": { ... },
  ...
}
```

---

#### `GET /connections`

Returns the live connection state for every configured platform. Check this before making platform-specific calls to confirm a service is connected.

**Response**

```json
[
  {
    "service": "slack",
    "connected": true,
    "status": "connected",
    "error": null,
    "lastSync": "2026-04-06T08:00:00Z"
  },
  ...
]
```

`status` values: `connected`, `connecting`, `disconnected`, `error`

---

### Messages

---

#### `GET /messages`

Fetch messages from the local database. Returns a specific conversation (use `chat_id`) or all recent messages across platforms.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `source` | string | Filter to one platform. If omitted, returns all. |
| `chat_id` | string | Conversation ID (from `GET /chats`). If omitted, returns messages across all conversations. |
| `limit` | integer | Default 50, max 500. |
| `before` | datetime | Return messages before this timestamp (pagination cursor). |
| `after` | datetime | Return messages after this timestamp. |
| `around` | datetime | Return messages centred on this timestamp (half before, half after). |
| `include_meta` | boolean | When true and `chat_id` is set, includes a `conversationMeta` object with participants. |

**Response**

```json
{
  "messages": [ Message ],
  "total": 250,
  "conversationMeta": {
    "chatId": "C04ABCD1234",
    "chatName": "#engineering",
    "source": "slack",
    "type": "channel",
    "participants": [
      { "platformId": "U123", "displayName": "Alice", "avatarUrl": "...", "isMe": false, "messageCount": 42 }
    ]
  }
}
```

`conversationMeta` is only present when `include_meta=true` and `chat_id` is provided.

`total` is the true count of matching rows across all queried sources (not capped at the page size), so it can be used for pagination. Message rows never include `rawJson`; API-key actors additionally do not receive `attachments`/`embeds`.

---

#### `GET /search`

Full-text search across all messages in the local database.

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | yes | Search query — searches message content across all platforms. |
| `source` | string | no | Filter to one platform. |
| `limit` | integer | no | Default 50, max 200. |

**Response**

```json
{
  "results": [ Message ]
}
```

---

#### `GET /chats`

Returns a structured tree of all synced conversations grouped by platform and type. Use this to discover available conversations and get `chat_id` values for `GET /messages`.

**Response**

```json
{
  "slack": {
    "source": "slack",
    "sections": [
      {
        "label": "Direct Messages",
        "type": "dms",
        "chats": [
          { "id": "D04XYZ", "name": "Alice", "source": "slack", "messageCount": 120, "lastTs": "2026-04-06T10:00:00Z", "unread": 3 }
        ]
      },
      {
        "label": "Channels",
        "type": "channels",
        "chats": [ ... ]
      }
    ]
  },
  "discord": { ... },
  ...
}
```

Each chat entry includes an `unread` count — the number of messages newer than the chat's read cursor that were not sent by you.

---

#### `POST /chats/{source}/{chatId}/read`

Sets the chat's read cursor, clearing its `unread` count. **UI session only** — this endpoint is not available to API keys.

**Path parameters**

| Parameter | Values |
|---|---|
| `source` | `telegram`, `discord`, `slack`, `twitter`, `gmail` |
| `chatId` | Conversation ID from `GET /chats` |

**Request body** (optional)

```json
{ "at": "2026-04-06T12:00:00Z" }
```

`at` — ISO timestamp to set the read cursor to. Defaults to now.

**Response**

```json
{ "success": true, "source": "slack", "chatId": "D04XYZ", "lastReadAt": "2026-04-06T12:00:00Z" }
```

---

#### `POST /chats/read-all`

Marks every known chat as read, optionally limited to one source. **UI session only** — not available to API keys.

**Request body** (optional)

```json
{ "source": "slack" }
```

Omit `source` to mark all of `telegram`, `discord`, `slack`, and `twitter` read.

**Response**

```json
{ "success": true, "marked": 42 }
```

---

### Contacts

---

#### `GET /contacts`

Returns contacts from all platforms sorted by activity score (highest first). The most actively communicated-with people appear first.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `source` | string | Filter to one platform. |
| `q` | string | Search by display name, username, first name, or last name. |
| `criteria` | string | Filter by relationship: `dm`, `owned`, `small`, `native`. |
| `limit` | integer | Default 50, max 500. |
| `offset` | integer | Default 0. |

**Response**

```json
{
  "contacts": [ Contact ],
  "total": 87
}
```

---

#### `GET /contacts/{source}/{platformId}`

Returns the full profile for a specific contact.

**Path parameters**

| Parameter | Description |
|---|---|
| `source` | Platform (e.g. `slack`, `telegram`) |
| `platformId` | The contact's platform-native user ID |

**Response**: `Contact` object. Returns `404` if not found.

---

#### `GET /contacts/{source}/{platformId}/history`

Returns all messages from this person in the local database — across DMs and shared groups/channels — sorted newest first.

**Path parameters**: same as above.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Default 100, max 500. |
| `after` | datetime | Return only messages after this timestamp. |
| `before` | datetime | Pagination cursor — return messages older than this timestamp. |

**Response**

```json
{
  "messages": [ Message ],
  "total": 58,
  "source": "telegram",
  "platformId": "123456789"
}
```

---

#### `POST /contacts/{source}/{platformId}/message`

Queues a message to this contact through the approval outbox.

**Path parameters**: same as above. Supported sources: `slack`, `discord`, `telegram`, `twitter`.

**Request body**

```json
{
  "content": "Hi! Following up on our conversation about the project deadline."
}
```

**Response**

```json
{
  "success": true,
  "status": "pending",
  "outboxItemId": 42
}
```

`status=pending` means the message awaits human approval. `status=sent` means it was delivered immediately (requires `directSendFromUi` permission).

Returns `403` if sending is not enabled for this service.

---

#### `GET /contacts/{source}/{platformId}/dm-channel`

Returns the platform-native DM channel ID for a contact. Use this to get the `channelId` / `recipient_id` needed for `POST /outbox` when you only have a contact's `platformId`.

Supported sources: `slack`, `discord`, `telegram`.

**Path parameters**: same as above.

**Response**

```json
{
  "channelId": "D04XYZ123",
  "channelName": "alice"
}
```

Pass the returned `channelId` as `recipient_id` in `POST /outbox`.

---

### Outbox

---

#### `GET /outbox`

Lists messages queued for sending. Filter by `status=pending` to find messages awaiting approval.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `status` | string | `pending`, `approved`, `sent`, `rejected`, `failed` |
| `source` | string | Filter to one platform. |
| `limit` | integer | Page size. Default 50, max 200. |
| `offset` | integer | Default 0. |

**Response**

```json
{
  "items": [ OutboxItem ],
  "total": 120,
  "pendingCount": 3,
  "limit": 50,
  "offset": 0
}
```

`total` is the count of items matching the `status`/`source` filters. `pendingCount` is the actor's global pending total, **not** affected by the filters (the UI badge relies on this). API-key actors only ever see their own items.

---

#### `POST /outbox`

Queues a message to any platform. The `recipient_id` is the platform-native channel or user ID. For DMs, use the contact's `platformId`. For channels, use the channel ID from `GET /chats`.

**Request body**

```json
{
  "source": "slack",
  "recipient_id": "D04XYZ",
  "recipient_name": "Alice",
  "content": "Message text here"
}
```

**Request headers**

| Header | Description |
|---|---|
| `Idempotency-Key` | Optional. A retried POST carrying the same key returns the original outbox item (with `"idempotent": true`) instead of queueing a duplicate. Returns `409` if the key was used by a different API key. |

**Response**: `OutboxItem` object.

---

#### `GET /outbox/{id}`

Returns a single outbox item by its numeric ID. Use this to poll for status changes after queuing a message.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Outbox item ID (integer) |

**Response**: `OutboxItem` object. Returns `404` if not found.

---

#### `PATCH /outbox/{id}`

Approve, reject, or edit a pending outbox item.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Outbox item ID (integer) |

**Request body**

```json
{
  "action": "approve"
}
```

| Field | Type | Description |
|---|---|---|
| `action` | string | `approve` — send immediately; `reject` — discard; `edit` — update content |
| `content` | string | New message text (only used with `action=edit`) |

**Response**: Updated `OutboxItem` for `edit`; `{ success: true, status: "sent" }` for `approve`; `{ success: true, status: "rejected" }` for `reject`.

---

#### `POST /outbox/{id}/retry`

Re-dispatches a **failed** outbox item. Returns `409` if the item is not in `failed` status, and `403` if sending is no longer enabled for the item's service.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Outbox item ID (integer) |

**Response**: `{ "success": true, "status": "sent" }` on success; `500` with the error message (item returns to `failed`) if dispatch fails again.

---

#### `DELETE /outbox/{id}`

Permanently removes an outbox item. This does **not** send the message. Items with status `sent` or `approved` cannot be deleted (`409`).

**Response**: `{ "success": true }`

---

#### `POST /outbox/batch`

Queues the same message to multiple recipients on the same platform. All items share a `batchId`.

**Request body**

```json
{
  "source": "slack",
  "recipient_ids": [
    { "id": "D04XYZ", "name": "Alice" },
    { "id": "D04ABC", "name": "Bob" }
  ],
  "content": "Quick update: the deadline is moved to Friday."
}
```

**Response**

```json
{
  "batchId": "uuid-...",
  "items": [ OutboxItem, OutboxItem ]
}
```

---

#### `POST /outbox/batch/multi`

Queues a heterogeneous batch of messages across different platforms in a single request. All items share a `batchId` for coordinated review. Each operation is permission-checked independently.

**Request body**

```json
{
  "operations": [
    { "source": "slack",    "recipient_id": "D04XYZ", "recipient_name": "Alice", "content": "Hey!" },
    { "source": "telegram", "recipient_id": "123456",  "recipient_name": "Bob",   "content": "Hey!" }
  ]
}
```

For structured services (`gmail`, `calendar`, `notion`), `content` should be a JSON-stringified action payload.

**Response**: `{ batchId: string, items: OutboxItem[] }`

Returns `403` if `sendEnabled` is not set for any of the specified services.

---

### Gmail

---

#### `GET /gmail/messages`

Lists Gmail message metadata (sender, subject, snippet, labels, read state). Full bodies are not included — use `GET /gmail/messages/{id}/body` for that.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `q` | string | Search query (searches subject, from, snippet). |
| `label` | string | Filter by Gmail label, e.g. `INBOX`, `STARRED`, `UNREAD`. |
| `unread` | boolean | If true, returns only unread messages. |
| `limit` | integer | Default 50, max 200. |

**Response**

```json
{
  "messages": [
    {
      "gmailId": "18f3a...",
      "threadId": "18f3a...",
      "from": "Alice <alice@example.com>",
      "to": ["you@example.com"],
      "subject": "Project update",
      "snippet": "Just wanted to let you know that...",
      "labels": ["INBOX", "UNREAD"],
      "isRead": false,
      "isStarred": false,
      "date": "2026-04-06T09:00:00Z",
      "hasAttachments": false
    }
  ],
  "total": 12
}
```

---

#### `GET /gmail/messages/{id}`

Returns the full metadata for a single Gmail message — sender, recipients, subject, snippet, labels, and read/starred state.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Gmail message ID (`gmailId` from list response) |

**Response**: Gmail message object. Returns `404` if not found in local database.

---

#### `GET /gmail/messages/{id}/body`

Fetches the full HTML and plain-text body of an email. Use `gmailId` from the list response.

**Response**

```json
{
  "html": "<div>Full email HTML...</div>",
  "text": "Full plain text...",
  "attachments": [
    { "name": "report.pdf", "mimeType": "application/pdf", "size": 204800 }
  ]
}
```

---

#### `GET /gmail/threads/{threadId}`

Returns all messages in an email thread in chronological order.

**Response**

```json
{
  "threadId": "18f3a...",
  "messages": [ GmailMessage ],
  "total": 4
}
```

---

#### `POST /gmail/actions`

Performs an action on a Gmail message. All actions go through the outbox for human approval.

**Request body**

```json
{
  "action": "reply",
  "messageId": "18f3a...",
  "threadId": "18f3a...",
  "to": ["alice@example.com"],
  "subject": "Re: Project update",
  "body": "Thanks for the update! I'll review by EOD."
}
```

**`action` values**: `reply`, `reply_all`, `forward`, `compose`, `archive`, `trash`, `spam`, `mark_read`, `mark_unread`, `star`, `unstar`, `unsubscribe`

**Response**

```json
{
  "success": true,
  "outboxItemId": 7,
  "status": "pending"
}
```

---

#### `GET /gmail/labels`

Lists all Gmail labels on the account, including system labels (`INBOX`, `SENT`, `TRASH`, etc.) and any custom labels.

**Response**

```json
{
  "labels": [
    { "id": "INBOX", "name": "INBOX", "type": "system" },
    { "id": "Label_123", "name": "Project Alpha", "type": "user" }
  ]
}
```

Use label `id` values with `GET /gmail/messages?label=` to filter messages.

---

### Calendar

---

#### `GET /calendar/calendars`

Lists all Google Calendars the user has access to, including their primary calendar and any shared or subscribed calendars.

**Response**

```json
{
  "calendars": [
    {
      "id": "primary",
      "summary": "My Calendar",
      "primary": true,
      "accessRole": "owner",
      "color": "#039BE5"
    },
    {
      "id": "team@example.com",
      "summary": "Team Calendar",
      "primary": false,
      "accessRole": "reader"
    }
  ]
}
```

Use the returned `id` values with `GET /calendar/events?calendarId=` and `POST /calendar/actions`.

---

#### `GET /calendar/events`

Lists calendar events for a time range. Defaults to today through the next 7 days.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `from` | datetime | Start of range. Default: today. |
| `to` | datetime | End of range. Default: today + 7 days. |
| `calendarId` | string | Filter to a specific calendar. Default: all. |

**Response**

```json
{
  "events": [
    {
      "eventId": "abc123xyz",
      "calendarId": "primary",
      "title": "Team standup",
      "description": null,
      "location": null,
      "start": "2026-04-07T09:00:00Z",
      "end": "2026-04-07T09:30:00Z",
      "organizer": "alice@example.com",
      "attendees": [
        { "email": "you@example.com", "displayName": "You", "rsvpStatus": "accepted", "self": true },
        { "email": "alice@example.com", "displayName": "Alice", "rsvpStatus": "accepted", "self": false }
      ],
      "meetLink": "https://meet.google.com/abc-defg-hij",
      "rsvpStatus": "accepted",
      "isRecurring": true,
      "status": "confirmed"
    }
  ],
  "total": 3
}
```

---

#### `GET /calendar/events/{id}`

Returns the full details of a single calendar event by its Google Calendar event ID.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Google Calendar event ID (`eventId` from list response) |

**Response**: Full calendar event object (same shape as items in `GET /calendar/events`). Returns `404` if not found in local database.

---

#### `POST /calendar/actions`

Creates, updates, deletes, or RSVPs to a calendar event. All changes go through the outbox for human approval.

**Request body**

```json
{
  "action": "rsvp",
  "calendarId": "primary",
  "eventId": "abc123xyz",
  "rsvpStatus": "accepted"
}
```

**`action` values**: `create`, `update`, `delete`, `rsvp`

For `action=create`:
```json
{
  "action": "create",
  "calendarId": "primary",
  "title": "Sync with Alice",
  "start": "2026-04-08T14:00:00Z",
  "end": "2026-04-08T14:30:00Z",
  "attendees": ["alice@example.com"]
}
```

**Response**

```json
{
  "success": true,
  "outboxItemId": 15,
  "status": "pending"
}
```

---

### Meet Notes

Google Meet "Smart Notes" synced from Drive. All Meet Notes endpoints are gated by the **calendar** read permission.

---

#### `GET /meet-notes`

Lists meeting notes, newest first.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Default 50, max 200. |
| `offset` | integer | Default 0. |
| `q` | string | Substring search across note title and summary. |
| `account_id` | string | Filter to one Google account (email). |
| `from` | datetime | Only notes with `meetingDate` ≥ this ISO timestamp. |
| `to` | datetime | Only notes with `meetingDate` ≤ this ISO timestamp. |

**Response**

```json
{
  "notes": [
    {
      "id": 12,
      "title": "Planning sync",
      "meetingDate": "2026-04-03T15:00:00Z",
      "summary": "Discussed Q2 roadmap...",
      "accountId": "you@example.com",
      "driveFileId": "1abc..."
    }
  ],
  "total": 87,
  "limit": 50,
  "offset": 0
}
```

---

#### `GET /meet-notes/{id}`

Returns a single note in full (including content/transcript fields). Returns `404` if not found.

`POST /meet-notes/sync` triggers an incremental sync from Drive for all connected Google accounts.

---

### Twitter / X

---

#### `GET /twitter/feed`

Returns recent tweets from the authenticated user's home timeline. Results are cached for 15 minutes.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `count` | integer | Number of tweets to return. Default 20. |

**Response**

```json
{
  "tweets": [ Tweet ]
}
```

---

#### `GET /twitter/search`

Searches Twitter for tweets or user profiles.

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | yes | Search query. |
| `mode` | string | no | `Latest`, `Top`, or `People`. Default `Latest`. |
| `count` | integer | no | Default 20. |

**Response** (mode=Latest or mode=Top)

```json
{
  "tweets": [ Tweet ]
}
```

**Response** (mode=People) — response key is `profiles`, not `tweets`:

```json
{
  "profiles": [
    {
      "userId": "123456",
      "displayName": "Alice",
      "handle": "alice",
      "bio": "...",
      "followersCount": 1200,
      "followingCount": 400,
      "avatarUrl": "...",
      "verified": false
    }
  ]
}
```

---

#### `GET /twitter/trends`

Returns the current list of trending topics on Twitter/X. Cached for 15 minutes.

**Response**

```json
{
  "trends": [
    {
      "name": "#OpenAI",
      "tweetCount": "12.4K",
      "url": "https://twitter.com/search?q=%23OpenAI"
    }
  ]
}
```

---

#### `GET /twitter/me`

Returns the authenticated user's own profile.

**Response**: `TwitterProfile` object (see below).

---

#### `GET /twitter/tweet/{id}`

Fetches a single tweet by its ID.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Tweet ID |

**Response**: `Tweet` object. Returns `404` if not found.

---

#### `GET /twitter/tweet/{id}/thread`

Returns the full thread for a given tweet — the tweet itself plus all replies in conversation order.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Tweet ID to fetch the thread for |

**Response**

```json
{
  "tweets": [ Tweet ]
}
```

---

#### `GET /twitter/user/{handle}`

Returns the full public profile for any Twitter/X user by their @handle. Cached 15 minutes.

**Path parameters**

| Parameter | Description |
|---|---|
| `handle` | Twitter @handle without the @ (e.g. `alice`) |

**Response**: `TwitterProfile` object. Returns `404` if the user does not exist.

### TwitterProfile

| Field | Type | Description |
|---|---|---|
| `userId` | string | Numeric Twitter user ID |
| `displayName` | string | Display name |
| `handle` | string | @handle (without the @) |
| `bio` | string \| null | Biography/description |
| `followersCount` | integer | Follower count |
| `followingCount` | integer | Following count |
| `avatarUrl` | string \| null | Profile image URL |
| `verified` | boolean | Has a verified badge |
| `tweetCount` | integer \| null | Total tweets posted |

---

#### `GET /twitter/user/{handle}/tweets`

Returns the most recent tweets from the given @handle. Cached 15 minutes.

**Path parameters**: `handle` — @handle without the @.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `count` | integer | Default 20. |

**Response**

```json
{
  "tweets": [ Tweet ]
}
```

---

#### `GET /twitter/user/{handle}/followers`

Returns a list of profiles that follow the given @handle. Cached 15 minutes.

**Path parameters**: `handle` — @handle without the @.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `count` | integer | Default 50. |

**Response**

```json
{
  "profiles": [ TwitterProfile ]
}
```

---

#### `GET /twitter/user/{handle}/following`

Returns a list of profiles that the given @handle is following. Cached 15 minutes.

**Path parameters**: `handle` — @handle without the @.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `count` | integer | Default 50. |

**Response**

```json
{
  "profiles": [ TwitterProfile ]
}
```

---

#### `GET /twitter/notifications/mentions`

Returns tweets that @mention the authenticated user.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `count` | integer | Default 20. |

**Response**

```json
{
  "mentions": [ Tweet ]
}
```

---

#### `GET /twitter/dms`

Returns synced Twitter DM conversations grouped by `conversationId`, sorted by most recent message. Requires DM read permission for the API key.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Default 50, max 100. |
| `offset` | integer | Default 0. |

**Response**

```json
{
  "conversations": [
    {
      "conversationId": "123456-789012",
      "participantIds": ["123456", "789012"],
      "otherName": "Alice",
      "otherHandle": "alice",
      "otherAvatarUrl": "https://...",
      "lastMessage": {
        "conversationId": "123456-789012",
        "messageId": "...",
        "senderId": "123456",
        "senderHandle": "alice",
        "senderName": "Alice",
        "text": "Sounds good!",
        "createdAt": "2026-04-06T11:00:00Z"
      },
      "messageCount": 24
    }
  ],
  "total": 12
}
```

`otherName` / `otherHandle` / `otherAvatarUrl` describe the participant who is not the authenticated user. `lastMessage` is the stored DM row. `total` is the total number of conversations (before `limit`/`offset` are applied).

---

#### `GET /twitter/dms/{conversationId}`

Returns all stored messages in a specific DM conversation, oldest first. Requires DM read permission for the API key.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Default 100. |

**Response**

```json
{
  "conversationId": "123456-789012",
  "messages": [
    {
      "conversationId": "123456-789012",
      "messageId": "...",
      "senderId": "123456",
      "senderHandle": "alice",
      "senderName": "Alice",
      "senderAvatarUrl": "https://...",
      "text": "Hey!",
      "createdAt": "2026-04-06T11:00:00Z"
    }
  ]
}
```

---

#### `POST /twitter/actions`

Performs a Twitter action through the outbox for human approval.

**Request body**

```json
{
  "action": "reply",
  "text": "Great point!",
  "replyToId": "1234567890"
}
```

**`action` values and required fields**

| Action | Required fields |
|---|---|
| `tweet` | `text` |
| `reply` | `text`, `replyToId` |
| `quote` | `text`, `quotedId` |
| `retweet` | `tweetId` |
| `like` | `tweetId` |
| `follow` | `handle` |
| `dm` | `text`, `conversationId` |

**Response**

```json
{
  "success": true,
  "outboxItemId": 23,
  "status": "pending"
}
```

---

#### `GET /twitter/analytics`

Returns engagement metrics for the authenticated user's recent tweets, aggregated by day. Cached for 15 minutes.

**Response**

```json
{
  "summary": {
    "totalLikes": 142,
    "totalRetweets": 28,
    "totalReplies": 37,
    "totalTweets": 14,
    "avgLikesPerTweet": 10.1,
    "avgRetweetsPerTweet": 2.0,
    "bestTweet": {
      "id": "...",
      "text": "Just shipped a new feature!",
      "likes": 87,
      "retweets": 12,
      "replies": 9,
      "timestamp": "2026-04-04T15:00:00Z"
    }
  },
  "byDay": [
    { "date": "2026-04-01", "tweets": 2, "likes": 18, "retweets": 4, "replies": 5 }
  ],
  "tweets": [ Tweet ]
}
```

---

### Notion

Notion endpoints are direct passthroughs to the Notion API:

- **Read endpoints** are gated by the `readEnabled` permission for the `notion` service and execute immediately (no outbox). All reads are written to the audit log.
- **Direct write endpoints** — `PATCH /notion/pages/{pageId}` and `POST /notion/pages` — are gated by the `sendEnabled` permission and also execute **immediately**, with no outbox item and no approval step.
- **Other write operations** (`append_blocks`, `archive_page`, and batch workflows) go through `POST /outbox` (or `POST /outbox/batch/multi`) with `source: "notion"` and follow the normal approval flow.

---

#### `GET /notion/pages/{pageId}`

Retrieves a Notion page by its ID. Returns raw Notion API page object including all properties.

**Path parameters**

| Parameter | Description |
|---|---|
| `pageId` | Notion page UUID (dashes optional) |

**Response**: Raw Notion API page object.

```json
{
  "id": "page-uuid",
  "object": "page",
  "properties": { ... },
  "url": "https://www.notion.so/page-uuid"
}
```

Use `GET /notion/blocks/{pageId}/children` to read the page body.

---

#### `PATCH /notion/pages/{pageId}`

Updates an existing Notion page — a **direct write** that executes immediately with no outbox or approval step. The request body is passed through as-is to the Notion `PATCH /v1/pages/:id` API. Requires the `sendEnabled` permission for the `notion` service.

**Path parameters**

| Parameter | Description |
|---|---|
| `pageId` | Notion page UUID (dashes optional) |

**Request body**

```json
{
  "properties": {
    "Status": { "select": { "name": "Done" } }
  }
}
```

Only include properties you want to change. Set `in_trash: true` to move the page to trash.

**Response**: Raw Notion API updated page object.

---

#### `POST /notion/pages`

Creates a new Notion page — a **direct write** that executes immediately with no outbox or approval step. The request body is passed through as-is to the Notion `POST /v1/pages` API. Requires the `sendEnabled` permission for the `notion` service.

**Request body**

```json
{
  "parent": { "database_id": "db-uuid" },
  "properties": {
    "Name": { "title": [ { "text": { "content": "New row" } } ] },
    "Status": { "select": { "name": "To Do" } }
  }
}
```

Use `parent.database_id` to create a database row, or `parent.page_id` to create a sub-page. `children` (array of block objects) is optional.

**Response**: `201 Created` with the raw Notion API page object.

---

#### `GET /notion/databases`

Lists all Notion databases accessible to the configured integration token.

**Response**: Raw Notion API list response.

```json
{
  "results": [
    {
      "id": "db-uuid",
      "object": "database",
      "title": [ { "plain_text": "Tasks" } ],
      "properties": { ... }
    }
  ],
  "has_more": false
}
```

---

#### `POST /notion/databases/{databaseId}/query`

Queries a Notion database. Supports Notion filter and sort syntax.

**Path parameters**

| Parameter | Description |
|---|---|
| `databaseId` | Notion database UUID |

**Request body**

```json
{
  "filter": {
    "property": "Status",
    "select": { "equals": "In Progress" }
  },
  "sorts": [
    { "property": "Due Date", "direction": "ascending" }
  ],
  "page_size": 50
}
```

All fields are optional. Use `start_cursor` from a previous response for pagination.

**Response**: Raw Notion API paginated results.

```json
{
  "results": [ NotionPage ],
  "has_more": true,
  "next_cursor": "..."
}
```

---

#### `POST /notion/search`

Searches across all pages and databases in the Notion workspace accessible to the integration.

**Request body**

```json
{
  "query": "project roadmap",
  "filter": { "value": "page", "property": "object" },
  "sort": { "direction": "descending", "timestamp": "last_edited_time" },
  "page_size": 20
}
```

All fields optional. Omit `query` to list all accessible objects.

**Response**: Raw Notion API search results.

---

#### `GET /notion/blocks/{blockId}`

Retrieves a single Notion block by its ID.

**Path parameters**

| Parameter | Description |
|---|---|
| `blockId` | Notion block UUID |

**Response**: Raw Notion block object.

---

#### `GET /notion/blocks/{blockId}/children`

Retrieves all child blocks of a given block. For pages, pass the page ID as `blockId` — this returns the full page body.

**Path parameters**

| Parameter | Description |
|---|---|
| `blockId` | Block ID (use page ID to get page content) |

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `page_size` | integer | Max children per page. Default/max 100. |
| `start_cursor` | string | Pagination cursor from a previous response. |

**Response**: Raw Notion block list with pagination.

```json
{
  "results": [
    { "id": "block-uuid", "type": "paragraph", "paragraph": { "rich_text": [ ... ] } }
  ],
  "has_more": false
}
```

---

### Obsidian Vault

The Obsidian integration syncs one or more git-hosted vaults to the server and exposes full file read and write operations. Vaults are addressed by numeric ID under `/obsidian/vaults/{id}`.

- **Reads** (`.../files`, `.../files/{path}`) execute immediately and are gated by the `readEnabled` permission for the `obsidian` service. API keys can be restricted to path prefixes.
- **Writes are fully supported** — `patch_file`, `create_file`, `write_file`, `rename_file`, and `delete_file` all go through `POST /outbox` with `source: "obsidian"` for human approval.
- **Vault management** (create/update/delete a vault, test connection, generate SSH key, clone) is UI-session only — not available to API keys.

Vaults auto-sync every 5 minutes via `git pull`.

**Setup sequence** (in the UI): save vault config → test connection → generate SSH key (if using SSH) → clone → read files.

#### Writing and editing vault files

All Obsidian file write operations use `POST /outbox` with `source: "obsidian"`. The `content` field must be a **JSON string** encoding the action payload. Set `recipient_id` to the vault file path.

The payload may include an optional `vaultId` (integer). When omitted, the first connected vault is used and the server injects the resolved `vaultId` into the stored item.

For `patch_file`, every `search` string is validated against the current file content when the outbox item is **created** (not at approval time). A search string that does not match exactly falls back to fuzzy matching (≥90% similarity, must be unique in the file); on a fuzzy hit the stored search string is rewritten to the exact matched text. A search string that matches nothing or matches more than once fails the request with `400`.

**`patch_file` — Targeted edit of an existing file (preferred for editing)**

Finds an exact anchor string and applies an operation around it. The `search` value must match exactly once in the file. Three modes via `position`:
- `replace` (default) — replaces the matched text with `replace`
- `after` — inserts `content` immediately after the anchor (anchor unchanged)
- `before` — inserts `content` immediately before the anchor (anchor unchanged)

Multiple edits are applied in sequence:

```json
POST /api/outbox
{
  "source":         "obsidian",
  "recipient_id":   "Daily Notes/2026-04-13.md",
  "recipient_name": "Update daily note",
  "content": "{\"action\":\"patch_file\",\"path\":\"Daily Notes/2026-04-13.md\",\"edits\":[{\"search\":\"## Tasks\",\"position\":\"after\",\"content\":\"\\n- [ ] Review PR #42\"},{\"search\":\"status: draft\",\"replace\":\"status: published\"}]}"
}
```

**`create_file` — Create a new file (fails if already exists)**

```json
{
  "source":         "obsidian",
  "recipient_id":   "Notes/new-note.md",
  "recipient_name": "Create new-note.md",
  "content": "{\"action\":\"create_file\",\"path\":\"Notes/new-note.md\",\"content\":\"# New Note\\n\\nContent here.\"}"
}
```

**`write_file` — Overwrite an entire file (or create if absent)**

Only use when replacing all content is intentional. For targeted edits to existing files, use `patch_file` instead.

```json
{ "action": "write_file", "path": "Notes/existing.md", "content": "# Fully replaced\n\nAll new content." }
```

**`rename_file` — Move or rename a file**

```json
{ "action": "rename_file", "oldPath": "Notes/old.md", "newPath": "Notes/new.md" }
```

**`delete_file` — Delete a file**

```json
{ "action": "delete_file", "path": "Notes/to-delete.md" }
```

All Obsidian write operations require `sendEnabled` permission for the `obsidian` service.

---

#### `GET /obsidian/vaults`

Lists all configured vaults. Secrets (tokens, private keys) are excluded.

**Response**

```json
{
  "vaults": [
    {
      "id": 1,
      "name": "my-vault",
      "remoteUrl": "git@github.com:user/vault.git",
      "authType": "ssh",
      "branch": "main",
      "localPath": "/data/vault/1",
      "syncStatus": "idle",
      "lastSyncedAt": "2026-04-13T10:00:00Z",
      "lastCommitHash": "abc1234",
      "syncError": null,
      "hasHttpsToken": false,
      "hasSshPrivateKey": true,
      "connectionStatus": { "status": "connected" }
    }
  ]
}
```

---

#### `GET /obsidian/vaults/{id}`

Returns a single vault config (same shape as the list entries, no secrets).

**Response**: `{ "vault": { ... } }`. Returns `404` if the vault does not exist.

---

#### Vault management (UI session only)

These endpoints require a UI login session and return an auth error for API keys:

| Endpoint | Description |
|---|---|
| `POST /obsidian/vaults` | Create a vault config. Body: `name` (required), `remote_url` (required), `auth_type` (`https` \| `ssh`, default `https`), `https_token`, `ssh_private_key`, `ssh_public_key`, `branch` (default `main`). Returns `201` with `{ "vault": { ... } }`. |
| `PUT /obsidian/vaults/{id}` | Update a vault config (same fields, all optional). |
| `DELETE /obsidian/vaults/{id}` | Remove a vault config. Body: `{ "delete_local": true }` also deletes the local clone. |
| `POST /obsidian/vaults/{id}/test` | Test git remote connectivity (`git ls-remote`) without cloning. |
| `POST /obsidian/vaults/{id}/generate-ssh-key` | Generate an ed25519 key pair; returns `{ "publicKey", "fingerprint" }`. Add the public key as a deploy key in your git host. |
| `POST /obsidian/vaults/{id}/clone` | Trigger the initial `git clone` (asynchronous — poll `GET /obsidian/vaults/{id}/sync-status`). |

`GET /obsidian/vaults/{id}/ssh-key` and `GET /obsidian/vaults/{id}/ssh-fingerprint` return the generated public key / its SHA256 fingerprint and are readable with an API key.

---

#### `GET /obsidian/vaults/{id}/sync-status`

Returns the current sync state for a vault.

**Response**

```json
{
  "vaultId": 1,
  "syncStatus": "idle",
  "lastSyncedAt": "2026-04-13T10:00:00Z",
  "lastCommitHash": "abc1234",
  "error": null
}
```

`syncStatus` values: `idle`, `syncing`, `error`.

---

#### `POST /obsidian/vaults/{id}/sync`

Triggers a manual `git fetch` + `git pull`. Runs asynchronously.

**Response**

```json
{ "success": true, "message": "Sync started" }
```

Returns `503` if the vault is not connected (clone it first) and `404` if it does not exist.

---

#### `GET /obsidian/vaults/{id}/files`

Returns the full file tree of the vault. Requires the `obsidian` read permission; API keys with a path allowlist receive a filtered tree.

**Response**

```json
{
  "files": [
    {
      "name": "Daily Notes",
      "path": "Daily Notes",
      "type": "directory",
      "children": [
        { "name": "2026-04-13.md", "path": "Daily Notes/2026-04-13.md", "type": "file" }
      ]
    },
    { "name": "README.md", "path": "README.md", "type": "file" }
  ]
}
```

Returns `503` if the vault is not connected.

---

#### `GET /obsidian/vaults/{id}/files/{path}`

Reads the raw content of a file in the vault.

**Path parameters**

| Parameter | Description |
|---|---|
| `id` | Vault ID |
| `path` | Relative path from the vault root (URL-encode special characters and spaces) |

**Example**

```
GET /api/obsidian/vaults/1/files/Daily%20Notes/2026-04-13.md
```

**Response**

```json
{
  "path": "Daily Notes/2026-04-13.md",
  "content": "# April 13\n\n- Reviewed PR #42\n- Called Alice\n"
}
```

Returns `404` if the file does not exist and `403` if the path is outside the API key's read allowlist.

---

### Google Drive

Whitelisted Google Drive folders synced per Google account. All read endpoints are gated by the `gdrive` read permission; folder-level fine-grained permissions may further restrict API keys.

| Endpoint | Description |
|---|---|
| `GET /gdrive/accounts` | Lists Google accounts with an active Drive connection. Response: `{ "accounts": [...] }`. |
| `GET /gdrive/folders` | Lists whitelisted folder configs with connection status. Response: `{ "folders": [...] }`. |
| `GET /gdrive/folders/{id}` | Single folder config. |
| `GET /gdrive/folders/{id}/files` | Full file tree for a folder. |
| `GET /gdrive/folders/{id}/files/{path}` | Read file contents (supports `?format=markdown\|text\|html` for Google Docs). |
| `GET /gdrive/folders/{id}/download/{path}` | Download the raw file. |
| `POST /gdrive/folders/{id}/sync` | Trigger a folder sync. |

Folder management (`POST`/`PUT`/`DELETE /gdrive/folders...`, `GET /gdrive/available-folders`, `POST /gdrive/folders/{id}/upload`, `POST /gdrive/folders/{id}/test`) is UI-session only.

Drive writes go through `POST /outbox` with `source: "gdrive"` and a JSON `content` payload (actions: `create_file`, `write_file`, `patch_file`, `rename_file`, `delete_file`; include `folderId` and `fileId` where applicable). `patch_file` search strings are validated against current file content at creation time for plain-text files.

---

### SMB Network Shares

SMB/CIFS shares mounted by config. File reads are gated by the `smb` read permission (with optional path allowlists per API key).

| Endpoint | Description |
|---|---|
| `GET /smb/shares` | Lists configured shares (no credentials). |
| `GET /smb/shares/{id}` | Single share config. |
| `GET /smb/shares/{id}/status` | Connection status for a share. |
| `POST /smb/shares/{id}/connect` / `POST /smb/shares/{id}/disconnect` | Open / close the connection. |
| `POST /smb/shares/{id}/test` | Test connectivity. |
| `GET /smb/shares/{id}/files` | List files in the share root. |
| `GET /smb/shares/{id}/files/{path}` | List a directory / read file metadata and content. |
| `GET /smb/shares/{id}/download/{path}` | Download the raw file. |

Share management (`POST /smb/shares`, `PUT`/`DELETE /smb/shares/{id}`, `POST /smb/shares/{id}/upload`) is UI-session only. SMB writes go through `POST /outbox` with `source: "smb"` and a JSON `content` payload.

---

### Topology

#### `GET /topology`

Returns a compact, hierarchical map of everything Conduit can see — one call to discover all workspaces/channels, accounts/labels, calendars, vaults, folders, and shares. Responses are cached briefly and support `ETag`/`If-None-Match`.

**Response**: `{ "services": [ { "id": "slack", "connected": true, ... }, ... ] }` — one entry per service (`slack`, `discord`, `telegram`, `twitter`, `gmail`, `calendar`, `gdrive`, `obsidian`, `smb`), each with service-specific structure (e.g. channels for Slack, labels for Gmail, file trees for Obsidian/Drive).

#### `GET /topology/{service}`

Returns the topology for a single service. `404` for unknown service IDs.

---


## Common Patterns

### Get context before acting

```
1. GET /connections            — confirm which platforms are online
2. GET /activity?since=...     — see what has happened recently
3. GET /messages?chat_id=X&include_meta=true  — read a specific conversation
```

### Find and message someone

```
1. GET /contacts?q=Alice       — find by name, note source + platformId
2. GET /contacts/{source}/{platformId}/history  — read their message history
3. POST /contacts/{source}/{platformId}/message — queue a message
4. GET /outbox?status=pending  — confirm it's queued
```

### Handle unread emails

```
1. GET /gmail/messages?unread=true          — list unread messages
2. GET /gmail/messages/{id}/body            — read the full email
3. POST /gmail/actions  { action: "reply" } — queue a reply
```

### Check what's on the calendar

```
1. GET /calendar/events?from=2026-04-07T00:00:00Z&to=2026-04-13T23:59:59Z
2. POST /calendar/actions { action: "rsvp", rsvpStatus: "accepted", ... }
```

### Read a Notion page

```
1. POST /notion/search { "query": "Project Roadmap" }  — find the page by title
2. GET  /notion/blocks/{pageId}/children               — read the page body
```

### Query a Notion database

```
1. GET  /notion/databases                                — list accessible databases
2. POST /notion/databases/{databaseId}/query            — query with optional filter/sort
```

### Read today's Obsidian daily note

```
1. GET  /obsidian/vaults                                         — list vaults, note the vault id
2. GET  /obsidian/vaults/1/sync-status                           — confirm the vault is synced
3. GET  /obsidian/vaults/1/files                                 — find the file path in the tree
4. GET  /obsidian/vaults/1/files/Daily%20Notes/2026-04-13.md    — read the note
```

### Edit an Obsidian file (append to a section)

```
1. GET  /obsidian/vaults/1/files                                 — find the file path
2. GET  /obsidian/vaults/1/files/Notes%2Fmy-note.md             — read current content
3. POST /outbox  {                                               — queue a targeted edit
     source: "obsidian",
     recipient_id: "Notes/my-note.md",
     content: JSON.stringify({
       action: "patch_file",
       vaultId: 1,
       path: "Notes/my-note.md",
       edits: [{ search: "## Section Heading", position: "after", content: "\n- New item" }]
     })
   }
4. Tell user the edit is pending approval in the outbox
```

### Look up a Twitter user's recent activity

```
1. GET /twitter/user/{handle}            — get their profile
2. GET /twitter/user/{handle}/tweets     — read their recent tweets
3. GET /twitter/search?q=from:{handle}   — search their tweets by keyword
```
