/**
 * @w3os/openclaw-conduit — Conduit channel plugin for OpenClaw
 *
 * Registers Conduit as a native OpenClaw messaging channel, allowing the
 * OpenClaw agent to receive messages from the Conduit AI chat UI and stream
 * replies back in real time.
 *
 * Installation:
 *   openclaw plugins install @w3os/openclaw-conduit
 *
 * Config (add to ~/.openclaw/openclaw.json):
 *   {
 *     "channels": {
 *       "conduit": {
 *         "baseUrl": "http://your-conduit-host:3101",
 *         "apiKey":  "sk-arb-...",
 *         "allowFrom": [],          // leave empty to allow all
 *         "webhookSecret": "..."    // optional; must match Conduit's webhook secret
 *       }
 *     }
 *   }
 *
 * Then restart the Gateway: openclaw gateway
 *
 * In Conduit (Settings → AI → OpenClaw Channel), enter:
 *   http://<your-openclaw-host>:18789/channels/conduit/inbound
 */

import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { conduitPlugin } from './src/channel.js';
import { parseInboundPayload, verifyWebhookSecret, handleConduitInbound } from './src/inbound.js';
import type { ConduitInboundPayload } from './src/inbound.js';

export default defineChannelPluginEntry({
  id: 'conduit',
  name: 'Conduit',
  description: 'Conduit personal communications hub — read messages, emails, and calendar.',
  plugin: conduitPlugin,

  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program
          .command('conduit')
          .description('Conduit channel management');
      },
      {
        descriptors: [
          {
            name: 'conduit',
            description: 'Conduit channel management',
            hasSubcommands: false,
          },
        ],
      },
    );
  },

  registerFull(api) {
    // ── Inbound HTTP route ────────────────────────────────────────────────────
    // Conduit POSTs AI chat messages here. We parse the payload, dispatch it
    // into the OpenClaw agent session, and stream the reply back.
    api.registerHttpRoute({
      path: '/channels/conduit/inbound',
      // 'plugin' auth = plugin-managed; we verify the webhook secret ourselves.
      auth: 'plugin',
      handler: async (req, res) => {
        // Resolve the current account config to get the webhook secret and apiKey.
        let account: Awaited<ReturnType<typeof conduitPlugin['setup']['resolveAccount']>>;
        try {
          const cfg = await api.runtime.config.read();
          account = conduitPlugin.setup!.resolveAccount(cfg, null);
        } catch (err) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Channel not configured', detail: String(err) }));
          return true;
        }

        // Verify the optional webhook secret.
        const authHeader = (req.headers as Record<string, string | undefined>)['authorization'];
        if (!verifyWebhookSecret(authHeader, account.webhookSecret)) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return true;
        }

        // Parse the payload.
        let payload: ConduitInboundPayload;
        try {
          payload = parseInboundPayload(req.body);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Bad request', detail: String(err) }));
          return true;
        }

        // Acknowledge immediately — the agent reply is streamed back asynchronously.
        res.statusCode = 202;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ accepted: true, sessionId: payload.sessionId }));

        // Dispatch to the OpenClaw agent and stream the reply back to Conduit.
        handleConduitInbound(
          payload,
          account.apiKey,
          async (p: ConduitInboundPayload) => {
            // Build the conversation context passed to the agent.
            const messages: Array<{ role: string; content: string }> = [];

            // Inject the system prompt on first message of each session.
            if (p.systemPrompt) {
              messages.push({ role: 'system', content: p.systemPrompt });
            }

            messages.push({ role: p.role, content: p.content });

            // Use OpenClaw's agent runtime to produce a reply.
            const response = await api.runtime.agent.complete({
              sessionKey: `conduit:${p.sessionId}`,
              messages,
            });

            return response.text ?? '';
          },
        ).catch((err) => {
          console.error('[conduit-plugin] Failed to handle inbound message:', err);
        });

        return true;
      },
    });
  },
});
