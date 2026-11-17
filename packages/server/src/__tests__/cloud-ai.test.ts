/**
 * `ai` job runner tests (cloud/ai.ts) — M5b phase 1. The claude CLI is never
 * actually invoked: node:child_process is mocked with an EventEmitter-backed
 * fake child, so these cover the pure/orchestration layer — argv construction
 * per mode, frame validation, errorKind classification (incl. the empirical
 * exit-1 logged-out envelope), env hygiene, the timeout's process-group kill,
 * the 2-slot FIFO concurrency gate, and the accepted-at deadline accounting
 * (queue wait counts against timeoutSecs).
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_JOB_MODES,
  activeAiJobCount,
  buildAiArgs,
  ENV_STRIP,
  executeAiJob,
  isAiJobMode,
  isNotLoggedInMessage,
  MAX_CONCURRENT_AI_JOBS,
  NO_TOOLS,
  parseAiJobFrame,
  probeClaudeCli,
  RESEARCH_ALLOWED_TOOLS,
  RESEARCH_DISALLOWED_TOOLS,
  resolveClaudeBin,
  type AiJob,
  type AiJobResult,
} from '../cloud/ai.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);

/** EventEmitter-backed stand-in for a spawned CLI child. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written = '';
  pid = 4242;
  killSignals: string[] = [];
  stdin = {
    on: (): void => {},
    write: (data: string, cb?: () => void): boolean => {
      this.written += data;
      cb?.();
      return true;
    },
    end: (): void => {},
  };
  kill(signal?: string): boolean {
    this.killSignals.push(signal ?? 'SIGTERM');
    return true;
  }
}

/** Queue a child's terminal output+exit for after listeners are attached. */
function finishLater(child: FakeChild, opts: { stdout?: string; stderr?: string; code: number | null }): void {
  queueMicrotask(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code);
  });
}

function mockNextChild(opts: { stdout?: string; stderr?: string; code: number | null }): FakeChild {
  const child = new FakeChild();
  spawnMock.mockImplementationOnce(() => {
    finishLater(child, opts);
    return child as unknown as ReturnType<typeof spawn>;
  });
  return child;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

const baseJob: AiJob = { jobId: 'j1', mode: 'chat', model: 'claude-haiku-4-5', prompt: 'hi', timeoutSecs: 60 };

// Captured verbatim from claude 2.1.233 run against an empty isolated
// CLAUDE_CONFIG_DIR (slimmed): logged-out exits 1 with this on stdout.
const LOGGED_OUT_ENVELOPE = JSON.stringify({
  is_error: true,
  terminal_reason: 'api_error',
  subtype: 'success',
  result: 'Not logged in · Please run /login',
  type: 'result',
  total_cost_usd: 0,
});

const OK_ENVELOPE = { type: 'result', is_error: false, result: 'hello there', total_cost_usd: 0.001, usage: { output_tokens: 5 } };

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveClaudeBin', () => {
  it('prefers CLOUD_AGENT_CLAUDE_BIN, falls back to `claude` on PATH', () => {
    expect(resolveClaudeBin({ CLOUD_AGENT_CLAUDE_BIN: '/opt/claude' })).toBe('/opt/claude');
    expect(resolveClaudeBin({ CLOUD_AGENT_CLAUDE_BIN: '   ' })).toBe('claude');
    expect(resolveClaudeBin({})).toBe('claude');
  });
});

describe('buildAiArgs', () => {
  const base = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', 'm1'];

  it('json: schema object serialized, all tools disallowed, nothing allowed', () => {
    const args = buildAiArgs({ mode: 'json', model: 'm1', schema: { type: 'object' } });
    expect(args.slice(0, base.length)).toEqual(base);
    expect(args).toContain('--json-schema');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(NO_TOOLS);
    expect(args).not.toContain('--allowedTools');
  });

  it('json: an already-serialized schema string passes through un-double-encoded', () => {
    const args = buildAiArgs({ mode: 'json', model: 'm1', schema: '{"type":"object"}' });
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });

  it('research: only WebSearch/WebFetch allowed, local tools disallowed, no schema', () => {
    const args = buildAiArgs({ mode: 'research', model: 'm1' });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(RESEARCH_ALLOWED_TOOLS);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(RESEARCH_DISALLOWED_TOOLS);
    expect(args).not.toContain('--json-schema');
  });

  it('chat: all tools disallowed, no schema', () => {
    const args = buildAiArgs({ mode: 'chat', model: 'm1' });
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(NO_TOOLS);
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('--allowedTools');
  });

  it('throws on an unknown mode instead of running with no tool posture', () => {
    expect(() => buildAiArgs({ mode: 'evil' as never, model: 'm1' })).toThrow(/unknown ai job mode/);
  });
});

describe('parseAiJobFrame / isAiJobMode', () => {
  const good = { jobId: 'j1', mode: 'json', model: 'm1', prompt: 'p', schema: {}, timeoutSecs: 180 };

  it('accepts a well-formed frame', () => {
    expect(parseAiJobFrame(good)).toEqual(good);
  });

  it('rejects unknown modes, bad models, non-string prompts, bad timeouts', () => {
    expect(parseAiJobFrame({ ...good, mode: 'turn' })).toBeNull(); // phase-2 kind, not ours yet
    expect(parseAiJobFrame({ ...good, mode: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, model: '' })).toBeNull();
    expect(parseAiJobFrame({ ...good, model: 42 })).toBeNull();
    expect(parseAiJobFrame({ ...good, prompt: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, timeoutSecs: '180' })).toBeNull();
    expect(parseAiJobFrame({ ...good, timeoutSecs: 0 })).toBeNull();
    expect(parseAiJobFrame({ ...good, timeoutSecs: Number.NaN })).toBeNull();
  });

  it('isAiJobMode matches exactly the three phase-1 modes', () => {
    for (const mode of AI_JOB_MODES) expect(isAiJobMode(mode)).toBe(true);
    expect(isAiJobMode('turn')).toBe(false);
    expect(isAiJobMode(undefined)).toBe(false);
  });
});

describe('isNotLoggedInMessage', () => {
  it('matches the observed 2.1.233 phrase and older variants', () => {
    expect(isNotLoggedInMessage('Not logged in · Please run /login')).toBe(true);
    expect(isNotLoggedInMessage('Invalid API key · Please run /login')).toBe(true);
    expect(isNotLoggedInMessage('Overloaded')).toBe(false);
    expect(isNotLoggedInMessage('')).toBe(false);
  });
});

describe('executeAiJob', () => {
  it('success: exit 0 envelope comes back verbatim as the body', async () => {
    const child = mockNextChild({ stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    const result = await executeAiJob(baseJob, { bin: 'claude-fake' });
    expect(result).toEqual({ jobId: 'j1', ok: true, status: 200, body: OK_ENVELOPE });
    expect(child.written).toBe('hi'); // prompt over stdin, not argv
    const [bin, args, spawnOpts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(bin).toBe('claude-fake');
    expect(args).toEqual(buildAiArgs(baseJob));
    expect(spawnOpts.detached).toBe(true); // group leader → group kill works
  });

  it('strips nested-session/API-key env vars from the child, keeps the rest', async () => {
    mockNextChild({ stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    const env = { PATH: '/bin', KEEP_ME: 'y' } as NodeJS.ProcessEnv;
    for (const key of ENV_STRIP) env[key] = 'leaked';
    await executeAiJob(baseJob, { bin: 'claude-fake', env });
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    for (const key of ENV_STRIP) expect(spawnOpts.env).not.toHaveProperty(key);
    expect(spawnOpts.env.PATH).toBe('/bin');
    expect(spawnOpts.env.KEEP_ME).toBe('y');
  });

  it('not_logged_in: the real CLI shape — exit 1, is_error envelope on stdout, empty stderr', async () => {
    mockNextChild({ stdout: LOGGED_OUT_ENVELOPE, code: 1 });
    const result = (await executeAiJob(baseJob, { bin: 'claude-fake' })) as Extract<AiJobResult, { ok: false }>;
    expect(result.ok).toBe(false);
    expect(result.body.errorKind).toBe('not_logged_in');
    expect(result.error).toMatch(/claude \/login/);
    expect(result.body.error).toBe(result.error);
  });

  it('not_logged_in: also caught on the exit-0 is_error path (claude.rs check_cli_error shape)', async () => {
    mockNextChild({ stdout: LOGGED_OUT_ENVELOPE, code: 0 });
    const result = (await executeAiJob(baseJob, { bin: 'claude-fake' })) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('not_logged_in');
  });

  it('cli_error: exit-0 is_error envelope with a non-login message surfaces the result text', async () => {
    mockNextChild({ stdout: JSON.stringify({ is_error: true, result: 'Overloaded' }), code: 0 });
    const result = (await executeAiJob(baseJob, { bin: 'claude-fake' })) as Extract<AiJobResult, { ok: false }>;
    expect(result.body).toEqual({ error: 'Overloaded', errorKind: 'cli_error' });
  });

  it('cli_error: nonzero exit with plain stderr', async () => {
    mockNextChild({ stderr: 'segfault or something', code: 139 });
    const result = (await executeAiJob(baseJob, { bin: 'claude-fake' })) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('cli_error');
    expect(result.error).toContain('139');
    expect(result.error).toContain('segfault or something');
  });

  it('cli_error: exit 0 but non-JSON stdout', async () => {
    mockNextChild({ stdout: 'plain text, not an envelope', code: 0 });
    const result = (await executeAiJob(baseJob, { bin: 'claude-fake' })) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('cli_error');
    expect(result.error).toContain('did not parse as JSON');
  });

  it('cli_error: spawn error event (e.g. ENOENT) resolves instead of throwing', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn claude-fake ENOENT')));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const result = (await executeAiJob(baseJob, { bin: 'claude-fake' })) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('cli_error');
    expect(result.error).toContain('ENOENT');
  });

  it('timeout: kills the child process group after timeoutSecs+margin and reports errorKind timeout', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>); // never exits on its own
    const groupKills: Array<number | string> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      groupKills.push(pid);
      child.emit('close', null); // the SIGKILL'd group's pipes close
      return true;
    }) as typeof process.kill);

    const result = (await executeAiJob(
      { ...baseJob, timeoutSecs: 0.01 },
      { bin: 'claude-fake', killMarginSecs: 0 },
    )) as Extract<AiJobResult, { ok: false }>;

    expect(result.body.errorKind).toBe('timeout');
    expect(result.error).toContain('timeout');
    expect(groupKills).toEqual([-child.pid]); // negative pid = whole process group
    killSpy.mockRestore();
  });

  it('deadline counts queue wait: whole budget consumed before spawn → timeout without spawning', async () => {
    const t0 = 1_700_000_000_000;
    // First Date.now() = acceptance, second = after slot acquisition: the
    // whole 60s budget (and then some) elapsed "while queued".
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(t0)
      .mockReturnValueOnce(t0 + (baseJob.timeoutSecs + 1) * 1000);

    const result = (await executeAiJob(baseJob, { bin: 'claude-fake' })) as Extract<AiJobResult, { ok: false }>;

    expect(spawnMock).not.toHaveBeenCalled();
    expect(result.body.errorKind).toBe('timeout');
    expect(result.error).toContain('concurrency slot');
    expect(result.body.error).toBe(result.error);
    expect(activeAiJobCount()).toBe(0); // slot released even on the no-spawn path
  });

  it('deadline counts queue wait: only the remaining budget is enforced on the spawned CLI', async () => {
    const t0 = 1_700_000_000_000;
    // 59.99s of the 60s budget elapses before the slot frees → ~10ms left.
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0).mockReturnValueOnce(t0 + 59_990);
    const child = new FakeChild(); // never exits on its own
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      child.emit('close', null); // the SIGKILL'd group's pipes close
      return true;
    }) as typeof process.kill);

    // If the full 60s budget were (wrongly) re-granted at spawn, the kill
    // timer would be 60s out and this await would trip vitest's test timeout;
    // the ~10ms remaining-budget kill is what lets it resolve.
    const result = (await executeAiJob(baseJob, {
      bin: 'claude-fake',
      killMarginSecs: 0,
    })) as Extract<AiJobResult, { ok: false }>;

    expect(result.body.errorKind).toBe('timeout');
    expect(killSpy).toHaveBeenCalled();
  });

  it('deadline counts queue wait: a job starved in the FIFO queue past its budget never spawns', async () => {
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    });
    const blockers = [
      executeAiJob({ ...baseJob, jobId: 'b1' }, { bin: 'x' }),
      executeAiJob({ ...baseJob, jobId: 'b2' }, { bin: 'x' }),
    ];
    const starved = executeAiJob({ ...baseJob, jobId: 'starved', timeoutSecs: 0.02 }, { bin: 'x' });
    await flush();
    expect(children).toHaveLength(2); // starved is queued behind the 2-slot gate

    await new Promise((r) => setTimeout(r, 50)); // its whole 20ms budget elapses in the queue
    finishLater(children[0]!, { stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    const result = (await starved) as Extract<AiJobResult, { ok: false }>;

    expect(result.body.errorKind).toBe('timeout');
    expect(children).toHaveLength(2); // no third child was ever spawned

    finishLater(children[1]!, { stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    const settled = await Promise.all(blockers);
    expect(settled.map((r) => r.ok)).toEqual([true, true]);
    expect(activeAiJobCount()).toBe(0);
  });

  it('runs at most MAX_CONCURRENT_AI_JOBS at once; extras start FIFO as slots free', async () => {
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    });
    const job = (id: string): AiJob => ({ ...baseJob, jobId: id, prompt: `prompt-${id}` });
    const results = [executeAiJob(job('a'), { bin: 'x' }), executeAiJob(job('b'), { bin: 'x' }), executeAiJob(job('c'), { bin: 'x' }), executeAiJob(job('d'), { bin: 'x' })];
    await flush();

    expect(children).toHaveLength(MAX_CONCURRENT_AI_JOBS); // c and d queued, not spawned
    expect(activeAiJobCount()).toBe(MAX_CONCURRENT_AI_JOBS);

    finishLater(children[0]!, { stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    await flush();
    expect(children).toHaveLength(3); // a freed its slot → c (FIFO) spawned
    expect(children[2]!.written).toBe('prompt-c');

    finishLater(children[1]!, { stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    await flush();
    expect(children).toHaveLength(4);
    expect(children[3]!.written).toBe('prompt-d');

    finishLater(children[2]!, { stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    finishLater(children[3]!, { stdout: JSON.stringify(OK_ENVELOPE), code: 0 });
    const settled = await Promise.all(results);
    expect(settled.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(activeAiJobCount()).toBe(0);
  });
});

describe('probeClaudeCli', () => {
  it('true on exit 0, false on nonzero exit or spawn error, false on hang (timeout)', async () => {
    const ok = new FakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => ok.emit('exit', 0));
      return ok as unknown as ReturnType<typeof spawn>;
    });
    await expect(probeClaudeCli('claude-fake')).resolves.toBe(true);

    const bad = new FakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => bad.emit('exit', 1));
      return bad as unknown as ReturnType<typeof spawn>;
    });
    await expect(probeClaudeCli('claude-fake')).resolves.toBe(false);

    const missing = new FakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => missing.emit('error', new Error('ENOENT')));
      return missing as unknown as ReturnType<typeof spawn>;
    });
    await expect(probeClaudeCli('claude-fake')).resolves.toBe(false);

    const hung = new FakeChild();
    spawnMock.mockImplementationOnce(() => hung as unknown as ReturnType<typeof spawn>);
    await expect(probeClaudeCli('claude-fake', 20)).resolves.toBe(false);
    expect(hung.killSignals).toContain('SIGKILL');
  });
});
