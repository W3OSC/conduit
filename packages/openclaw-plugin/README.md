# @w3osc/openclaw-conduit

An [OpenClaw](https://openclaw.ai) channel plugin that connects [Conduit](https://github.com/conduit-app/conduit) as a native messaging channel.

Conduit is a self-hosted personal communications hub that aggregates Slack, Discord, Telegram, Gmail, Google Calendar, and Twitter/X into a unified local server. This plugin lets the OpenClaw agent receive messages from the Conduit AI chat UI and stream replies back in real time.

---

## Requirements

- OpenClaw `>=2026.3.24-beta.2`
- A running Conduit instance (self-hosted)
- A Conduit API key (generated in **Settings → Permissions**)

---

## Installation

```sh
openclaw plugins install @w3osc/openclaw-conduit
```

---

## Configuration

Add a `conduit` section under `channels` in your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "conduit": {
      "baseUrl": "http://localhost:3101",
      "apiKey": "sk-arb-...",
      "allowFrom": [],
      "webhookSecret": "optional-secret"
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `baseUrl` | Yes | Base URL of your Conduit server |
| `apiKey` | Yes | Conduit API key — generate one in **Settings → Permissions** |
| `allowFrom` | No | List of OpenClaw user identifiers allowed to receive Conduit messages. Leave empty to allow all. |
| `webhookSecret` | No | If set, Conduit must send `Authorization: Bearer <secret>` on each inbound request |

---

## Connecting Conduit to OpenClaw

After installing and configuring the plugin, restart the OpenClaw Gateway:

```sh
openclaw gateway
```

Then in Conduit, go to **Settings → AI → OpenClaw Channel** and enter the inbound webhook URL:

```
http://<your-openclaw-host>:18789/channels/conduit/inbound
```

Messages sent to the Conduit AI chat will now be routed to the OpenClaw agent, and replies will stream back to the Conduit UI.

---

## How it works

1. Conduit POSTs an inbound message to the OpenClaw Gateway at `/channels/conduit/inbound`
2. The plugin verifies the optional webhook secret, then dispatches the message to the OpenClaw agent
3. The agent reply is streamed back to Conduit's session stream endpoint in real time
4. The Conduit AI chat UI renders the streaming response

Outbound sends (when OpenClaw proactively sends a message) are delivered via Conduit's streaming API using the API key.

---

## License

MIT
