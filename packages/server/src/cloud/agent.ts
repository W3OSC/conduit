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
import {
  abortAllTurnJobs,
  cancelTurnJob,
  discoverAiCapability,
  executeAiJob,
  executeTurnJob,
  parseAiJobFrame,
} from './ai.js';

const PORT = parseInt(process.env.PORT || '3101', 10);

interface JobFrame {
  type: 'job';
  jobId: string;
  kind: string;
  method?: string;
  path?: string;
  body?: unknown;
  // "none" → executeHttpJob skips the X-API-Key header (see jobs.ts HttpJob.auth).
  auth?: 'none';
  // kind:"ai" fields (docs/m5b-ai-runner.md) — present only on kind:"ai"
  // frames, validated by parseAiJobFrame (wire data is untyped).
  mode?: unknown;
  model?: unknown;
  prompt?: unknown;
  schema?: unknown;
  timeoutSecs?: unknown;
  // kind:"ai" mode:"turn" extras (docs/m5b-phase2.md), same untyped treatment.
  effort?: unknown;
  system?: unknown;
  sessionId?: unknown;
  resume?: unknown;
  mcpUrl?: unknown;
  mcpSecret?: unknown;
  allowedTools?: unknown;
  disallowedTools?: unknown;
}

type IncomingFrame =
  | { type: 'ping' }
  | JobFrame
  | { type: 'job_cancel'; jobId?: unknown }
  | { type: string; [k: string]: unknown };

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
  console.log(`[cloud-agent] Configured — dialing ${config.url} (protocol v1.2)`);

  // Probed once per process (claude --version, 2s budget) rather than on every
  // reconnect — a broken/missing CLI install doesn't change between retries,
  // and re-probing would mean shelling out on every dropped connection.
  const aiCapabilityProbe: Promise<boolean> = discoverAiCapability().then((available) => {
    console.log(`[cloud-agent] AI runner capability: ${available ? 'available' : 'unavailable (claude CLI not found/working)'}`);
    return available;
  });

  let ws: WebSocket | null = null;
  let attempt = 0;
  let connectedAt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Relay subscription lives for the process lifetime, independent of the
  // current socket's connect/disconnect cycles — frames are simply dropped
  // (via sendFrame's readyState check) while there is no live connection.
  subscribeBroadcast((event) => {
    if (!shouldRelayEvent(event)) return;
    sendFrame(ws, { type: 'event', topic: event.type, payload: slimEventPayload(event.type, event.data) });
  });

  const scheduleReconnect = (): void => {
    attempt += 1;
    const delay = nextBackoffMs(attempt);
    console.log(`[cloud-agent] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    reconnectTimer = setTimeout(connect, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  };

  const handleJob = async (frame: JobFrame): Promise<void> => {
    if (frame.kind === 'ai') {
      // mode/model/prompt/timeoutSecs are required by the protocol; validate
      // up front (parseAiJobFrame) so a malformed frame gets an immediate
      // job_result instead of an exception deep in the CLI spawn path — and
      // so an unknown mode can never reach the per-mode tool-posture switch.
      const job = parseAiJobFrame(frame);
      if (!job) {
        // Same shape executeAiJob errors take: top-level `error` for the
        // hub's generic job_result path, plus the documented protocol body
        // (docs/m5b-ai-runner.md) `{error, errorKind}`.
        const error = 'malformed ai job frame (mode/model/prompt/timeoutSecs)';
        sendFrame(ws, {
          type: 'job_result',
          jobId: frame.jobId,
          ok: false,
          error,
          body: { error, errorKind: 'cli_error' },
        });
        return;
      }
      if (job.mode === 'turn') {
        // Streaming turn (docs/m5b-phase2.md): each slimmed stdout line
        // ships live as an ai_delta frame; the terminal outcome is still the
        // normal job_result oneshot. The cloud drops deltas for settled/
        // unknown jobs, so a late frame here is harmless.
        const result = await executeTurnJob(job, (event) => {
          sendFrame(ws, { type: 'ai_delta', jobId: job.jobId, event });
        });
        sendFrame(ws, { type: 'job_result', ...result });
        return;
      }
      const result = await executeAiJob(job);
      sendFrame(ws, { type: 'job_result', ...result });
      return;
    }
    if (frame.kind !== 'http') {
      sendFrame(ws, { type: 'job_result', jobId: frame.jobId, ok: false, error: 'unsupported kind' });
      return;
    }
    const job: HttpJob = {
      jobId: frame.jobId,
      kind: 'http',
      method: frame.method,
      path: frame.path ?? '',
      body: frame.body,
      auth: frame.auth,
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
      aiCapabilityProbe
        .then((aiAvailable) => {
          sendFrame(socket, {
            type: 'hello',
            deviceName: os.hostname(),
            ownerEmail: config.ownerEmail,
            // "ai.turn" (protocol v1.2): same CLI probe as "ai" — this build
            // implements turn mode + job_cancel, which is the rest of the
            // gate. The cloud checks each capability independently; a
            // phase-1 runner advertising only "ai" never sees turn frames.
            capabilities: aiAvailable ? ['messaging', 'ai', 'ai.turn'] : ['messaging'],
          });
        })
        .catch(() => {
          // discoverAiCapability() never rejects, but hello must go out
          // regardless of any unforeseen failure in the probe chain.
          sendFrame(socket, {
            type: 'hello',
            deviceName: os.hostname(),
            ownerEmail: config.ownerEmail,
            capabilities: ['messaging'],
          });
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
      } else if (frame.type === 'job_cancel') {
        // Operator stop / cloud deadline (docs/m5b-phase2.md): kill the
        // matching turn's process group; its executor answers the documented
        // cancelled job_result. Unknown jobId ⇒ silent no-op, no reply.
        const jobId = (frame as { jobId?: unknown }).jobId;
        if (typeof jobId === 'string') cancelTurnJob(jobId);
      }
      // Unknown frame types: ignored (forward compat, both sides).
    });

    socket.on('close', () => {
      const lived = connectedAt ? Date.now() - connectedAt : 0;
      if (lived > STABLE_CONNECTION_MS) attempt = 0; // reset backoff after a connection that lived >60s
      connectedAt = 0;
      // In-flight TURN children die with the socket: their delta stream has
      // nowhere to go and the cloud has already failed the turn. Phase-1 ai
      // jobs keep their run-to-completion-and-drop behavior (harmless).
      abortAllTurnJobs('cloud connection closed mid-turn — CLI killed');
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
