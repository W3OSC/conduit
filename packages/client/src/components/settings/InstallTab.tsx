import { useQuery } from '@tanstack/react-query';
import {
  Key, Copy, X, Zap,
} from 'lucide-react';
import {
  api,
} from '@/lib/api';
import { CopyButton } from '@/components/shared/CopyButton';

// ── Install tab ───────────────────────────────────────────────────────────────

export function InstallTab() {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://your-server:3101';

  const { data: skillMd, isLoading: skillLoading } = useQuery({
    queryKey: ['skill-md'],
    queryFn: api.skill,
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Conduit as a Skill</h3>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
          Conduit exposes a full REST API that AI agents can use to read messages, manage email and calendar,
          edit files, send outbox requests, look up contacts, and more. Generate an API key in the Permissions tab,
          then install the skill definition into your AI agent.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { name: 'CLI agents', icon: '⌨️', step: 'Install the skill file below — the agent reads it and calls the API with your key' },
          { name: 'Any OpenAPI agent', icon: '⚡', step: 'Point to the spec URL and set X-API-Key in headers' },
          { name: 'Custom scripts', icon: '🔧', step: 'Call the REST API from any language with an X-API-Key header' },
        ].map(({ name, icon, step }) => (
          <div key={name} className="rounded-xl border border-border bg-secondary/20 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-base">{icon}</span>
              <p className="text-sm font-semibold">{name}</p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{step}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">Skill Definition (SKILL.md)</p>
          {skillMd && (
            <CopyButton
              text={skillMd}
              title="Copy SKILL.md"
              className="h-6 px-2 text-[10px]"
            />
          )}
        </div>
        {skillLoading ? (
          <div className="rounded-xl border border-border bg-secondary/40 px-4 py-8 text-center text-xs text-muted-foreground animate-pulse">
            Loading skill definition…
          </div>
        ) : skillMd ? (
          <pre className="text-xs bg-secondary/40 border border-border rounded-xl px-4 py-3 text-foreground/75 leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
            {skillMd}
          </pre>
        ) : (
          <div className="rounded-xl border border-border bg-secondary/40 px-4 py-4 text-xs text-muted-foreground">
            Could not load skill definition.
          </div>
        )}
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex items-start gap-3">
        <Zap className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-xs text-muted-foreground leading-relaxed">
          <span className="text-foreground font-medium">API endpoint:</span>{' '}
          <code className="font-mono text-primary/80">{baseUrl}/api</code>
          {' '}— all REST endpoints are documented at{' '}
          <code className="font-mono text-primary/80">{baseUrl}/api/openapi.json</code>
        </div>
      </div>
    </div>
  );
}
