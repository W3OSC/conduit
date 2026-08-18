import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Key, Copy, X, Settings, Zap, Bot, Download,
} from 'lucide-react';
import {
  api,
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
    </div>
  );
}
