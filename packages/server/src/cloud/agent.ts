/**
 * Conduit side of the Meridian M5 home-agent protocol
 * (auditware-crm docs/m5-home-agent.md). Each Conduit instance dials OUT to
 * `wss://meridian.auditware.io/api/agent/ws` over one persistent
 * bearer-authenticated WebSocket; Meridian routes its existing Conduit calls
 * over that channel as `http` jobs, so the hosted CRM can reach a
 * home-network Conduit it could otherwise never connect to directly.
 *
 * Reconnects forever with exponential backoff (backoff.ts) and relays a
 * slimmed subset of this server's own broadcast bus (events.ts) so the
 * cloud's periodic poll gets accelerated rather than replaced.
 */

import { WebSocket } from 'ws';
import os from 'os';
import { subscribeBroadcast } from '../websocket/hub.js';
import { loadCloudAgentConfig, type CloudAgentConfig } from './config.js';
import { nextBackoffMs, STABLE_CONNECTION_MS } from './backoff.js';
import { ensureCloudAgentApiKey } from './key.js';
import { executeHttpJob, type HttpJob } from './jobs.js';
import { shouldRelayEvent, slimEventPayload } from './events.js';

const PORT = parseInt(process.env.PORT || '3101', 10);

interface JobFrame {
  type: 'job';
  jobId: string;
  kind: string;
  method?: string;
  path?: string;
  body?: unknown;
}

type IncomingFrame = { type: 'ping' } | JobFrame | { type: string; [k: string]: unknown };

function sendFrame(ws: WebSocket | null, frame: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

/**
 * Start the persistent cloud-agent connection. No-op (logged) when
 * CLOUD_AGENT_URL/CLOUD_AGENT_TOKEN aren't configured or the agent is
 * explicitly disabled. Registered once at the index.ts boot tail.
 */
export function startCloudAgent(): void {
  const loaded = loadCloudAgentConfig();
  if (!loaded) return;
  // Re-bind to a variable TS can prove is non-null inside the nested
  // (hoisted) connect() function declaration below.
  const config: CloudAgentConfig = loaded;

  const apiKey = ensureCloudAgentApiKey();
  console.log(`[cloud-agent] Configured — dialing ${config.url}`);

  let ws: WebSocket | null = null;
  let attempt = 0;
  let connectedAt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Relay subscription lives for the process lifetime, independent of the
  // current socket's connect/disconnect cycles — frames are simply dropped
  // (via sendFrame's readyState check) while there is no live connection.
  subscribeBroadcast((event) => {
    if (!shouldRelayEvent(event)) return;
    sendFrame(ws, { type: 'event', topic: event.type, payload: slimEventPayload(event.data) });
  });

  const scheduleReconnect = (): void => {
    attempt += 1;
    const delay = nextBackoffMs(attempt);
    console.log(`[cloud-agent] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    reconnectTimer = setTimeout(connect, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  };

  const handleJob = async (frame: JobFrame): Promise<void> => {
    if (frame.kind !== 'http') {
      // Forward-compat: the future "ai" capability (M5b) lands here too.
      sendFrame(ws, { type: 'job_result', jobId: frame.jobId, ok: false, error: 'unsupported kind' });
      return;
    }
    const job: HttpJob = {
      jobId: frame.jobId,
      kind: 'http',
      method: frame.method,
      path: frame.path ?? '',
      body: frame.body,
    };
    const result = await executeHttpJob(job, PORT, apiKey);
    sendFrame(ws, { type: 'job_result', ...result });
  };

  function connect(): void {
    try {
      ws = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.token}` } });
    } catch (e) {
      console.error('[cloud-agent] Failed to open socket:', e instanceof Error ? e.message : e);
      scheduleReconnect();
      return;
    }

    const socket = ws;

    socket.on('open', () => {
      connectedAt = Date.now();
      console.log('[cloud-agent] Connected');
      sendFrame(socket, {
        type: 'hello',
        deviceName: os.hostname(),
        ownerEmail: config.ownerEmail,
        capabilities: ['messaging'],
      });
    });

    socket.on('message', (raw) => {
      let frame: IncomingFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed frames
      }
      if (frame.type === 'ping') {
        sendFrame(socket, { type: 'pong' });
      } else if (frame.type === 'job') {
        handleJob(frame as JobFrame).catch((e) => console.error('[cloud-agent] Job handler error:', e));
      }
    });

    socket.on('close', () => {
      const lived = connectedAt ? Date.now() - connectedAt : 0;
      if (lived > STABLE_CONNECTION_MS) attempt = 0; // reset backoff after a connection that lived >60s
      connectedAt = 0;
      console.log(`[cloud-agent] Disconnected${lived ? ` (was up ${Math.round(lived / 1000)}s)` : ''}`);
      scheduleReconnect();
    });

    socket.on('error', (e) => {
      console.error('[cloud-agent] Socket error:', e instanceof Error ? e.message : e);
      // 'close' always follows 'error' for ws clients — reconnect is scheduled there.
    });
  }

  connect();
}
