/**
 * Conduit side of the cloud-agent protocol (M5 home-agent — auditware-crm
 * docs/m5-home-agent.md; Meridian is the reference orchestrator). This
 * instance dials OUT to the orchestrator's `/api/agent/ws` over one
 * persistent bearer-authenticated WebSocket; the remote side routes its
 * Conduit calls over that channel as `http` jobs, so a hosted service can
 * reach a home-network Conduit it could otherwise never connect to directly.
 *
 * Reconnects forever with exponential backoff (backoff.ts) and relays a
 * slimmed subset of this server's own broadcast bus (events.ts) so the
 * cloud's periodic poll gets accelerated rather than replaced.
 *
 * Config is resolved per start (env wins over settings DB — config.ts); the
 * bridge is hot-restartable via restartCloudAgent() so /api/cloud-agent can
 * apply new settings without a process restart.
 */

import { WebSocket } from 'ws';
import os from 'os';
import { subscribeBroadcast } from '../websocket/hub.js';
import {
  resolveCloudAgentConfig,
  type CloudAgentConfig,
  type CloudAgentSource,
} from './config.js';
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

export interface CloudAgentStatus {
  /** A connectable config exists (env or settings) and the bridge is running. */
  configured: boolean;
  /** Where the active (or would-be) config comes from; null when nothing is set. */
  source: CloudAgentSource | null;
  /** Env vars own the config — runtime writes via the API are rejected. */
  envManaged: boolean;
  state: 'off' | 'connecting' | 'connected';
  url: string | null;
  ownerEmail: string | null;
  /** ISO timestamp of the current connection's open, null while not connected. */
  connectedAt: string | null;
  /** Most recent socket/connect error (sticky until the next successful open). */
  lastError: string | null;
  /** Capabilities advertised in the most recent hello of the current run. */
  capabilities: string[] | null;
}

/** One start's worth of connection state — replaced wholesale on restart. */
interface Runtime {
  config: CloudAgentConfig;
  source: CloudAgentSource;
  apiKey: string;
  aiCapabilityProbe: Promise<boolean>;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  connectedAt: number;
  /** Set by stop(): close/error handlers must neither reconnect nor touch status. */
  stopped: boolean;
}

let runtime: Runtime | null = null;
let relaySubscribed = false;
let lastError: string | null = null;
let lastCapabilities: string[] | null = null;

export function getCloudAgentStatus(): CloudAgentStatus {
  const resolved = resolveCloudAgentConfig();
  const running = runtime !== null;
  return {
    configured: resolved.config !== null,
    source: resolved.source,
    envManaged: resolved.envManaged,
    state: !running ? 'off' : runtime!.connectedAt > 0 ? 'connected' : 'connecting',
    url: runtime?.config.url ?? resolved.config?.url ?? null,
    ownerEmail: runtime?.config.ownerEmail ?? resolved.config?.ownerEmail ?? null,
    connectedAt: runtime && runtime.connectedAt > 0 ? new Date(runtime.connectedAt).toISOString() : null,
    lastError,
    capabilities: running ? lastCapabilities : null,
  };
}

/** Tear down the current runtime (socket, timer, in-flight turns). */
function stopRuntime(reason: string): void {
  const rt = runtime;
  if (!rt) return;
  rt.stopped = true;
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
  }
  // In-flight turn children die with the bridge — their delta stream has
  // nowhere to go. (The close handler also sweeps; abort is idempotent.)
  abortAllTurnJobs(reason);
  try {
    rt.ws?.close();
  } catch {
    // Already closed / not a real socket (tests) — nothing to tear down.
  }
  runtime = null;
  lastCapabilities = null;
}

/** Stop the bridge and leave it off until the next start/restart. */
export function stopCloudAgent(): void {
  if (runtime) console.log('[cloud-agent] Stopped');
  stopRuntime('cloud agent stopped');
}

/**
 * Start (or restart) the persistent cloud-agent connection from the currently
 * resolved config — env first, settings DB otherwise (config.ts). No-op
 * (logged by the config layer where it matters) when nothing is configured or
 * the agent is explicitly disabled. Called once at the index.ts boot tail and
 * again by /api/cloud-agent whenever the stored config changes.
 */
export function startCloudAgent(): void {
  stopRuntime('cloud agent restarting');

  const resolved = resolveCloudAgentConfig();
  if (!resolved.config) return;
  const source = resolved.source ?? 'settings';

  console.log(`[cloud-agent] Configured via ${source} — dialing ${resolved.config.url} (protocol v1.2)`);

  const rt: Runtime = {
    config: resolved.config,
    source,
    apiKey: ensureCloudAgentApiKey(),
    // Probed once per start (claude --version, 2s budget) rather than on every
    // reconnect — a broken/missing CLI install doesn't change between retries,
    // and re-probing would mean shelling out on every dropped connection.
    aiCapabilityProbe: discoverAiCapability().then((available) => {
      console.log(`[cloud-agent] AI runner capability: ${available ? 'available' : 'unavailable (claude CLI not found/working)'}`);
      return available;
    }),
    ws: null,
    reconnectTimer: null,
    attempt: 0,
    connectedAt: 0,
    stopped: false,
  };
  runtime = rt;

  // Relay subscription lives for the process lifetime, independent of any
  // runtime's connect/disconnect cycles — frames are simply dropped (via
  // sendFrame's readyState check) while there is no live connection.
  if (!relaySubscribed) {
    relaySubscribed = true;
    subscribeBroadcast((event) => {
      if (!shouldRelayEvent(event)) return;
      sendFrame(runtime?.ws ?? null, {
        type: 'event',
        topic: event.type,
        payload: slimEventPayload(event.type, event.data),
      });
    });
  }

  const scheduleReconnect = (): void => {
    if (rt.stopped) return;
    rt.attempt += 1;
    const delay = nextBackoffMs(rt.attempt);
    console.log(`[cloud-agent] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${rt.attempt})`);
    rt.reconnectTimer = setTimeout(connect, delay);
    if (rt.reconnectTimer.unref) rt.reconnectTimer.unref();
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
        sendFrame(rt.ws, {
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
          sendFrame(rt.ws, { type: 'ai_delta', jobId: job.jobId, event });
        });
        sendFrame(rt.ws, { type: 'job_result', ...result });
        return;
      }
      const result = await executeAiJob(job);
      sendFrame(rt.ws, { type: 'job_result', ...result });
      return;
    }
    if (frame.kind !== 'http') {
      sendFrame(rt.ws, { type: 'job_result', jobId: frame.jobId, ok: false, error: 'unsupported kind' });
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
    const result = await executeHttpJob(job, PORT, rt.apiKey);
    sendFrame(rt.ws, { type: 'job_result', ...result });
  };

  function connect(): void {
    if (rt.stopped) return;
    try {
      rt.ws = new WebSocket(rt.config.url, { headers: { Authorization: `Bearer ${rt.config.token}` } });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error('[cloud-agent] Failed to open socket:', lastError);
      scheduleReconnect();
      return;
    }

    const socket = rt.ws;

    socket.on('open', () => {
      rt.connectedAt = Date.now();
      lastError = null;
      console.log('[cloud-agent] Connected');
      rt.aiCapabilityProbe
        .then((aiAvailable) => {
          // "ai.turn" (protocol v1.2): same CLI probe as "ai" — this build
          // implements turn mode + job_cancel, which is the rest of the
          // gate. The cloud checks each capability independently; a
          // phase-1 runner advertising only "ai" never sees turn frames.
          const capabilities = aiAvailable ? ['messaging', 'ai', 'ai.turn'] : ['messaging'];
          lastCapabilities = capabilities;
          sendFrame(socket, {
            type: 'hello',
            deviceName: os.hostname(),
            ownerEmail: rt.config.ownerEmail,
            capabilities,
          });
        })
        .catch(() => {
          // discoverAiCapability() never rejects, but hello must go out
          // regardless of any unforeseen failure in the probe chain.
          lastCapabilities = ['messaging'];
          sendFrame(socket, {
            type: 'hello',
            deviceName: os.hostname(),
            ownerEmail: rt.config.ownerEmail,
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
      const lived = rt.connectedAt ? Date.now() - rt.connectedAt : 0;
      if (lived > STABLE_CONNECTION_MS) rt.attempt = 0; // reset backoff after a connection that lived >60s
      rt.connectedAt = 0;
      // In-flight TURN children die with the socket: their delta stream has
      // nowhere to go and the cloud has already failed the turn. Phase-1 ai
      // jobs keep their run-to-completion-and-drop behavior (harmless).
      abortAllTurnJobs('cloud connection closed mid-turn — CLI killed');
      if (rt.stopped) return; // stop()/restart already owns the teardown
      console.log(`[cloud-agent] Disconnected${lived ? ` (was up ${Math.round(lived / 1000)}s)` : ''}`);
      scheduleReconnect();
    });

    socket.on('error', (e) => {
      lastError = e instanceof Error ? e.message : String(e);
      console.error('[cloud-agent] Socket error:', lastError);
      // 'close' always follows 'error' for ws clients — reconnect is scheduled there.
    });
  }

  connect();
}

/** Re-resolve config and reconnect; returns the fresh status. */
export function restartCloudAgent(): CloudAgentStatus {
  startCloudAgent();
  return getCloudAgentStatus();
}
