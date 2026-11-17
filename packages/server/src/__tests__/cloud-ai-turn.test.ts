/**
 * `mode:"turn"` runner tests (cloud/ai.ts) — M5b phase 2
 * (auditware-crm docs/m5b-phase2.md; its wire-contract table is binding).
 * The claude CLI is never actually invoked: node:child_process is mocked
 * with an EventEmitter-backed fake child. Covered here: turn frame
 * validation, argv construction (fresh vs resume, inline MCP config,
 * empty-string ⇒ omitted tool flags), the delta slimming rules (verbatim
 * system/assistant/result, text_delta-only stream_events, base64 stripping
 * + 4000-char truncation on user tool results), line-by-line forwarding
 * incl. chunk splits and the pre-job_result flush, the SEPARATE 2-slot turn
 * pool (a parked turn must not starve phase-1 json/research jobs), cancel's
 * process-group kill (in-flight and still-queued), and errorKind
 * classification (resume_failed / cancelled / not_logged_in / timeout /
 * cli_error).
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortAllTurnJobs,
  activeAiJobCount,
  activeTurnJobCount,
  buildTurnArgs,
  cancelTurnJob,
  ENV_STRIP,
  executeAiJob,
  executeTurnJob,
  MAX_CONCURRENT_TURNS,
  parseAiJobFrame,
  slimTurnStreamLine,
  TURN_MCP_TIMEOUT_MS,
  TURN_MCP_TOOL_TIMEOUT_MS,
  TURN_TOOL_RESULT_TEXT_CAP,
  type AiJobResult,
  type AiTurnJob,
} from '../cloud/ai.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);

let nextPid = 5000;

/** EventEmitter-backed stand-in for a spawned CLI child (unique pid per child). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written = '';
  pid = (nextPid += 1);
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

/** Collect every child the spawn mock hands out, in order. */
function collectChildren(): FakeChild[] {
  const children: FakeChild[] = [];
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<typeof spawn>;
  });
  return children;
}

/** Emit stream-json lines (one JSON object per line) on a child's stdout. */
function emitLines(child: FakeChild, lines: unknown[]): void {
  for (const line of lines) child.stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`));
}

/**
 * Route process.kill(-pid) group kills back to the matching fake child as a
 * 'close' (the SIGKILL'd group's pipes close). Returns the kill log.
 */
function spyGroupKills(children: FakeChild[]): Array<number | string> {
  const kills: Array<number | string> = [];
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    kills.push(pid);
    const child = children.find((c) => -c.pid === pid);
    child?.emit('close', null);
    return true;
  }) as typeof process.kill);
  return kills;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

const noopDelta = (): void => {};

const baseTurn: AiTurnJob = {
  jobId: 't1',
  mode: 'turn',
  model: 'claude-sonnet-4-5',
  effort: 'medium',
  system: 'You are the Meridian assistant.',
  prompt: 'hello there',
  sessionId: 'sess-123',
  resume: false,
  mcpUrl: 'https://meridian.auditware.io/api/assistant/mcp',
  mcpSecret: 'per-turn-secret',
  allowedTools: 'mcp__meridian__crm_api_get,mcp__meridian__conduit',
  disallowedTools: 'Bash,Edit,Write',
  timeoutSecs: 1800,
};

const SYSTEM_LINE = { type: 'system', subtype: 'init', session_id: 'sess-123', model: 'claude-sonnet-4-5' };
const TEXT_DELTA_LINE = {
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
};
const ASSISTANT_LINE = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Hello!' },
      { type: 'tool_use', id: 'tu_1', name: 'mcp__meridian__crm_api_get', input: { path: '/api/leads', big: 'x'.repeat(8000) } },
    ],
  },
  session_id: 'sess-123',
};
const RESULT_LINE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done',
  session_id: 'sess-123',
  total_cost_usd: 0.12,
  usage: { input_tokens: 10, output_tokens: 20 },
};
const LOGGED_OUT_RESULT_LINE = {
  type: 'result',
  is_error: true,
  terminal_reason: 'api_error',
  result: 'Not logged in · Please run /login',
  total_cost_usd: 0,
};

beforeEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe('parseAiJobFrame (mode:"turn")', () => {
  const good = {
    jobId: 't1',
    mode: 'turn',
    model: 'claude-sonnet-4-5',
    effort: 'medium',
    system: 'sys',
    prompt: 'p',
    sessionId: 'sess-123',
    resume: false,
    mcpUrl: 'https://meridian.auditware.io/api/assistant/mcp',
    mcpSecret: 'sec',
    allowedTools: 'A,B',
    disallowedTools: 'C',
    timeoutSecs: 1800,
  };

  it('accepts a well-formed turn frame', () => {
    expect(parseAiJobFrame(good)).toEqual(good);
  });

  it('accepts empty tool strings (⇒ omitted flags), an empty system, and http mcpUrl (dev boxes)', () => {
    expect(parseAiJobFrame({ ...good, allowedTools: '', disallowedTools: '' })).toMatchObject({
      allowedTools: '',
      disallowedTools: '',
    });
    expect(parseAiJobFrame({ ...good, system: '' })).toMatchObject({ system: '' });
    expect(parseAiJobFrame({ ...good, mcpUrl: 'http://paseo.tailc850b.ts.net:5001/api/assistant/mcp' })).not.toBeNull();
  });

  it('ignores unknown extra fields (tolerance rule) — they never reach the job', () => {
    const parsed = parseAiJobFrame({ ...good, futureField: 'ignored' } as never);
    expect(parsed).toEqual(good);
    expect(parsed).not.toHaveProperty('futureField');
  });

  it('rejects a frame missing or mistyping any required turn field', () => {
    expect(parseAiJobFrame({ ...good, model: '' })).toBeNull();
    expect(parseAiJobFrame({ ...good, effort: '' })).toBeNull();
    expect(parseAiJobFrame({ ...good, effort: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, system: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, prompt: '' })).toBeNull();
    expect(parseAiJobFrame({ ...good, prompt: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, sessionId: '' })).toBeNull();
    expect(parseAiJobFrame({ ...good, sessionId: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, resume: 'true' })).toBeNull();
    expect(parseAiJobFrame({ ...good, resume: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, mcpUrl: 'not-a-url' })).toBeNull();
    expect(parseAiJobFrame({ ...good, mcpUrl: 'ftp://example.test/mcp' })).toBeNull();
    expect(parseAiJobFrame({ ...good, mcpUrl: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, mcpSecret: '' })).toBeNull();
    expect(parseAiJobFrame({ ...good, allowedTools: undefined })).toBeNull();
    expect(parseAiJobFrame({ ...good, disallowedTools: 42 })).toBeNull();
    expect(parseAiJobFrame({ ...good, timeoutSecs: 0 })).toBeNull();
    expect(parseAiJobFrame({ ...good, timeoutSecs: '1800' })).toBeNull();
  });
});

describe('buildTurnArgs', () => {
  it('fresh turn: run_once-mirroring argv with --session-id, separate system prompt, inline MCP config', () => {
    const args = buildTurnArgs(baseTurn);
    expect(args.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-5');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(baseTurn.system);
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--session-id') + 1]).toBe('sess-123');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--no-session-persistence'); // sessions are the whole point of turns
    expect(args).not.toContain(baseTurn.prompt); // prompt rides stdin, never argv

    // The MCP config is inline JSON pointing the CLI back at the cloud with
    // the per-turn bearer — exactly the local run_once shape.
    const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(mcpConfig).toEqual({
      mcpServers: {
        meridian: {
          type: 'http',
          url: 'https://meridian.auditware.io/api/assistant/mcp',
          headers: { Authorization: 'Bearer per-turn-secret' },
        },
      },
    });
  });

  it('resume turn: --resume <id> instead of --session-id', () => {
    const args = buildTurnArgs({ ...baseTurn, resume: true });
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-123');
    expect(args).not.toContain('--session-id');
  });

  it('tool strings pass verbatim as opaque argv values; empty string omits the flag', () => {
    const args = buildTurnArgs(baseTurn);
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(baseTurn.allowedTools);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(baseTurn.disallowedTools);

    const bare = buildTurnArgs({ ...baseTurn, allowedTools: '', disallowedTools: '' });
    expect(bare).not.toContain('--allowedTools');
    expect(bare).not.toContain('--disallowedTools');
  });
});

describe('slimTurnStreamLine', () => {
  it('forwards system, assistant (full tool_use input), and result lines verbatim', () => {
    expect(slimTurnStreamLine(JSON.stringify(SYSTEM_LINE))).toEqual(SYSTEM_LINE);
    expect(slimTurnStreamLine(JSON.stringify(ASSISTANT_LINE))).toEqual(ASSISTANT_LINE);
    expect(slimTurnStreamLine(JSON.stringify(RESULT_LINE))).toEqual(RESULT_LINE);
  });

  it('forwards only content_block_delta/text_delta stream_events; every other subtype drops', () => {
    expect(slimTurnStreamLine(JSON.stringify(TEXT_DELTA_LINE))).toEqual(TEXT_DELTA_LINE);
    const dropped = [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'message_start', message: {} } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'stream_event' }, // no event at all
    ];
    for (const line of dropped) expect(slimTurnStreamLine(JSON.stringify(line))).toBeUndefined();
  });

  it('user lines: drops base64/image parts, truncates text parts to 4000 chars, keeps tool_use_id/is_error', () => {
    const longText = 'artifact:doc-7\n' + 'y'.repeat(10_000);
    const line = {
      type: 'user',
      session_id: 'sess-123',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            is_error: false,
            cache_control: { type: 'ephemeral' }, // extra block field — dropped
            content: [
              { type: 'text', text: longText },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(3_000_000) } },
            ],
          },
        ],
      },
    };
    const slim = slimTurnStreamLine(JSON.stringify(line)) as Record<string, unknown>;
    expect(slim['type']).toBe('user');
    expect(slim['session_id']).toBe('sess-123'); // top-level fields ride through
    const message = slim['message'] as { role: string; content: Array<Record<string, unknown>> };
    expect(message.role).toBe('user');
    expect(message.content).toHaveLength(1);
    const block = message.content[0]!;
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      is_error: false,
      content: [{ type: 'text', text: longText.slice(0, TURN_TOOL_RESULT_TEXT_CAP) }],
    });
    // The whole slimmed line is small — the multi-MB base64 never survives.
    expect(JSON.stringify(slim).length).toBeLessThan(TURN_TOOL_RESULT_TEXT_CAP + 500);
    // The consumers' needs survive: first line intact for extract_artifact_ref.
    expect((block['content'] as Array<{ text: string }>)[0]!.text.startsWith('artifact:doc-7\n')).toBe(true);
  });

  it('user lines: string tool_result content is truncated; error results keep is_error:true', () => {
    const line = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'z'.repeat(9_000) }],
      },
    };
    const slim = slimTurnStreamLine(JSON.stringify(line)) as {
      message: { content: Array<{ tool_use_id: string; is_error: boolean; content: string }> };
    };
    const block = slim.message.content[0]!;
    expect(block.tool_use_id).toBe('tu_2');
    expect(block.is_error).toBe(true);
    expect(block.content).toBe('z'.repeat(TURN_TOOL_RESULT_TEXT_CAP));
  });

  it('user lines: non-tool_result blocks — text kept truncated, images dropped', () => {
    const line = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'w'.repeat(5_000) },
          { type: 'image', source: { type: 'base64', data: 'B'.repeat(1_000_000) } },
        ],
      },
    };
    const slim = slimTurnStreamLine(JSON.stringify(line)) as { message: { content: Array<Record<string, unknown>> } };
    expect(slim.message.content).toEqual([{ type: 'text', text: 'w'.repeat(TURN_TOOL_RESULT_TEXT_CAP) }]);
  });

  it('drops non-JSON lines, JSON scalars/arrays, and unknown line types', () => {
    expect(slimTurnStreamLine('not json at all')).toBeUndefined();
    expect(slimTurnStreamLine('"just a string"')).toBeUndefined();
    expect(slimTurnStreamLine('[1,2,3]')).toBeUndefined();
    expect(slimTurnStreamLine(JSON.stringify({ type: 'some_future_type', data: 1 }))).toBeUndefined();
    expect(slimTurnStreamLine(JSON.stringify({ noType: true }))).toBeUndefined();
    expect(slimTurnStreamLine('')).toBeUndefined();
  });
});

describe('executeTurnJob', () => {
  it('streams slimmed deltas in order and settles ok with the result envelope verbatim', async () => {
    const children = collectChildren();
    const deltas: unknown[] = [];
    const promise = executeTurnJob(baseTurn, (event) => deltas.push(event), { bin: 'claude-fake' });
    await flush();
    expect(children).toHaveLength(1);
    const child = children[0]!;

    const droppedThinking = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } },
    };
    const userLine = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [
              { type: 'text', text: 'ok' },
              { type: 'image', source: { type: 'base64', data: 'C'.repeat(100_000) } },
            ],
          },
        ],
      },
    };
    emitLines(child, [SYSTEM_LINE, TEXT_DELTA_LINE, droppedThinking, ASSISTANT_LINE, userLine, RESULT_LINE]);
    child.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({ jobId: 't1', ok: true, status: 200, body: RESULT_LINE });
    expect(deltas).toEqual([
      SYSTEM_LINE,
      TEXT_DELTA_LINE,
      ASSISTANT_LINE,
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'ok' }] }] },
      },
      RESULT_LINE, // the final delta carries the same object job_result returns
    ]);

    // Spawn contract: turn argv, prompt over stdin, detached group leader.
    expect(child.written).toBe('hello there');
    const [bin, args, spawnOpts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(bin).toBe('claude-fake');
    expect(args).toEqual(buildTurnArgs(baseTurn));
    expect(spawnOpts['detached']).toBe(true);
  });

  it('spawn env: ENV_STRIP removed, MCP timeout vars set (await_approvals parks on humans)', async () => {
    const children = collectChildren();
    const env = { PATH: '/bin', KEEP_ME: 'y' } as NodeJS.ProcessEnv;
    for (const key of ENV_STRIP) env[key] = 'leaked';
    const promise = executeTurnJob(baseTurn, noopDelta, { bin: 'claude-fake', env });
    await flush();
    emitLines(children[0]!, [RESULT_LINE]);
    children[0]!.emit('close', 0);
    await promise;

    const spawnEnv = (spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
    for (const key of ENV_STRIP) expect(spawnEnv).not.toHaveProperty(key);
    expect(spawnEnv['MCP_TOOL_TIMEOUT']).toBe(TURN_MCP_TOOL_TIMEOUT_MS);
    expect(spawnEnv['MCP_TIMEOUT']).toBe(TURN_MCP_TIMEOUT_MS);
    expect(spawnEnv['PATH']).toBe('/bin');
    expect(spawnEnv['KEEP_ME']).toBe('y');
  });

  it('reassembles lines split across stdout chunks and flushes an unterminated final line', async () => {
    const children = collectChildren();
    const deltas: unknown[] = [];
    const promise = executeTurnJob(baseTurn, (event) => deltas.push(event), { bin: 'claude-fake' });
    await flush();
    const child = children[0]!;

    const systemRaw = JSON.stringify(SYSTEM_LINE);
    child.stdout.emit('data', Buffer.from(systemRaw.slice(0, 10)));
    child.stdout.emit('data', Buffer.from(`${systemRaw.slice(10)}\n`));
    // Final result line arrives with NO trailing newline — the pre-result
    // flush must still forward it (and it must still become the ok body).
    child.stdout.emit('data', Buffer.from(JSON.stringify(RESULT_LINE)));
    child.emit('close', 0);

    const result = await promise;
    expect(deltas).toEqual([SYSTEM_LINE, RESULT_LINE]);
    expect(result).toEqual({ jobId: 't1', ok: true, status: 200, body: RESULT_LINE });
  });

  it('a throwing delta callback never kills the turn — job_result is still the terminal truth', async () => {
    const children = collectChildren();
    const promise = executeTurnJob(
      baseTurn,
      () => {
        throw new Error('ws send failed');
      },
      { bin: 'claude-fake' },
    );
    await flush();
    emitLines(children[0]!, [SYSTEM_LINE, RESULT_LINE]);
    children[0]!.emit('close', 0);
    await expect(promise).resolves.toEqual({ jobId: 't1', ok: true, status: 200, body: RESULT_LINE });
  });

  it('cli_error: exit 0 without any streamed result envelope', async () => {
    const children = collectChildren();
    const promise = executeTurnJob(baseTurn, noopDelta, { bin: 'claude-fake' });
    await flush();
    emitLines(children[0]!, [SYSTEM_LINE]);
    children[0]!.emit('close', 0);
    const result = (await promise) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('cli_error');
    expect(result.error).toContain('no result envelope');
  });

  it('cli_error: exit 0 with an is_error result envelope surfaces its result text', async () => {
    const children = collectChildren();
    const promise = executeTurnJob(baseTurn, noopDelta, { bin: 'claude-fake' });
    await flush();
    emitLines(children[0]!, [{ type: 'result', is_error: true, result: 'Overloaded' }]);
    children[0]!.emit('close', 0);
    const result = (await promise) as Extract<AiJobResult, { ok: false }>;
    expect(result.body).toEqual({ error: 'Overloaded', errorKind: 'cli_error' });
  });

  it('not_logged_in: detected from the streamed logged-out envelope on the nonzero-exit path', async () => {
    const children = collectChildren();
    // resume:true on purpose: the envelope line WAS forwarded, so this must
    // classify by phrase as not_logged_in, never as resume_failed.
    const promise = executeTurnJob({ ...baseTurn, resume: true }, noopDelta, { bin: 'claude-fake' });
    await flush();
    emitLines(children[0]!, [LOGGED_OUT_RESULT_LINE]);
    children[0]!.emit('close', 1);
    const result = (await promise) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('not_logged_in');
    expect(result.error).toMatch(/claude \/login/);
  });

  it('resume_failed: resume:true + nonzero exit + ZERO forwarded lines (session file gone)', async () => {
    const children = collectChildren();
    const promise = executeTurnJob({ ...baseTurn, resume: true }, noopDelta, { bin: 'claude-fake' });
    await flush();
    children[0]!.stderr.emit('data', Buffer.from('No conversation found with session ID sess-123'));
    children[0]!.emit('close', 1);
    const result = (await promise) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('resume_failed');
    expect(result.error).toContain('sess-123');
    expect(result.body.error).toBe(result.error);
  });

  it('resume_failed does NOT fire once any stream line was forwarded', async () => {
    const children = collectChildren();
    const promise = executeTurnJob({ ...baseTurn, resume: true }, noopDelta, { bin: 'claude-fake' });
    await flush();
    emitLines(children[0]!, [SYSTEM_LINE]); // the session resumed fine, the turn died later
    children[0]!.emit('close', 1);
    const result = (await promise) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('cli_error');
  });

  it('resume_failed does NOT fire for a fresh (resume:false) turn', async () => {
    const children = collectChildren();
    const promise = executeTurnJob(baseTurn, noopDelta, { bin: 'claude-fake' });
    await flush();
    children[0]!.emit('close', 1);
    const result = (await promise) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('cli_error');
  });

  it('resume_failed does NOT fire on a spawn error (never exited) — stays cli_error', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn claude-fake ENOENT')));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const result = (await executeTurnJob({ ...baseTurn, resume: true }, noopDelta, { bin: 'claude-fake' })) as Extract<
      AiJobResult,
      { ok: false }
    >;
    expect(result.body.errorKind).toBe('cli_error');
    expect(result.error).toContain('ENOENT');
  });

  it('timeout: kills the child process group after the budget and reports errorKind timeout', async () => {
    const children = collectChildren();
    const kills = spyGroupKills(children);
    const result = (await executeTurnJob({ ...baseTurn, timeoutSecs: 0.01 }, noopDelta, {
      bin: 'claude-fake',
      killMarginSecs: 0,
    })) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('timeout');
    expect(kills).toEqual([-children[0]!.pid]); // negative pid = whole process group
  });

  it('budget counts from acceptance: a turn starved past timeoutSecs in the pool never spawns', async () => {
    const t0 = 1_700_000_000_000;
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(t0)
      .mockReturnValueOnce(t0 + (baseTurn.timeoutSecs + 1) * 1000);
    const result = (await executeTurnJob(baseTurn, noopDelta, { bin: 'claude-fake' })) as Extract<
      AiJobResult,
      { ok: false }
    >;
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result.body.errorKind).toBe('timeout');
    expect(result.error).toContain('turn slot');
    expect(activeTurnJobCount()).toBe(0);
  });

  it('cancelTurnJob kills the in-flight turn group and the turn settles as cancelled', async () => {
    const children = collectChildren();
    const kills = spyGroupKills(children);
    const promise = executeTurnJob(baseTurn, noopDelta, { bin: 'claude-fake' });
    await flush();

    expect(cancelTurnJob('t1')).toBe(true);
    const result = (await promise) as Extract<AiJobResult, { ok: false }>;
    expect(result.body).toEqual({ error: 'turn cancelled by job_cancel', errorKind: 'cancelled' });
    expect(result.error).toBe('turn cancelled by job_cancel');
    expect(kills).toEqual([-children[0]!.pid]);
    expect(activeTurnJobCount()).toBe(0);
  });

  it('cancelTurnJob on an unknown jobId is a silent no-op returning false', () => {
    expect(cancelTurnJob('never-heard-of-it')).toBe(false);
  });

  it('cancelling a still-QUEUED turn settles it as cancelled without ever spawning', async () => {
    const children = collectChildren();
    const blockers = [
      executeTurnJob({ ...baseTurn, jobId: 'b1' }, noopDelta, { bin: 'x' }),
      executeTurnJob({ ...baseTurn, jobId: 'b2' }, noopDelta, { bin: 'x' }),
    ];
    const queued = executeTurnJob({ ...baseTurn, jobId: 'queued' }, noopDelta, { bin: 'x' });
    await flush();
    expect(children).toHaveLength(MAX_CONCURRENT_TURNS); // queued is waiting, not spawned

    expect(cancelTurnJob('queued')).toBe(true);
    const result = (await queued) as Extract<AiJobResult, { ok: false }>;
    expect(result.body.errorKind).toBe('cancelled');
    expect(children).toHaveLength(MAX_CONCURRENT_TURNS); // never spawned

    for (const child of children) {
      emitLines(child, [RESULT_LINE]);
      child.emit('close', 0);
    }
    await Promise.all(blockers);
    expect(activeTurnJobCount()).toBe(0);
  });

  it('abortAllTurnJobs (socket close) kills every in-flight turn with the given reason', async () => {
    const children = collectChildren();
    const kills = spyGroupKills(children);
    const turns = [
      executeTurnJob({ ...baseTurn, jobId: 'x1' }, noopDelta, { bin: 'x' }),
      executeTurnJob({ ...baseTurn, jobId: 'x2' }, noopDelta, { bin: 'x' }),
    ];
    await flush();

    abortAllTurnJobs('cloud connection closed mid-turn — CLI killed');
    const results = (await Promise.all(turns)) as Array<Extract<AiJobResult, { ok: false }>>;
    for (const result of results) {
      expect(result.body.errorKind).toBe('cancelled');
      expect(result.error).toContain('connection closed');
    }
    expect(kills.sort()).toEqual(children.map((c) => -c.pid).sort());
    expect(activeTurnJobCount()).toBe(0);
  });

  it('turn pool is SEPARATE from the phase-1 ai gate — a parked turn starves neither direction', async () => {
    const children = collectChildren();
    const OK_ENVELOPE = { type: 'result', is_error: false, result: 'ok', total_cost_usd: 0 };

    // Two turns fill the TURN pool and park (humans deciding approvals).
    const turns = [
      executeTurnJob({ ...baseTurn, jobId: 'p1' }, noopDelta, { bin: 'x' }),
      executeTurnJob({ ...baseTurn, jobId: 'p2' }, noopDelta, { bin: 'x' }),
    ];
    await flush();
    expect(children).toHaveLength(2);
    expect(activeTurnJobCount()).toBe(2);
    expect(activeAiJobCount()).toBe(0); // turns never touch the ai gate

    // A phase-1 json/chat job spawns immediately despite both turn slots parked.
    const aiPromise = executeAiJob({ jobId: 'a1', mode: 'chat', model: 'm1', prompt: 'p', timeoutSecs: 60 }, { bin: 'x' });
    await flush();
    expect(children).toHaveLength(3);
    children[2]!.stdout.emit('data', Buffer.from(JSON.stringify(OK_ENVELOPE)));
    children[2]!.emit('close', 0);
    await expect(aiPromise).resolves.toMatchObject({ ok: true });

    // A THIRD turn queues behind MAX_CONCURRENT_TURNS (it does not steal ai slots).
    const third = executeTurnJob({ ...baseTurn, jobId: 'p3' }, noopDelta, { bin: 'x' });
    await flush();
    expect(children).toHaveLength(3); // still only the two turn children + the ai child

    // Freeing one turn slot starts the queued turn (FIFO within the pool).
    emitLines(children[0]!, [RESULT_LINE]);
    children[0]!.emit('close', 0);
    await flush();
    expect(children).toHaveLength(4);

    for (const child of [children[1]!, children[3]!]) {
      emitLines(child, [RESULT_LINE]);
      child.emit('close', 0);
    }
    const settled = await Promise.all([...turns, third]);
    expect(settled.map((r) => r.ok)).toEqual([true, true, true]);
    expect(activeTurnJobCount()).toBe(0);
    expect(activeAiJobCount()).toBe(0);
  });
});
