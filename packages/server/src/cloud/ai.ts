/**
 * `ai` job execution — Meridian M5b (auditware-crm docs/m5b-ai-runner.md,
 * phase 2: docs/m5b-phase2.md). In cloud, Meridian's own Claude CLI is
 * unauthenticated, so AI work routes here instead: this module shells out to
 * the *acting user's own, already-logged-in* local Claude Code CLI and ships
 * the result back as a `job_result`.
 *
 * Phase 1 covers the three non-streaming call shapes (`json`/`research`/
 * `chat`). The invocation mirrors the CRM's own (backend/src/services/
 * claude.rs run_cli_raw + json_call/research_call/chat_call) as closely as
 * the job frame allows:
 *   - base args: `-p --output-format json --no-session-persistence
 *     --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model <model>`
 *   - no `--system-prompt`: the job frame carries a single already-flattened
 *     `prompt` field (no separate `system`) — the cloud side flattens before
 *     it ever reaches the wire, same as the CRM's chat_call does internally.
 *   - no `--effort`: not part of the phase-1 job frame.
 *   - per-mode tool posture: `json` and `chat` disallow every tool
 *     (NO_TOOLS); `research` allows only WebSearch/WebFetch.
 *
 * Phase 2 adds `mode:"turn"` — the interactive assistant's streaming turns
 * (docs/m5b-phase2.md, wire-contract table is binding). A turn mirrors the
 * CRM's `run_once` (agent.rs): `--output-format stream-json` with the system
 * prompt as a SEPARATE `--system-prompt` (session continuity needs the user
 * half to be just the new message), `--session-id`/`--resume` carrying the
 * cloud-minted session identity, and an inline `--mcp-config` pointing the
 * CLI back at the cloud's `/api/assistant/mcp` with a per-turn bearer.
 * Stdout is consumed line-by-line; each line runs the slimming rules
 * (slimTurnStreamLine) and ships live as an `ai_delta` frame, with the
 * terminal outcome still arriving as the normal `job_result`. The runner is
 * a remote stdout pipe, not a parser — the cloud owns event semantics.
 *
 * Unlike claude.rs, this module never injects credentials (no pasted-token
 * env var, no isolated CLAUDE_CONFIG_DIR) — the whole point is to ride the
 * user's own local `claude /login` session, so touching their config dir
 * would defeat it. It only strips nested-session env vars so a Conduit
 * process itself launched from inside a Claude Code session doesn't leak
 * that session into the child.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const AI_JOB_MODES = ['json', 'research', 'chat'] as const;
export type AiJobMode = (typeof AI_JOB_MODES)[number];

export function isAiJobMode(value: unknown): value is AiJobMode {
  return typeof value === 'string' && (AI_JOB_MODES as readonly string[]).includes(value);
}

/** The `kind:"ai"` job frame (cloud → agent), per docs/m5b-ai-runner.md. */
export interface AiJob {
  jobId: string;
  mode: AiJobMode;
  model: string;
  /** Fully rendered prompt text (system + transcript already flattened by the cloud). */
  prompt: string;
  /** mode:"json" only — the JSON schema passed to --json-schema. */
  schema?: unknown;
  /**
   * Cloud-set budget (180 json/chat, 600 research); this runner enforces it
   * +margin, counted from job *acceptance* — time spent waiting for a
   * concurrency slot comes out of the same budget (see executeAiJob).
   */
  timeoutSecs: number;
}

/**
 * The `kind:"ai" mode:"turn"` job frame (cloud → agent), per
 * docs/m5b-phase2.md's wire-contract table. Unlike the phase-1 modes the
 * system prompt rides SEPARATELY from `prompt` (the new user message alone
 * goes over stdin) — a deliberate, turn-scoped exception to the v1.1 "no
 * system half on this wire" rule, because `--resume` session continuity
 * needs the user half un-flattened.
 */
export interface AiTurnJob {
  jobId: string;
  mode: 'turn';
  model: string;
  effort: string;
  /** Passed as `--system-prompt`; may be long, never absent. */
  system: string;
  /** The new user message alone (or the cloud's replayed-transcript fallback); over stdin. */
  prompt: string;
  /** Cloud-minted session identity: `--resume` when `resume`, else `--session-id`. */
  sessionId: string;
  resume: boolean;
  /** `{APP_PUBLIC_URL}/api/assistant/mcp` — the CLI dials back into the cloud. */
  mcpUrl: string;
  /** Per-turn bearer for mcpUrl; minted at begin_turn, dead at end_turn. */
  mcpSecret: string;
  /** Opaque argv value for --allowedTools; empty string ⇒ omit the flag. */
  allowedTools: string;
  /** Opaque argv value for --disallowedTools; empty string ⇒ omit the flag. */
  disallowedTools: string;
  timeoutSecs: number;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

interface AiJobWireFrame {
  jobId: string;
  mode?: unknown;
  model?: unknown;
  prompt?: unknown;
  schema?: unknown;
  timeoutSecs?: unknown;
  // mode:"turn" extras (docs/m5b-phase2.md)
  effort?: unknown;
  system?: unknown;
  sessionId?: unknown;
  resume?: unknown;
  mcpUrl?: unknown;
  mcpSecret?: unknown;
  allowedTools?: unknown;
  disallowedTools?: unknown;
}

function parseTurnJobFrame(frame: AiJobWireFrame): AiTurnJob | null {
  if (!nonEmptyString(frame.model)) return null;
  if (!nonEmptyString(frame.effort)) return null;
  if (typeof frame.system !== 'string') return null;
  if (typeof frame.prompt !== 'string' || frame.prompt === '') return null;
  if (!nonEmptyString(frame.sessionId)) return null;
  if (typeof frame.resume !== 'boolean') return null;
  if (!isHttpUrl(frame.mcpUrl)) return null;
  if (!nonEmptyString(frame.mcpSecret)) return null;
  if (typeof frame.allowedTools !== 'string') return null;
  if (typeof frame.disallowedTools !== 'string') return null;
  if (typeof frame.timeoutSecs !== 'number' || !Number.isFinite(frame.timeoutSecs) || frame.timeoutSecs <= 0) {
    return null;
  }
  return {
    jobId: frame.jobId,
    mode: 'turn',
    model: frame.model,
    effort: frame.effort,
    system: frame.system,
    prompt: frame.prompt,
    sessionId: frame.sessionId,
    resume: frame.resume,
    mcpUrl: frame.mcpUrl,
    mcpSecret: frame.mcpSecret,
    allowedTools: frame.allowedTools,
    disallowedTools: frame.disallowedTools,
    timeoutSecs: frame.timeoutSecs,
  };
}

/**
 * Validate one wire frame's ai fields into an `AiJob`/`AiTurnJob`, or `null`
 * when malformed (unknown mode, empty model, non-string prompt, non-positive
 * timeout; for `mode:"turn"` additionally the phase-2 required fields —
 * docs/m5b-phase2.md). Kept here — not inline in agent.ts — so a frame
 * carrying an unexpected `mode` can never reach `buildAiArgs`' per-mode tool
 * posture switch unclassified.
 */
export function parseAiJobFrame(frame: AiJobWireFrame): AiJob | AiTurnJob | null {
  if (frame.mode === 'turn') return parseTurnJobFrame(frame);
  if (!isAiJobMode(frame.mode)) return null;
  if (typeof frame.model !== 'string' || frame.model.trim() === '') return null;
  if (typeof frame.prompt !== 'string') return null;
  if (typeof frame.timeoutSecs !== 'number' || !Number.isFinite(frame.timeoutSecs) || frame.timeoutSecs <= 0) {
    return null;
  }
  return {
    jobId: frame.jobId,
    mode: frame.mode,
    model: frame.model,
    prompt: frame.prompt,
    schema: frame.schema,
    timeoutSecs: frame.timeoutSecs,
  };
}

export interface AiJobResultOk {
  jobId: string;
  ok: true;
  status: 200;
  /** The CLI's JSON result envelope, verbatim (result + usage/cost fields). */
  body: unknown;
}

export type AiErrorKind = 'not_logged_in' | 'timeout' | 'cli_error' | 'resume_failed' | 'cancelled';

export interface AiJobResultErr {
  jobId: string;
  ok: false;
  /** Top-level copy for the hub's generic `job_result.error` path. */
  error: string;
  /** Protocol body (docs/m5b-ai-runner.md): `{error, errorKind}`. */
  body: { error: string; errorKind: AiErrorKind };
}

export type AiJobResult = AiJobResultOk | AiJobResultErr;

function errResult(jobId: string, error: string, errorKind: AiErrorKind): AiJobResultErr {
  return { jobId, ok: false, error, body: { error, errorKind } };
}

/** Tools that must never run during a pure text/JSON generation call — mirrors claude.rs NO_TOOLS. */
export const NO_TOOLS = 'Bash,Edit,Write,NotebookEdit,Read,Glob,Grep,WebSearch,WebFetch,Task,TodoWrite';
/** Research calls may search/fetch the web but never touch the local machine — mirrors claude.rs RESEARCH_*. */
export const RESEARCH_ALLOWED_TOOLS = 'WebSearch,WebFetch';
export const RESEARCH_DISALLOWED_TOOLS = 'Bash,Edit,Write,NotebookEdit,Task,TodoWrite';

/** Nested-session/API-key env vars stripped from the child — mirrors claude.rs ENV_STRIP verbatim. */
export const ENV_STRIP: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
];

/** `claude --version` probe budget at startup. */
export const PROBE_TIMEOUT_MS = 2000;
/** Added on top of a job's own `timeoutSecs` before this runner kills the CLI. */
export const KILL_MARGIN_SECS = 10;
/** At most this many `ai` jobs run concurrently; the rest wait FIFO in-process. */
export const MAX_CONCURRENT_AI_JOBS = 2;
/**
 * Turn jobs get their OWN 2-slot pool, never the phase-1 ai gate: a turn is
 * interactive and can legally park 20+ minutes on an `await_approvals` — in
 * a shared gate one parked turn + one chatter rollup would starve every
 * json/research job on the box (and vice versa). docs/m5b-phase2.md.
 */
export const MAX_CONCURRENT_TURNS = 2;
/** Per text part/string inside a slimmed `user` tool-result line (docs/m5b-phase2.md). */
export const TURN_TOOL_RESULT_TEXT_CAP = 4000;
/**
 * MCP timeouts for turn children, same values the CRM's run_once sets:
 * `await_approvals` parks on humans for up to 20 min and the CLI must not
 * time the MCP call out underneath it.
 */
export const TURN_MCP_TOOL_TIMEOUT_MS = '1500000';
export const TURN_MCP_TIMEOUT_MS = '30000';

/** `CLOUD_AGENT_CLAUDE_BIN` override, else `claude` resolved off PATH. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLOUD_AGENT_CLAUDE_BIN']?.trim() || 'claude';
}

/**
 * Probe a candidate CLI binary with `--version`, bounded by `timeoutMs`.
 * Resolves `true`/`false` — never throws/rejects — so startup capability
 * discovery can't block or crash `hello` on a missing/broken install.
 */
export function probeClaudeCli(bin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['--version'], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(false);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

/**
 * Startup capability discovery: resolves the configured/PATH binary and
 * probes it once. The result decides whether `hello.capabilities` advertises
 * `"ai"` (agent.ts).
 */
export async function discoverAiCapability(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return probeClaudeCli(resolveClaudeBin(env));
}

/**
 * Neutral working directory for spawned CLIs, mirroring claude.rs
 * `spawn_cwd()` — a dedicated empty folder under the OS temp dir, so the CLI
 * never picks up a repo's CLAUDE.md or stalls scanning a huge raw temp dir.
 */
function spawnCwd(): string {
  const dir = path.join(os.tmpdir(), 'conduit-ai-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * CLI argv for one `ai` job — mirrors claude.rs run_cli_raw's base args plus
 * the per-mode tool posture from json_call/research_call/chat_call. No
 * `--system-prompt` (prompt already flattened — see module doc) and no
 * `--effort` (not part of the job frame).
 */
export function buildAiArgs(job: Pick<AiJob, 'mode' | 'model' | 'schema'>): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--model',
    job.model,
  ];
  switch (job.mode) {
    case 'json': {
      // The cloud sends the schema as a JSON object; tolerate an
      // already-serialized string without double-encoding it.
      const schema = typeof job.schema === 'string' ? job.schema : JSON.stringify(job.schema ?? {});
      args.push('--json-schema', schema);
      args.push('--disallowedTools', NO_TOOLS);
      break;
    }
    case 'research':
      args.push('--allowedTools', RESEARCH_ALLOWED_TOOLS);
      args.push('--disallowedTools', RESEARCH_DISALLOWED_TOOLS);
      break;
    case 'chat':
      args.push('--disallowedTools', NO_TOOLS);
      break;
    default:
      // Unreachable for a frame that went through parseAiJobFrame; a direct
      // caller with a bad mode must not fall through to "no tool posture".
      throw new Error(`unknown ai job mode: ${String((job as { mode?: unknown }).mode)}`);
  }
  return args;
}

/**
 * SIGKILL a spawned CLI's whole process group (it was spawned detached, so
 * it leads one), falling back to a direct kill — taking out helpers the CLI
 * spawned too, since a surviving grandchild would hold our stdio pipes open
 * and 'close' would never fire.
 */
function killProcessGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    /* group already gone, or platform quirk — fall through to direct kill */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

interface RawCliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn+wait+collect for one CLI invocation. Never throws. */
function runRawCli(
  bin: string,
  args: string[],
  prompt: string,
  timeoutSecs: number,
  killMarginSecs: number,
  envOverride?: NodeJS.ProcessEnv,
): Promise<RawCliRun> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...(envOverride ?? process.env) };
    for (const key of ENV_STRIP) delete env[key];

    let child: ReturnType<typeof spawn>;
    try {
      // detached:true makes the child a process-group leader so the timeout
      // kill below can take out the CLI *and* any helpers it spawned —
      // killing only the direct child leaves grandchildren holding our stdio
      // pipes open (the 'close' event would never fire).
      child = spawn(bin, args, { cwd: spawnCwd(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const killDeadlineMs = Math.max(0, timeoutSecs + killMarginSecs) * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, killDeadlineMs);
    if (killTimer.unref) killTimer.unref();

    const finish = (code: number | null, stderrOverride?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: stderrOverride ?? Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
      });
    };

    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
    child.on('error', (e) => finish(null, e instanceof Error ? e.message : String(e)));
    child.on('close', (code) => finish(code));

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* child may have already exited (e.g. fast failure); EPIPE is expected then */
      });
      child.stdin.write(prompt, () => child.stdin?.end());
    }
  });
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Login-failure phrases. Verified empirically against claude 2.1.233
 * (2026-11, isolated empty CLAUDE_CONFIG_DIR — no real logout needed): a
 * logged-out CLI exits **1** with the full JSON result envelope on stdout —
 * `is_error:true`, `terminal_reason:"api_error"`,
 * `result:"Not logged in · Please run /login"` — and an empty stderr. So the
 * phrase check must run on BOTH exit paths below, not only the exit-0
 * `is_error` envelope that claude.rs `check_cli_error` handles. "Invalid API
 * key" is the older CLI's phrasing of the same state, kept as a
 * belt-and-braces pattern.
 */
const NOT_LOGGED_IN_PATTERNS = ['Not logged in', 'Please run /login', 'Invalid API key'] as const;

export function isNotLoggedInMessage(message: string): boolean {
  return NOT_LOGGED_IN_PATTERNS.some((p) => message.includes(p));
}

const NOT_LOGGED_IN_ERROR = 'Claude Code CLI is not logged in — run `claude /login` on this host';

/**
 * Classify one finished CLI run into a `job_result`-ready `AiJobResult`.
 * Success requires exit 0 + a parseable envelope without `is_error`. Login
 * failures are detected by phrase on both the exit-0 `is_error` envelope and
 * the nonzero-exit path (where current CLIs actually land — see
 * NOT_LOGGED_IN_PATTERNS).
 */
function classifyResult(jobId: string, raw: RawCliRun): AiJobResult {
  if (raw.timedOut) {
    return errResult(jobId, 'claude CLI exceeded its timeout and was killed', 'timeout');
  }

  const parsedStdout = tryParseJson(raw.stdout);
  const envelope =
    typeof parsedStdout === 'object' && parsedStdout !== null ? (parsedStdout as Record<string, unknown>) : undefined;

  if (raw.code === 0) {
    if (!envelope) {
      return errResult(
        jobId,
        `claude CLI exited 0 but stdout did not parse as JSON: ${raw.stdout.slice(0, 500)}`,
        'cli_error',
      );
    }
    if (envelope['is_error'] === true) {
      const result = envelope['result'];
      const msg = typeof result === 'string' && result.trim() ? result : 'CLI reported an error';
      if (isNotLoggedInMessage(msg)) {
        return errResult(jobId, NOT_LOGGED_IN_ERROR, 'not_logged_in');
      }
      return errResult(jobId, msg, 'cli_error');
    }
    return { jobId, ok: true, status: 200, body: envelope };
  }

  // Nonzero exit. The CLI usually still printed its JSON envelope on stdout
  // (stderr stays empty) — surface its `result` text instead of ~1KB of
  // escaped JSON, mirroring claude.rs run_cli_raw's nonzero-exit handling.
  const rawText = raw.stderr.trim() || raw.stdout.trim();
  const envelopeResult = envelope ? envelope['result'] : undefined;
  const fromRawText = tryParseJson(rawText);
  const rawTextResult =
    fromRawText && typeof fromRawText === 'object' ? (fromRawText as Record<string, unknown>)['result'] : undefined;
  const message =
    typeof envelopeResult === 'string' && envelopeResult.trim()
      ? envelopeResult
      : typeof rawTextResult === 'string' && rawTextResult.trim()
        ? rawTextResult
        : rawText || `claude CLI exited with code ${raw.code ?? 'unknown'}`;
  if (isNotLoggedInMessage(message)) {
    return errResult(jobId, NOT_LOGGED_IN_ERROR, 'not_logged_in');
  }
  return errResult(jobId, `claude CLI exited with ${raw.code}: ${message}`, 'cli_error');
}

// --- Concurrency gate: at most MAX_CONCURRENT_AI_JOBS run at once, the rest
// wait FIFO in-process (module-level — one gate per Conduit process, shared
// across every ai job regardless of caller). ---
let activeAiJobs = 0;
const aiJobWaitQueue: Array<() => void> = [];

function acquireAiSlot(): Promise<void> {
  if (activeAiJobs < MAX_CONCURRENT_AI_JOBS) {
    activeAiJobs += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    aiJobWaitQueue.push(() => {
      activeAiJobs += 1;
      resolve();
    });
  });
}

function releaseAiSlot(): void {
  activeAiJobs -= 1;
  const next = aiJobWaitQueue.shift();
  if (next) next();
}

/** Exposed for tests: how many `ai` jobs are actually running right now. */
export function activeAiJobCount(): number {
  return activeAiJobs;
}

export interface ExecuteAiJobOptions {
  /** Defaults to resolveClaudeBin(env). */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to KILL_MARGIN_SECS; overridable so tests don't wait 10 real seconds. */
  killMarginSecs?: number;
}

/**
 * Run one `ai` job end to end: acquire a concurrency slot, spawn the CLI
 * with the prompt on stdin, enforce `timeoutSecs` (+margin) with a
 * process-group kill, and classify the outcome into a `job_result`-ready
 * `AiJobResult`. Never rejects — every failure mode becomes an `ok:false`
 * result so agent.ts can always reply to the cloud.
 *
 * The deadline clock starts when the job is *accepted*, not when a
 * concurrency slot frees up: the cloud gives up at timeoutSecs+30s and
 * discards a late result, so time spent queued behind the
 * MAX_CONCURRENT_AI_JOBS gate must come out of the same budget the CLI is
 * allowed to run under — otherwise a queued job's wall clock would be
 * unbounded-wait + timeoutSecs + margin. A job whose whole budget is
 * consumed by the queue wait returns a `timeout` result without spawning;
 * otherwise only the remaining budget (+margin) is enforced on the child.
 */
export async function executeAiJob(job: AiJob, opts: ExecuteAiJobOptions = {}): Promise<AiJobResult> {
  const acceptedAtMs = Date.now();
  await acquireAiSlot();
  try {
    const remainingSecs = job.timeoutSecs - (Date.now() - acceptedAtMs) / 1000;
    if (remainingSecs <= 0) {
      return errResult(
        job.jobId,
        `ai job spent its whole ${job.timeoutSecs}s budget waiting for a concurrency slot — CLI not spawned`,
        'timeout',
      );
    }
    const bin = opts.bin ?? resolveClaudeBin(opts.env ?? process.env);
    const args = buildAiArgs(job);
    const killMarginSecs = opts.killMarginSecs ?? KILL_MARGIN_SECS;
    const raw = await runRawCli(bin, args, job.prompt, remainingSecs, killMarginSecs, opts.env);
    return classifyResult(job.jobId, raw);
  } catch (e) {
    return errResult(job.jobId, e instanceof Error ? e.message : String(e), 'cli_error');
  } finally {
    releaseAiSlot();
  }
}

// ---------------------------------------------------------------------------
// mode:"turn" — streaming assistant turns (docs/m5b-phase2.md)
// ---------------------------------------------------------------------------

/**
 * CLI argv for one turn — mirrors the CRM's run_once (agent.rs): stream-json
 * with partial messages, a SEPARATE system prompt, an inline MCP config
 * dialing back into the cloud with the per-turn bearer, the cloud's tool
 * strings passed VERBATIM (opaque argv values, so the cloud can evolve the
 * toolset without a Conduit redeploy; empty string ⇒ flag omitted), and the
 * session identity as `--resume <id>` or `--session-id <id>`. The prompt is
 * NOT argv — it goes over stdin.
 */
export function buildTurnArgs(job: AiTurnJob): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      meridian: {
        type: 'http',
        url: job.mcpUrl,
        headers: { Authorization: `Bearer ${job.mcpSecret}` },
      },
    },
  });
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    job.model,
    '--effort',
    job.effort,
    '--system-prompt',
    job.system,
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
  ];
  if (job.allowedTools !== '') args.push('--allowedTools', job.allowedTools);
  if (job.disallowedTools !== '') args.push('--disallowedTools', job.disallowedTools);
  if (job.resume) args.push('--resume', job.sessionId);
  else args.push('--session-id', job.sessionId);
  return args;
}

function truncateText(text: string): string {
  return text.length > TURN_TOOL_RESULT_TEXT_CAP ? text.slice(0, TURN_TOOL_RESULT_TEXT_CAP) : text;
}

/**
 * Slim a tool_result's inner `content`: a plain string is truncated; an
 * array keeps only `text` parts (each truncated) — image/base64 blocks
 * (e.g. preview_document's multi-MB renders) are dropped, the cloud never
 * reads them. Unknown scalar shapes pass through untouched (they're tiny).
 */
function slimToolResultContent(content: unknown): unknown {
  if (typeof content === 'string') return truncateText(content);
  if (!Array.isArray(content)) return content;
  const parts: unknown[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const p = part as Record<string, unknown>;
      if (p['type'] === 'text' && typeof p['text'] === 'string') {
        parts.push({ ...p, text: truncateText(p['text']) });
      }
      // every non-text part (image, document, …) is dropped
    }
  }
  return parts;
}

/**
 * Slim a `user` stream-json line (tool results): within each tool_result
 * block keep ONLY `tool_use_id`/`is_error`/slimmed `content`; loose text
 * blocks are kept truncated; every other block type is dropped. Top-level
 * fields (session_id etc.) and the message's non-content fields ride through
 * so the cloud's shared line parser sees the same shape as locally.
 */
function slimUserLine(line: Record<string, unknown>): Record<string, unknown> {
  const message = line['message'];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return line;
  const msg = message as Record<string, unknown>;
  const content = msg['content'];
  if (typeof content === 'string') {
    return { ...line, message: { ...msg, content: truncateText(content) } };
  }
  if (!Array.isArray(content)) return line;
  const blocks: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'tool_result') {
      const slim: Record<string, unknown> = { type: 'tool_result' };
      if ('tool_use_id' in b) slim['tool_use_id'] = b['tool_use_id'];
      if ('is_error' in b) slim['is_error'] = b['is_error'];
      if ('content' in b) slim['content'] = slimToolResultContent(b['content']);
      blocks.push(slim);
    } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
      blocks.push({ ...b, text: truncateText(b['text']) });
    }
    // other block types (image, …) dropped
  }
  return { ...line, message: { ...msg, content: blocks } };
}

/**
 * The delta slimming rules (docs/m5b-phase2.md, binding): `system`/
 * `assistant`/`result` lines verbatim (assistant tool_use keeps its full
 * `input` — it feeds the UI's tool detail exactly as locally); `stream_event`
 * only when it's a content_block_delta/text_delta (all the cloud consumes —
 * live text), every other subtype dropped; `user` lines slimmed per
 * slimUserLine; anything else — including any line that doesn't parse as a
 * JSON object — dropped. Returns the event to forward, or `undefined` to
 * drop the line.
 */
export function slimTurnStreamLine(rawLine: string): Record<string, unknown> | undefined {
  const parsed = tryParseJson(rawLine);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const line = parsed as Record<string, unknown>;
  switch (line['type']) {
    case 'system':
    case 'assistant':
    case 'result':
      return line;
    case 'stream_event': {
      const event = line['event'];
      if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
      const e = event as Record<string, unknown>;
      if (e['type'] !== 'content_block_delta') return undefined;
      const delta = e['delta'];
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return undefined;
      if ((delta as Record<string, unknown>)['type'] !== 'text_delta') return undefined;
      return line;
    }
    case 'user':
      return slimUserLine(line);
    default:
      return undefined;
  }
}

/**
 * Incremental chunk→line splitter (the turn contract is line-by-line
 * forwarding, not buffered-to-exit). StringDecoder keeps multi-byte UTF-8
 * sequences split across chunks intact; `flush()` emits any unterminated
 * final line so the runner has flushed everything before `job_result`.
 */
function createLineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const emit = (line: string): void => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (clean !== '') onLine(clean);
  };
  return {
    push(chunk: Buffer): void {
      buffer += decoder.write(chunk);
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    },
    flush(): void {
      buffer += decoder.end();
      emit(buffer);
      buffer = '';
    },
  };
}

// --- Turn pool + in-flight registry. The pool is deliberately SEPARATE from
// the phase-1 ai gate (see MAX_CONCURRENT_TURNS). The registry exists so a
// `job_cancel` frame (or a dropped cloud socket) can SIGKILL the matching
// turn's process group — including a turn still queued for a slot, which is
// yanked from the wait queue and settles as cancelled without spawning. ---

interface TurnRegistryEntry {
  cancelled: boolean;
  cancelReason?: string;
  child?: ReturnType<typeof spawn>;
  /** Set while the turn waits for a pool slot; resolves the wait as cancelled. */
  cancelWait?: () => void;
}

const inFlightTurns = new Map<string, TurnRegistryEntry>();

let activeTurns = 0;
interface TurnWaiter {
  entry: TurnRegistryEntry;
  grant: () => void;
}
const turnWaitQueue: TurnWaiter[] = [];

function acquireTurnSlot(entry: TurnRegistryEntry): Promise<'granted' | 'cancelled'> {
  if (activeTurns < MAX_CONCURRENT_TURNS) {
    activeTurns += 1;
    return Promise.resolve('granted');
  }
  return new Promise((resolve) => {
    const waiter: TurnWaiter = {
      entry,
      grant: () => {
        activeTurns += 1;
        resolve('granted');
      },
    };
    entry.cancelWait = () => {
      const idx = turnWaitQueue.indexOf(waiter);
      if (idx !== -1) {
        turnWaitQueue.splice(idx, 1);
        resolve('cancelled');
      }
    };
    turnWaitQueue.push(waiter);
  });
}

function releaseTurnSlot(): void {
  activeTurns -= 1;
  const next = turnWaitQueue.shift();
  if (next) next.grant();
}

/** Exposed for tests: how many turn jobs hold a pool slot right now. */
export function activeTurnJobCount(): number {
  return activeTurns;
}

const CANCELLED_BY_FRAME = 'turn cancelled by job_cancel';

/**
 * `job_cancel` handling (docs/m5b-phase2.md): SIGKILL the matching turn's
 * process group; its in-flight execution then settles with the documented
 * `job_result {ok:false, body:{error, errorKind:"cancelled"}}` through the
 * normal completion path (so exactly one job_result is sent). Unknown jobId
 * ⇒ silent no-op, returns false.
 */
export function cancelTurnJob(jobId: string, reason: string = CANCELLED_BY_FRAME): boolean {
  const entry = inFlightTurns.get(jobId);
  if (!entry) return false;
  entry.cancelled = true;
  entry.cancelReason = reason;
  entry.cancelWait?.();
  if (entry.child) killProcessGroup(entry.child);
  return true;
}

/**
 * Socket-close sweep: in-flight turn children are killed — their delta
 * stream has nowhere to go and the cloud has already failed the turn.
 * (Phase-1 jobs keep their run-to-completion-and-drop behavior; this touches
 * turns only.)
 */
export function abortAllTurnJobs(reason: string): void {
  for (const jobId of [...inFlightTurns.keys()]) cancelTurnJob(jobId, reason);
}

interface RawTurnRun {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  /** Slimmed lines actually shipped as ai_delta frames — resume_failed detection. */
  forwardedLines: number;
  /** The last `result` line's envelope, if one streamed — the success body. */
  lastResultEnvelope?: Record<string, unknown>;
}

/** Spawn+stream+wait for one turn CLI invocation. Never throws. */
function runTurnCli(
  job: AiTurnJob,
  entry: TurnRegistryEntry,
  bin: string,
  args: string[],
  timeoutSecs: number,
  killMarginSecs: number,
  onDelta: (event: Record<string, unknown>) => void,
  envOverride?: NodeJS.ProcessEnv,
): Promise<RawTurnRun> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...(envOverride ?? process.env) };
    for (const key of ENV_STRIP) delete env[key];
    env['MCP_TOOL_TIMEOUT'] = TURN_MCP_TOOL_TIMEOUT_MS;
    env['MCP_TIMEOUT'] = TURN_MCP_TIMEOUT_MS;

    let child: ReturnType<typeof spawn>;
    try {
      // detached:true — group leader, same reasoning as runRawCli, and the
      // group kill is also what job_cancel rides.
      child = spawn(bin, args, { cwd: spawnCwd(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({
        code: null,
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        forwardedLines: 0,
      });
      return;
    }
    entry.child = child;

    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let forwardedLines = 0;
    let lastResultEnvelope: Record<string, unknown> | undefined;

    const splitter = createLineSplitter((line) => {
      const event = slimTurnStreamLine(line);
      if (event === undefined) return;
      forwardedLines += 1;
      if (event['type'] === 'result') lastResultEnvelope = event;
      try {
        onDelta(event);
      } catch {
        /* the delta transport must never kill the turn — terminal truth is job_result */
      }
    });

    const killDeadlineMs = Math.max(0, timeoutSecs + killMarginSecs) * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, killDeadlineMs);
    if (killTimer.unref) killTimer.unref();

    const finish = (code: number | null, stderrOverride?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      // Flush any unterminated final line BEFORE resolving: the contract asks
      // the runner to flush stdout (as ai_delta frames) before job_result.
      splitter.flush();
      resolve({
        code,
        stderr: stderrOverride ?? Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        forwardedLines,
        lastResultEnvelope,
      });
    };

    child.stdout?.on('data', (d: Buffer) => splitter.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
    child.on('error', (e) => finish(null, e instanceof Error ? e.message : String(e)));
    child.on('close', (code) => finish(code));

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* child may have already exited (e.g. fast failure); EPIPE is expected then */
      });
      child.stdin.write(job.prompt, () => child.stdin?.end());
    }
  });
}

/**
 * Classify one finished turn run (docs/m5b-phase2.md error-path table):
 * cancelled (we killed it on job_cancel/socket-close) and timeout first; a
 * clean exit succeeds with the last streamed `result` envelope as the
 * verbatim body (the same object the final ai_delta carried); the
 * not-logged-in phrase check runs on both exit paths exactly as phase 1; a
 * `resume:true` turn that exited nonzero having forwarded ZERO stream lines
 * is `resume_failed` (the session file is gone — the cloud re-runs fresh
 * with a replayed transcript); everything else is `cli_error`.
 */
function classifyTurnResult(job: AiTurnJob, entry: TurnRegistryEntry, raw: RawTurnRun): AiJobResult {
  if (entry.cancelled) {
    return errResult(job.jobId, entry.cancelReason ?? CANCELLED_BY_FRAME, 'cancelled');
  }
  if (raw.timedOut) {
    return errResult(job.jobId, 'claude CLI exceeded its timeout and was killed', 'timeout');
  }

  const envelope = raw.lastResultEnvelope;
  if (raw.code === 0) {
    if (!envelope) {
      return errResult(job.jobId, 'claude CLI exited 0 but streamed no result envelope', 'cli_error');
    }
    if (envelope['is_error'] === true) {
      const result = envelope['result'];
      const msg = typeof result === 'string' && result.trim() ? result : 'CLI reported an error';
      if (isNotLoggedInMessage(msg)) {
        return errResult(job.jobId, NOT_LOGGED_IN_ERROR, 'not_logged_in');
      }
      return errResult(job.jobId, msg, 'cli_error');
    }
    return { jobId: job.jobId, ok: true, status: 200, body: envelope };
  }

  // Nonzero (or no) exit. Prefer the streamed envelope's `result` text, then
  // stderr, mirroring phase-1 classifyResult's message extraction.
  const envelopeResult = envelope ? envelope['result'] : undefined;
  const stderrText = raw.stderr.trim();
  const message =
    typeof envelopeResult === 'string' && envelopeResult.trim()
      ? envelopeResult
      : stderrText || `claude CLI exited with code ${raw.code ?? 'unknown'}`;
  if (isNotLoggedInMessage(message)) {
    return errResult(job.jobId, NOT_LOGGED_IN_ERROR, 'not_logged_in');
  }
  // resume_failed requires an actual nonzero EXIT (code !== null): a spawn
  // error (ENOENT etc.) never exited and must stay cli_error, not trigger the
  // cloud's transcript-replay re-dispatch.
  if (job.resume && raw.code !== null && raw.forwardedLines === 0) {
    return errResult(
      job.jobId,
      `claude CLI could not resume session ${job.sessionId} (exited ${raw.code} with no stream output): ${message}`,
      'resume_failed',
    );
  }
  return errResult(job.jobId, `claude CLI exited with ${raw.code}: ${message}`, 'cli_error');
}

export interface ExecuteTurnJobOptions {
  /** Defaults to resolveClaudeBin(env). */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to KILL_MARGIN_SECS; overridable so tests don't wait 10 real seconds. */
  killMarginSecs?: number;
}

/**
 * Run one `mode:"turn"` job end to end: register it for `job_cancel`,
 * acquire a TURN-pool slot (never the phase-1 ai gate), spawn the CLI with
 * the new user message on stdin, forward each slimmed stdout line live via
 * `onDelta` (agent.ts wraps it into `ai_delta {jobId, event}` frames), and
 * settle into a `job_result`-ready `AiJobResult`. Never rejects. The same
 * budget-from-acceptance rule as phase 1 applies within the pool: slot-wait
 * time comes out of `timeoutSecs`.
 */
export async function executeTurnJob(
  job: AiTurnJob,
  onDelta: (event: Record<string, unknown>) => void,
  opts: ExecuteTurnJobOptions = {},
): Promise<AiJobResult> {
  const acceptedAtMs = Date.now();
  const entry: TurnRegistryEntry = { cancelled: false };
  inFlightTurns.set(job.jobId, entry);
  try {
    const acquired = await acquireTurnSlot(entry);
    if (acquired === 'cancelled') {
      // Yanked from the wait queue by job_cancel — no slot held, nothing spawned.
      return errResult(job.jobId, entry.cancelReason ?? CANCELLED_BY_FRAME, 'cancelled');
    }
    try {
      if (entry.cancelled) {
        // Cancel raced in between grant and spawn.
        return errResult(job.jobId, entry.cancelReason ?? CANCELLED_BY_FRAME, 'cancelled');
      }
      const remainingSecs = job.timeoutSecs - (Date.now() - acceptedAtMs) / 1000;
      if (remainingSecs <= 0) {
        return errResult(
          job.jobId,
          `turn spent its whole ${job.timeoutSecs}s budget waiting for a turn slot — CLI not spawned`,
          'timeout',
        );
      }
      const bin = opts.bin ?? resolveClaudeBin(opts.env ?? process.env);
      const args = buildTurnArgs(job);
      const killMarginSecs = opts.killMarginSecs ?? KILL_MARGIN_SECS;
      const raw = await runTurnCli(job, entry, bin, args, remainingSecs, killMarginSecs, onDelta, opts.env);
      return classifyTurnResult(job, entry, raw);
    } finally {
      releaseTurnSlot();
    }
  } catch (e) {
    return errResult(job.jobId, e instanceof Error ? e.message : String(e), 'cli_error');
  } finally {
    inFlightTurns.delete(job.jobId);
  }
}
