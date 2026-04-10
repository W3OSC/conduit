/**
 * Conduit channel plugin definition.
 *
 * Uses `createChatChannelPlugin` from the OpenClaw plugin SDK to register
 * Conduit as a native OpenClaw messaging channel. OpenClaw manages the
 * agent session, tool calls, and reply dispatch; this plugin handles:
 *
 *  - Config / account resolution from `openclaw.json`
 *  - Setup inspection (is the channel configured?)
 *  - DM security (allowlist who can receive Conduit messages)
 *  - Outbound: streaming reply chunks back to Conduit's stream endpoint
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
  type OpenClawConfig,
} from 'openclaw/plugin-sdk/channel-core';

import { verifyConnection } from './client.js';

// ── Account resolution ────────────────────────────────────────────────────────

interface ConduitChannelSection {
  baseUrl?: string;
  apiKey?: string;
  allowFrom?: string[];
  webhookSecret?: string;
}

interface ResolvedAccount {
  accountId: string | null;
  baseUrl: string;
  apiKey: string;
  allowFrom: string[];
  webhookSecret: string | undefined;
}

function getSection(cfg: OpenClawConfig): ConduitChannelSection {
  return ((cfg as Record<string, unknown>)['channels'] as Record<string, unknown> | undefined)?.['conduit'] as ConduitChannelSection ?? {};
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  const section = getSection(cfg);
  if (!section.baseUrl) throw new Error('conduit: channels.conduit.baseUrl is required');
  if (!section.apiKey)  throw new Error('conduit: channels.conduit.apiKey is required');
  return {
    accountId:     accountId ?? null,
    baseUrl:       section.baseUrl.replace(/\/$/, ''),
    apiKey:        section.apiKey,
    allowFrom:     section.allowFrom ?? [],
    webhookSecret: section.webhookSecret,
  };
}

function inspectAccount(cfg: OpenClawConfig, _accountId?: string | null) {
  const section = getSection(cfg);
  const hasUrl = Boolean(section.baseUrl);
  const hasKey = Boolean(section.apiKey);
  return {
    enabled:     hasUrl && hasKey,
    configured:  hasUrl && hasKey,
    baseUrlStatus: hasUrl ? 'set' : 'missing',
    apiKeyStatus:  hasKey ? 'set' : 'missing',
  };
}

// ── Channel plugin ────────────────────────────────────────────────────────────

export const conduitPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: 'conduit',

    setup: {
      resolveAccount,
      inspectAccount,

      async verifyAccount(account) {
        const result = await verifyConnection({ baseUrl: account.baseUrl, apiKey: account.apiKey });
        if (!result.ok) throw new Error(result.error ?? 'Unable to reach Conduit');
      },
    },
  }),

  // DM security — who can receive messages from this channel.
  security: {
    dm: {
      channelKey: 'conduit',
      resolvePolicy: (account) => account.allowFrom.length > 0 ? 'allowlist' : 'allow_all',
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: 'allow_all',
    },
  },

  // No pairing needed — Conduit authenticates via API key, not user DM pairing.
  pairing: undefined,

  // Replies are top-level (no threading model in the Conduit AI chat UI).
  threading: { topLevelReplyToMode: 'reply' },

  // Outbound: send text replies back to Conduit via the streaming endpoint.
  // The actual stream URL and messageId bookkeeping are handled in inbound.ts;
  // this adapter is used when OpenClaw proactively sends a message (rare for
  // Conduit, but required by the channel contract).
  outbound: {
    attachedResults: {
      sendText: async (params) => {
        // `params.to` holds the streamUrl injected by the inbound handler via
        // the session conversation id.  We re-use the streaming helper with
        // a single done:true chunk for proactive sends where no ongoing
        // stream context exists.
        const [streamUrl, apiKey] = (params.to as string).split('|APIKEY|');
        if (!streamUrl || !apiKey) {
          throw new Error('conduit outbound: malformed target — expected "streamUrl|APIKEY|apiKey"');
        }

        const { streamReplyToConduit } = await import('./client.js');
        await streamReplyToConduit(streamUrl, apiKey, params.text);

        return { messageId: `arb-${Date.now()}` };
      },
    },
  },
});
