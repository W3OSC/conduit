import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Key, Copy, X, Settings, Zap, Bot, Download, Terminal, Loader2,
} from 'lucide-react';
import {
  api, type AiRunnerStatus,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { CopyButton } from '@/components/shared/CopyButton';
import { StepNumber } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// AI Connection Tab
// ─────────────────────────────────────────────────────────────────────────────

function CodeBlock({ children, className }: { children: string; className?: string }) {
  return (
    <div className="relative group">
      <pre className={cn(
        'text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80',
        className,
      )}>
        {children}
      </pre>
      <CopyButton
        text={children}
        title="Copy"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </div>
  );
}

// ─── Skill Install Panel ──────────────────────────────────────────────────────
// The skill file is served by this server at /api/skill, so the installed
// skill always matches the running server version.

function SkillInstallPanel() {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://your-server:3101';
  const skillUrl = `${baseUrl}/api/skill`;
  const prompt = `Please install the Conduit skill: fetch ${skillUrl} and save it as a skill/instructions file for this agent (e.g. conduit/SKILL.md in your skills directory), creating the directory if it doesn't exist.`;

  // Fetch the skill from this server so the copyable content always matches
  // the running server version (for agents that cannot fetch URLs themselves).
  const { data: skillMd } = useQuery({
    queryKey: ['skill-md'],
    queryFn: api.skill,
    staleTime: 60_000,
  });

  return (
    <div className="rounded-xl border border-border bg-secondary/30 overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center gap-1.5">
        <Download className="w-3 h-3 text-muted-foreground" />
        <p className="text-xs font-semibold text-foreground">Install as Skill</p>
        <p className="text-[10px] text-muted-foreground ml-auto">Paste this prompt into your agent</p>
      </div>
      <div className="p-3 space-y-2.5">
        {/* Copyable prompt */}
        <div className="relative group">
          <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 pr-8 overflow-x-auto text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
            {prompt}
          </pre>
          <CopyButton
            text={prompt}
            title="Copy prompt"
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
          />
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>Served from this Conduit server — always matches the running version</span>
          <span>·</span>
          <a
            href="/api/skill"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            view SKILL.md
          </a>
          {skillMd && (
            <>
              <span>·</span>
              <CopyButton
                text={skillMd}
                title="Copy SKILL.md contents"
                className="h-5 px-1 py-0"
                iconClassName="w-3 h-3"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── AI Runner Panel ──────────────────────────────────────────────────────────
// The reverse direction of this tab: a connected orchestrator (Settings →
// Cloud bridge) can route its AI work HERE, running it on this machine's
// Claude Code CLI. Resolution is env-first (ai-config.ts); this panel edits
// the stored settings and goes read-only per field when env-managed.

function dotClass(ok: boolean): string {
  return ok ? 'bg-emerald-500' : 'bg-muted-foreground/40';
}

function authLabel(s: AiRunnerStatus): string {
  if (s.tokenSet) return s.tokenSource === 'env' ? 'Setup token (from environment)' : 'Setup token (stored)';
  return 'This machine’s own claude login';
}

function AiRunnerPanel() {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: s } = useQuery({
    queryKey: ['ai-runner'],
    queryFn: api.aiRunnerStatus,
    refetchInterval: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ai-runner'] });

  const configure = useMutation({
    mutationFn: api.aiRunnerConfigure,
    onSuccess: () => {
      setTokenInput('');
      setTestResult(null);
      refresh();
    },
  });

  const test = useMutation({
    mutationFn: api.aiRunnerTest,
    onMutate: () => setTestResult(null),
    onSuccess: (r) => {
      setTestResult(
        r.ok
          ? { ok: true, text: 'Working — a real AI call completed through this runner.' }
          : { ok: false, text: r.error ?? r.errorKind ?? 'Test failed' },
      );
      refresh();
    },
    onError: (e) => setTestResult({ ok: false, text: e instanceof Error ? e.message : 'Test failed' }),
  });

  if (!s) return null;

  const tokenEnvManaged = s.tokenSource === 'env';

  return (
    <div className="rounded-xl border border-border bg-secondary/30 overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center gap-1.5">
        <Terminal className="w-3 h-3 text-muted-foreground" />
        <p className="text-xs font-semibold text-foreground">Serve AI to a connected orchestrator</p>
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => configure.mutate({ enabled: e.target.checked })}
            className="accent-primary"
          />
          Enabled
        </label>
      </div>
      <div className="p-3 space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          When a remote orchestrator is connected via the cloud bridge, it can run its AI work through
          this machine&rsquo;s Claude Code CLI. By default the runner rides this machine&rsquo;s own{' '}
          <code className="font-mono text-[11px]">claude /login</code> session; headless installs
          (e.g. the Docker container) paste a setup token instead.
        </p>

        {/* Status facts */}
        <div className="rounded-lg border border-border bg-background p-2.5 space-y-1 text-xs">
          <p className="flex items-center gap-2 text-muted-foreground">
            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass(s.cliAvailable))} />
            CLI{' '}
            {s.cliAvailable ? (
              <span className="text-foreground/80">
                found <span className="font-mono text-[11px]">{s.cliVersion}</span>
              </span>
            ) : (
              <span>
                not found (<span className="font-mono text-[11px]">{s.bin}</span>)
              </span>
            )}
            {s.binSource !== 'default' && (
              <span className="text-[10px] text-muted-foreground/70">path via {s.binSource}</span>
            )}
          </p>
          <p className="flex items-center gap-2 text-muted-foreground">
            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass(s.tokenSet || s.cliAvailable))} />
            Auth <span className="text-foreground/80">{authLabel(s)}</span>
          </p>
        </div>

        {/* Token */}
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-foreground">
            Setup token{' '}
            <span className="font-normal text-muted-foreground">
              (from <code className="font-mono text-[11px]">claude setup-token</code> on a logged-in machine)
            </span>
          </p>
          {tokenEnvManaged ? (
            <p className="text-[11px] text-muted-foreground">
              Managed by the <code className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code> environment variable.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={s.tokenSet ? 'Token stored — paste to replace' : 'sk-ant-oat01-…'}
                className="flex-1 text-xs font-mono bg-background border border-border rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-primary/50"
              />
              <button
                onClick={() => configure.mutate({ token: tokenInput.trim() })}
                disabled={!tokenInput.trim() || configure.isPending}
                className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-40 cursor-pointer"
              >
                Save
              </button>
              {s.tokenSet && (
                <button
                  onClick={() => configure.mutate({ token: '' })}
                  disabled={configure.isPending}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Remove the stored token and fall back to this machine's claude login"
                >
                  Remove
                </button>
              )}
            </div>
          )}
          {configure.isError && (
            <p className="text-[11px] text-red-400">
              {configure.error instanceof Error ? configure.error.message : 'Save failed'}
            </p>
          )}
        </div>

        {/* Test */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => test.mutate()}
            disabled={test.isPending || !s.enabled}
            className="text-xs px-3 py-1.5 rounded-lg border border-border font-semibold text-foreground hover:bg-secondary disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
          >
            {test.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
            {test.isPending ? 'Running a real AI call…' : 'Test'}
          </button>
          {testResult && (
            <p className={cn('text-[11px] leading-snug', testResult.ok ? 'text-emerald-500' : 'text-red-400')}>
              {testResult.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Agent Access Tab ─────────────────────────────────────────────────────────
// Provider-agnostic: external AI agents connect to Conduit over the REST API
// with an API key — no in-app chat, no vendor-specific wiring.

export function AgentAccessTab() {
  const navigate = useNavigate();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
          <Bot className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">Connect your agent</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Any AI agent can use Conduit through its REST API — no vendor-specific integration required.
          </p>
        </div>
      </div>

      {/* How it works */}
      <div className="rounded-xl border border-border bg-secondary/30 overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center gap-1.5">
          <Zap className="w-3 h-3 text-muted-foreground" />
          <p className="text-xs font-semibold text-foreground">How it works</p>
        </div>
        <div className="p-3 space-y-3">
          <div className="flex items-start gap-3">
            <StepNumber n={1} />
            <p className="text-xs text-foreground/80 leading-relaxed pt-1">
              Create an API key in{' '}
              <button onClick={() => navigate('/settings/permissions')} className="text-primary hover:underline font-semibold cursor-pointer">
                Settings → Permissions
              </button>{' '}
              and give it to your agent. Key permissions control what the agent can access.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <StepNumber n={2} />
            <p className="text-xs text-foreground/80 leading-relaxed pt-1">
              Install the skill below so your agent knows the API surface and conventions.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <StepNumber n={3} />
            <p className="text-xs text-foreground/80 leading-relaxed pt-1">
              The agent calls the REST API with an{' '}
              <code className="font-mono text-primary/70 text-[11px]">X-API-Key</code> header. All writes queue in the{' '}
              <button onClick={() => navigate('/outbox')} className="text-primary hover:underline font-semibold cursor-pointer">
                Outbox
              </button>{' '}
              for your approval.
            </p>
          </div>
        </div>
      </div>

      {/* Skill install */}
      <SkillInstallPanel />

      {/* AI runner (outbound: serve AI to a connected orchestrator) */}
      <AiRunnerPanel />
    </div>
  );
}
