---
name: conduit
description: Query and interact with your Conduit personal messaging hub — read messages, search conversations, manage email and calendar, and queue outbound sends across Slack, Discord, Telegram, Gmail, Twitter/X, and Notion.
---

# Conduit

Conduit is a personal messaging hub that aggregates Slack, Discord, Telegram, Gmail, Twitter/X, and Google Calendar into a single REST API. Use it to read conversations, search messages, manage email and calendar, look up contacts, and send messages through an approval outbox — all from one place.

## Setup

- **Base URL:** set the `CONDUIT_URL` environment variable or ask the user for their Conduit address (e.g. `http://localhost:3101`)
- **Auth:** include `X-API-Key: <api-key>` on every request — ask the user for their key
- **Full OpenAPI spec:** `GET $CONDUIT_URL/api/openapi.json`

---

## Key endpoints

### Unified feed
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activity` | Recent activity across all platforms — start here |
| GET | `/api/status` | Connection status and message counts per service |
| GET | `/api/connections` | Live connection state for all services |

### Conversations & messages
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chats` | All conversations organised by platform and type |
| GET | `/api/messages` | Messages in a conversation — `?source=slack&chatId=C123&limit=50` |
| GET | `/api/search` | Full-text search across all messages — `?q=<query>` |

### Contacts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contacts` | Contacts sorted by relationship strength |
| GET | `/api/contacts/:source/:platformId` | Full contact profile |
| GET | `/api/contacts/:source/:platformId/history` | All messages with a contact |

### Outbox (send messages)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/outbox` | Queue a message — may require human approval |
| GET | `/api/outbox` | List pending and sent outbox items |
| PATCH | `/api/outbox/:id` | Approve, reject, or edit a pending item |
| DELETE | `/api/outbox/:id` | Delete an outbox item |

**Outbox body:**
```json
{
  "service": "slack",
  "channel": "general",
  "content": "Hello team!",
  "type": "message"
}
```
A `status` of `pending` means the message is awaiting human approval before sending; `sent` means it was delivered.

### Gmail
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/gmail/messages` | List emails — `?q=<gmail-search>` |
| GET | `/api/gmail/messages/:id/body` | Full email body (HTML + plain text) |
| GET | `/api/gmail/threads/:threadId` | All messages in a thread |
| GET | `/api/gmail/labels` | All Gmail labels |
| POST | `/api/gmail/actions` | Reply, archive, label, trash, mark read |

### Calendar
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/calendar/events` | Upcoming events — `?timeMin=<iso>&timeMax=<iso>` |
| GET | `/api/calendar/events/:id` | Single event details |
| GET | `/api/calendar/calendars` | All Google Calendars on the account |
| POST | `/api/calendar/actions` | Create, update, delete, or RSVP to events |

### Twitter / X
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/twitter/feed` | Home timeline |
| GET | `/api/twitter/search` | Search tweets — `?q=<query>` |
| GET | `/api/twitter/notifications/mentions` | Recent @mentions |
| GET | `/api/twitter/dms` | DM conversations |
| GET | `/api/twitter/trends` | Trending topics |
| POST | `/api/twitter/actions` | Like, retweet, reply, follow |

### Notion
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notion/databases` | List all databases |
| POST | `/api/notion/databases/:id/query` | Query a database |
| GET | `/api/notion/pages/:id` | Retrieve a page |
| POST | `/api/notion/pages` | Create a new page |
| POST | `/api/notion/search` | Search across all Notion content |

---

## Typical workflow

1. Call `GET /api/activity` to get a recent cross-platform snapshot
2. Use `GET /api/chats` + `GET /api/messages` to dig into a specific conversation
3. Use `GET /api/search?q=...` for keyword lookup across all platforms
4. Use `POST /api/outbox` to draft a reply — remind the user to approve it if `requireApproval` is enabled
