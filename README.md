# Conduit

A self-hosted personal messaging hub with an AI agent API. Aggregates Slack, Discord, Telegram, Gmail, Google Calendar, and Twitter/X into a single unified interface and REST API — running entirely as a local Node.js server with SQLite storage.

---

## Platforms

| Platform | What's supported |
|---|---|
| **Slack** | Messages, DMs, channels, realtime via Socket Mode, unread tracking |
| **Discord** | Messages, DMs, server channels, guild sync, unread tracking |
| **Telegram** | Private messages, groups, channels, MTProto realtime, folder organisation |
| **Gmail** | Full inbox, unread messages, email body, actions (reply/archive/trash/etc.) |
| **Google Calendar** | Events, RSVP, create/update/delete, Meet links |
| **Twitter / X** | DMs, home feed, mentions, search, tweet analytics — no developer account required |

---

## Features

- **Unified Inbox** — everything new across all platforms at a glance
- **Chat** — read conversations with bubble UI, real avatars, unread badges, infinite scroll
- **Contacts** — cross-platform contact list with relationship scoring, activity history, shared group detection
- **Email** — Gmail inbox with sandboxed HTML rendering and action buttons
- **Calendar** — weekly view, event detail, RSVP from within the app
- **Twitter analytics** — engagement charts and tweet performance over time
- **Outbox approval** — all outgoing messages queue for human review before sending
- **AI agent API** — full REST API with OpenAPI spec, designed for AI tool use
- **Unread tracking** — cross-platform unread counts synced from platform APIs
- **Password + 2FA login** — optional browser login with TOTP support
- **Multi-account Gmail** — connect multiple Google accounts simultaneously
- **Self-hosted, local-first** — SQLite database, no cloud, no telemetry

---

## Quick start

```bash
git clone https://github.com/conduit-app/conduit
cd conduit
npm install
make dev
```

Open **http://localhost:3101** and configure your services from the Settings page.

---

## First run

1. Open **http://localhost:3101**
2. Go to **Settings → Messaging** (or Email & Calendar) and enter credentials for each service
3. Click **Connect** — run the connection test to verify everything works
4. Click **Sync Now** to pull in message history

Services start disconnected on every restart. You explicitly connect each one from the Settings page.

---

## Getting credentials

All credentials are entered in the **Settings** page in the web UI — no config files needed.

### Telegram

1. Go to [my.telegram.org](https://my.telegram.org) and sign in with your Telegram phone number
2. Click **API development tools**
3. Fill in the form:
   - **App title:** anything, e.g. `Conduit`
   - **Short name:** one word, no spaces, e.g. `conduit`
   - **URL:** leave blank
   - **Platform:** choose `Desktop`
   - **Description:** leave blank
4. Click **Create application** — your `App api_id` (a number) and `App api_hash` (a 32-character string) will appear on the page
5. Enter both values along with your phone number in **Settings → Messaging → Telegram** and click **Send Code**
6. Telegram sends a login code to your Telegram app — enter it to complete setup
7. If you have Two-Step Verification enabled, enter your cloud password when prompted
8. The session is stored in the database and persists across restarts

> **Tip:** If the form at my.telegram.org fails to submit or shows an error, disable browser extensions (especially ad blockers or privacy shields) and try again in a plain browser window.

### Discord
1. Open Discord in a browser and press `F12` to open DevTools
2. Go to the Network tab, click any request to `discord.com`, and copy the `Authorization` header value
3. Paste the token in **Settings → Messaging → Discord**

### Slack

Conduit needs two tokens: a **User OAuth Token** (`xoxp-...`) to read messages and a **App-Level Token** (`xapp-...`) for realtime events via Socket Mode.

**Step 1 — Create a Slack app**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**, give it any name (e.g. `Conduit`), and select your workspace
3. Click **Create App**

**Step 2 — Add OAuth scopes**

1. In the left sidebar click **OAuth & Permissions**
2. Scroll down to **User Token Scopes** (not Bot Token Scopes) and click **Add an OAuth Scope**
3. Add each of the following scopes one at a time:
   - `channels:history` — read messages in public channels
   - `channels:read` — list public channels and get unread counts
   - `channels:write` — mark public channels as read
   - `groups:history` — read messages in private channels
   - `groups:read` — list private channels and get unread counts
   - `groups:write` — mark private channels as read
   - `im:history` — read direct messages
   - `im:read` — list DM conversations and get unread counts
   - `im:write` — open and send DMs
   - `mpim:history` — read group DMs
   - `mpim:read` — list group DM conversations
   - `mpim:write` — mark group DMs as read
   - `chat:write` — send and delete messages
   - `users:read` — resolve user display names and sync contacts

**Step 3 — Install the app and copy the User Token**

1. Scroll back to the top of **OAuth & Permissions** and click **Install to Workspace**
2. Review the permissions and click **Allow**
3. Copy the **User OAuth Token** — it starts with `xoxp-`

**Step 4 — Enable Socket Mode and get the App-Level Token**

Socket Mode gives you realtime message delivery. Without it, Conduit falls back to polling every 2 minutes.

1. In the left sidebar click **Socket Mode**
2. Toggle **Enable Socket Mode** on
3. You will be prompted to create an App-Level Token — give it any name (e.g. `conduit-socket`) and click **Generate**
4. Copy the token — it starts with `xapp-`

**Step 5 — Enable Event Subscriptions**

1. In the left sidebar click **Event Subscriptions**
2. Toggle **Enable Events** on
3. Under **Subscribe to events on behalf of users**, click **Add Workspace Event** and add:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
4. Click **Save Changes**

**Step 6 — Enter credentials in Conduit**

1. Open Conduit at **http://localhost:3101** and go to **Settings → Messaging → Slack**
2. Paste the **User OAuth Token** (`xoxp-...`) into the **User Token** field
3. Paste the **App-Level Token** (`xapp-...`) into the **App Token** field
4. Click **Save**, then **Connect**

### Gmail & Google Calendar

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → click the project dropdown at the top → **New Project** → give it any name (e.g. `Conduit`) → click **Create**. Make sure the new project is selected before continuing.
2. Enable the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com), [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com), [Google Meet API](https://console.cloud.google.com/apis/library/meet.googleapis.com), and [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) — click each link and press **Enable**.
3. Go to [Auth → Overview](https://console.cloud.google.com/auth/overview) → click **Get started** → fill in any app name and your email for the support address → choose **External** as the audience → click through and **Save** on each screen until done.
4. Go to [Auth → Clients](https://console.cloud.google.com/auth/clients) → **+ Create client** → type **Web application** → give it any name → under **Authorized redirect URIs** click **+ Add URI** and enter `https://developers.google.com/oauthplayground` → click **Create**. Copy the **Client ID** and **Client Secret** from the dialog.
5. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) → click the **⚙ gear** (top-right) → check **"Use your own OAuth credentials"** → paste your Client ID and Client Secret → close the panel. In the **Input your own scopes** box at the top of the scope list, paste this string and click **Authorize APIs**:
   ```
   https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.readonly
   ```
   Sign in → **Allow** → **Exchange authorization code for tokens**. Copy the **Access token** and **Refresh token**. The last two scopes enable Gemini meeting notes — remove them if you don't need that feature.
6. Paste all four values into **Settings → Google** in Conduit.

### Twitter / X
1. Enter your Twitter username, password, and email in **Settings → Messaging → Twitter**
2. No developer account or API keys required

---

## AI agent integration

Conduit includes a full REST API designed for AI tool use (Claude, or any OpenAPI-compatible agent).

**Setup:**
1. Go to **Settings → Permissions** and generate an API key
2. Pass it as `X-API-Key: <your-key>` on every request
3. Copy the skill config from **Settings → Install** and paste it into your agent

**Authentication:** All API requests require the `X-API-Key` header. If UI password login is enabled, the API key bypasses it — agents always authenticate with the key, not a session cookie.

**The most useful endpoint for context:**

```
GET /api/activity?since=2026-04-01T00:00:00Z&limit=100
```

Returns a unified chronological feed of messages and emails across all platforms — the fastest way for an agent to understand what has been happening.

**Key endpoints:**

| Endpoint | Purpose |
|---|---|
| `GET /api/connections` | Check which platforms are connected before making calls |
| `GET /api/activity` | Recent messages + emails across all platforms |
| `GET /api/messages?chat_id=X&include_meta=true` | Full conversation with participant info |
| `GET /api/search?q=topic` | Full-text search across all messages |
| `GET /api/contacts?q=alice` | Look up a person by name |
| `GET /api/contacts/:source/:id/history?after=2026-01-01` | All messages from one person |
| `POST /api/contacts/:source/:id/message` | Queue a message for approval, then send |
| `GET /api/outbox?status=pending` | Check messages awaiting human approval |
| `GET /api/gmail/messages?unread=true` | Unread emails |
| `GET /api/calendar/events` | Upcoming calendar events |
| `POST /api/unread/:service/:chatId/read` | Mark a conversation as read on the platform |
| `GET /api/twitter/analytics` | Tweet engagement metrics |

**Outbox flow:** All write actions (send message, reply to email, RSVP, tweet, etc.) create an outbox item with `status=pending`. A human approves or rejects it in the UI before anything is sent. Poll `GET /api/outbox/{id}` to check status after submitting.

The full machine-readable OpenAPI spec is at **`http://localhost:3101/api/openapi.json`** once the server is running. A human-readable version is in [`docs/api.md`](docs/api.md).

---

## Docker

```bash
make docker-up    # build image and start
make docker-down  # stop
```

All credentials are managed via the web UI. The SQLite database — including all messages, contacts, credentials, and sessions — persists in `./data/` on the host and survives container rebuilds and restarts.

---

## Development

```bash
make dev      # start server (port 3100) + Vite dev server (port 3101)
make build    # production build
make migrate  # run database migrations
make test     # run server tests
make lint     # typecheck both packages
make install  # install npm dependencies
make clean    # remove build artifacts
```

In development, Vite runs on port `3101` and proxies API calls to the server on port `3100`. In production (Docker), the server serves both the API and the built UI on port `3101`. Either way, you always access the app at **http://localhost:3101**.

---

## Architecture

```
Browser → http://localhost:3101
          │
          ▼
    Express (Node.js)
    ├── REST API  /api/*
    ├── WebSocket realtime events
    └── Static files (React UI)
          │
          ▼
    SQLite (./data/conduit.db)
    Messages, contacts, outbox, sync state
          │
          ▼
    Platform connections (direct, no intermediary)
    Slack WebAPI · Discord Gateway · Telegram MTProto
    Gmail OAuth · Calendar OAuth · Twitter cookie auth
```

**Stack**: Node.js 20, Express, SQLite (better-sqlite3), Drizzle ORM, React 18, Vite, Tailwind CSS, TypeScript throughout.

---

## Configuration

Conduit has no configuration files. All service credentials are entered through the web UI and stored in the local SQLite database.

Two environment variables are available for deployment overrides:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3101` | Server listen port |
| `DATABASE_PATH` | `data/conduit.db` | Path to the SQLite database file |

---

## Data & privacy

- All data is stored locally in a single SQLite file (`data/conduit.db`)
- No data is sent to any external service by Conduit itself
- Credentials are stored as tokens in the local database (passwords are bcrypt-hashed)
- The database file is excluded from git via `.gitignore`

---

## Disclaimer

**By installing or running Conduit, you acknowledge that you have read and understood this disclaimer and accept full responsibility for your use of this software. The authors and contributors of Conduit make no warranties, express or implied, and accept no liability for any consequences arising from its use, including but not limited to account suspension, data loss, security incidents, or any other damages.**

### Platform Terms of Service & Account Risk

Several connection methods used by Conduit access platforms in ways that may conflict with those platforms' Terms of Service. It is your responsibility to review the relevant ToS for each platform you connect and to understand the risks before doing so. By connecting a platform, you accept that risk entirely.

| Platform | Access Method | ToS Considerations | Account Risk |
|---|---|---|---|
| **Discord** | User token (selfbot) | Discord's ToS and Developer Policy may prohibit the use of automated user accounts (selfbots). This access method is not an officially sanctioned bot integration. | Account suspension or permanent termination is possible. Use on a personal account at your own discretion. |
| **Twitter / X** | Cookie / credential auth | X's Terms of Service and Developer Policy may prohibit automated or third-party access to user accounts outside of the official API. No developer account or API key is used. | Account suspension is possible. Use on a personal account at your own discretion. |
| **Telegram** | MTProto (official client API) | Telegram provides the MTProto API explicitly for third-party client development. Spam and abuse policies still apply. | Low risk under normal personal use. |
| **Slack** | Official OAuth user token | Uses Slack's officially supported OAuth flow with user-granted scopes. | Low risk under normal personal use within a workspace you control. |
| **Gmail / Google Calendar** | OAuth2 (Google API) | Uses Google's official OAuth2 API with user-granted scopes. | Low risk under normal personal use. |
| **Notion** | Internal integration token | Uses Notion's official API with a user-created integration token. | Low risk under normal personal use. |
| **Obsidian** | Local git repository | No external platform account is accessed. Data stays local. | No external account risk. |

### Security

Conduit is a **single point of failure** for every account you connect to it. The local SQLite database (`data/conduit.db`) stores credentials and session tokens for all connected platforms. If the machine Conduit runs on is compromised, or if the database file is accessed by an unauthorized party, all connected accounts are exposed simultaneously.

**Conduit provides no security guarantees.** It is designed to be run locally on a machine you own and control, on a network you trust. It is not hardened for exposure to the public internet.

You are solely responsible for:

- Securing the host machine that Conduit runs on
- Restricting network access to the Conduit server (e.g. firewall rules, VPN, localhost-only binding)
- Enabling the built-in password and 2FA login available in **Settings → Security**
- Protecting the `data/conduit.db` file from unauthorized read access (file permissions, disk encryption, etc.)
- Rotating or revoking credentials for connected platforms if you suspect a compromise

By running this software, you accept full responsibility for your security posture and for any consequences resulting from unauthorized access to your Conduit instance or its database.
