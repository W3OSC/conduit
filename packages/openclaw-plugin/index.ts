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
        let account: Awaited<ReturnType<typeof conduitPlugin['config']['resolveAccount']>>;
        try {
          const cfg = api.runtime.config.loadConfig();
          account = conduitPlugin.config.resolveAccount(cfg, null);
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
          payload = parseInboundPayload((req as unknown as { body: unknown }).body);
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
            // Build the prompt, prepending an optional system prompt on first message.
            const prompt = p.systemPrompt
              ? `${p.systemPrompt}\n\n${p.content}`
              : p.content;

            const sessionKey = `conduit:${p.sessionId}`;

            // Run the agent subagent and wait for completion.
            const { runId } = await api.runtime.subagent.run({
              sessionKey,
              message: prompt,
            });

            const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });
            if (result.status === 'error') {
              throw new Error(`Agent run failed: ${result.error ?? 'unknown error'}`);
            }

            // Retrieve the last assistant message from the session.
            const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 1 });
            const last = (messages as Array<{ role?: string; content?: string }>).find(
              (m) => m.role === 'assistant',
            );
            return last?.content ?? '';
          },
        ).catch((err) => {
          console.error('[conduit-plugin] Failed to handle inbound message:', err);
        });

        return true;
      },
    });
  },
});
