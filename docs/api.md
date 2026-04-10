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

Write actions (send message, reply to email, RSVP, tweet, etc.) do **not** execute immediately. They create an **outbox item** with `status=pending`. A human approves or rejects it in the UI before anything is sent.

After submitting a write action, poll `GET /outbox/{id}` or `GET /outbox?status=pending` to check status.

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
          { "id": "D04XYZ", "name": "Alice", "source": "slack", "messageCount": 120, "lastTs": "2026-04-06T10:00:00Z" }
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

---

#### `POST /unread/{service}/{chatId}/read`

Marks a conversation as read on the platform, clearing the unread badge in the platform app. Use this after an agent has processed a conversation.

**Path parameters**

| Parameter | Values |
|---|---|
| `service` | `slack`, `discord`, `telegram` |
| `chatId` | Conversation ID from `GET /chats` |

**Response**

```json
{ "success": true }
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

### Outbox

---

#### `GET /outbox`

Lists messages queued for sending. Filter by `status=pending` to find messages awaiting approval.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `status` | string | `pending`, `approved`, `sent`, `rejected`, `failed` |
| `source` | string | Filter to one platform. |

**Response**

```json
{
  "items": [ OutboxItem ],
  "pendingCount": 3
}
```

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

**Response**: `OutboxItem` object.

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

### Calendar

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

**Response**

```json
{
  "results": [ Tweet ],
  "mode": "Latest"
}
```

When `mode=People`, results are user profile objects instead of tweets:

```json
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

Returns all synced Twitter DM conversations with participant info and last message.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Default 50. |

**Response**

```json
{
  "conversations": [
    {
      "conversationId": "...",
      "participants": [
        { "userId": "123", "displayName": "Alice", "handle": "alice", "avatarUrl": "...", "isMe": false }
      ],
      "lastMessage": {
        "text": "Sounds good!",
        "timestamp": "2026-04-06T11:00:00Z",
        "senderId": "123"
      },
      "unreadCount": 2
    }
  ]
}
```

---

#### `GET /twitter/dms/{conversationId}`

Returns all stored messages in a specific DM conversation.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Default 100. |

**Response**

```json
{
  "conversationId": "...",
  "messages": [
    {
      "id": "...",
      "text": "Hey!",
      "senderId": "123",
      "senderHandle": "alice",
      "senderName": "Alice",
      "isMe": false,
      "timestamp": "2026-04-06T11:00:00Z"
    }
  ],
  "total": 24
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
