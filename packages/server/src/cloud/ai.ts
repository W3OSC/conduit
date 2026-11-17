/**
 * `ai` job execution — Meridian M5b phase 1 (auditware-crm
 * docs/m5b-ai-runner.md). In cloud, Meridian's own Claude CLI is
 * unauthenticated, so AI work routes here instead: this module shells out to
 * the *acting user's own, already-logged-in* local Claude Code CLI and ships
 * the result back as a `job_result`.
 *
 * The invocation mirrors the CRM's own (backend/src/services/claude.rs
 * run_cli_raw + json_call/research_call/chat_call) as closely as the job
 * frame allows:
 *   - base args: `-p --output-format json --no-session-persistence
 *     --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model <model>`
 *   - no `--system-prompt`: the job frame carries a single already-flattened
 *     `prompt` field (no separate `system`) — the cloud side flattens before
 *     it ever reaches the wire, same as the CRM's chat_call does internally.
 *   - no `--effort`: not part of the ai job frame.
 *   - per-mode tool posture: `json` and `chat` disallow every tool
 *     (NO_TOOLS); `research` allows only WebSearch/WebFetch.
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
 * Validate one wire frame's ai fields into an `AiJob`, or `null` when
 * malformed (unknown mode, empty model, non-string prompt, non-positive
 * timeout). Kept here — not inline in agent.ts — so a frame carrying an
 * unexpected `mode` can never reach `buildAiArgs`' per-mode tool posture
 * switch unclassified.
 */
export function parseAiJobFrame(frame: {
  jobId: string;
  mode?: unknown;
  model?: unknown;
  prompt?: unknown;
  schema?: unknown;
  timeoutSecs?: unknown;
}): AiJob | null {
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

export type AiErrorKind = 'not_logged_in' | 'timeout' | 'cli_error';

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

    const killChildGroup = (): void => {
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
    };

    const killDeadlineMs = Math.max(0, timeoutSecs + killMarginSecs) * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killChildGroup();
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
