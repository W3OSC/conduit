import { useState, type ClipboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Unplug } from 'lucide-react';
import { api, type CloudAgentStatus } from '@/lib/api';
import { StatusPill } from '@/components/shared/StatusDot';

// ─────────────────────────────────────────────────────────────────────────────
// Cloud Bridge Tab — the outbound cloud-agent connection. Conduit dials OUT to
// a remote orchestrator's agent endpoint (any service speaking the agent
// protocol — a hosted Meridian CRM is the reference consumer) so that service
// can route messaging/AI work through this instance without inbound access to
// your network. Config is hot-applied; env vars (CLOUD_AGENT_*) take
// precedence and turn this card read-only.
// ─────────────────────────────────────────────────────────────────────────────

const inputCls =
  'w-full text-xs bg-secondary border border-border rounded-lg px-2.5 py-2 text-foreground ' +
  'placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/50 ' +
  'disabled:opacity-40 disabled:cursor-not-allowed font-mono';

function pillStatus(s: CloudAgentStatus): { status: 'connected' | 'connecting' | 'disconnected' | 'error'; label: string } {
  if (s.state === 'connected') return { status: 'connected', label: 'Connected' };
  if (s.state === 'connecting') return { status: s.lastError ? 'error' : 'connecting', label: s.lastError ? 'Retrying' : 'Connecting' };
  if (s.configured && !s.enabled) return { status: 'disconnected', label: 'Disabled' };
  return { status: 'disconnected', label: 'Not connected' };
}

export function CloudBridgeTab() {
  const qc = useQueryClient();
  const statusQ = useQuery({
    queryKey: ['cloud-agent'],
    queryFn: api.cloudAgentStatus,
    // Fast-poll while a connection attempt is in flight so the pill flips
    // moments after the remote accepts the hello.
    refetchInterval: (q) => (q.state.data?.state === 'connecting' ? 2000 : 10000),
  });
  const s = statusQ.data;

  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const effectiveUrl = url ?? s?.url ?? '';
  const effectiveOwner = ownerEmail ?? s?.ownerEmail ?? '';

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['cloud-agent'] });
  const connect = useMutation({
    mutationFn: () =>
      api.cloudAgentConfigure({
        url: effectiveUrl.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        ownerEmail: effectiveOwner.trim(),
        enabled: true,
      }),
    onSuccess: (next) => {
      setToken('');
      qc.setQueryData(['cloud-agent'], next);
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.cloudAgentConfigure({ url: effectiveUrl.trim(), enabled }),
    onSuccess: invalidate,
  });
  const clear = useMutation({ mutationFn: api.cloudAgentClear, onSuccess: invalidate });

  /**
   * Orchestrators can offer the whole config as one JSON blob
   * ({"url":…,"token":…,"ownerEmail":…}) — pasting it into the URL field
   * fills all three inputs in one go.
   */
  const onUrlPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').trim();
    if (!text.startsWith('{')) return;
    try {
      const blob = JSON.parse(text) as { url?: string; token?: string; ownerEmail?: string };
      if (!blob.url) return;
      e.preventDefault();
      setUrl(blob.url);
      if (blob.token) setToken(blob.token);
      if (blob.ownerEmail) setOwnerEmail(blob.ownerEmail);
    } catch {
      // Not JSON — let the paste land as plain text.
    }
  };

  const canConnect =
    /^wss?:\/\//i.test(effectiveUrl.trim()) && (token.trim().length > 0 || Boolean(s?.tokenSet));

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
          <Cloud className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Cloud bridge</h3>
            {s ? <StatusPill {...pillStatus(s)} /> : null}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
            Connect this Conduit to a remote orchestrator (for example a hosted Meridian CRM). Conduit
            dials out over one WebSocket, so the remote service can route messaging — and, when the
            Claude CLI is installed here, AI work — through this machine without any inbound access to
            your network. Mint the token on the orchestrator (Meridian: Settings → Devices).
          </p>
        </div>
      </div>

      {/* Live status facts */}
      {s && (s.configured || s.envManaged) ? (
        <div className="rounded-xl border border-border bg-secondary/40 p-3.5 space-y-1.5 text-xs">
          {s.url ? (
            <p className="text-muted-foreground">
              Endpoint <code className="font-mono text-foreground/80 break-all">{s.url}</code>
            </p>
          ) : null}
          {s.ownerEmail ? (
            <p className="text-muted-foreground">
              Owner <span className="text-foreground/80">{s.ownerEmail}</span>
            </p>
          ) : null}
          {s.capabilities?.length ? (
            <p className="text-muted-foreground">
              Advertising{' '}
              {s.capabilities.map((c) => (
                <code key={c} className="font-mono text-[11px] text-foreground/80 mr-1.5">
                  {c}
                </code>
              ))}
            </p>
          ) : null}
          {s.lastError && s.state !== 'connected' ? (
            <p className="text-red-400 break-all">Last error: {s.lastError}</p>
          ) : null}
          {s.envManaged ? (
            <p className="text-muted-foreground">
              Managed by environment variables (<code className="font-mono">CLOUD_AGENT_URL</code>/
              <code className="font-mono">CLOUD_AGENT_TOKEN</code>) — unset them to configure the
              bridge here instead.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Config form — read-only when env owns the config */}
      {!s?.envManaged ? (
        <div className="space-y-2.5">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">
              Agent endpoint URL
            </label>
            <input
              className={inputCls}
              placeholder="wss://your-crm.example.com/api/agent/ws"
              value={effectiveUrl}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={onUrlPaste}
            />
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              Tip: pasting a JSON connect blob from the orchestrator fills every field at once.
            </p>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">
              Device token
            </label>
            <input
              className={inputCls}
              type="password"
              placeholder={s?.tokenSet ? 'Token stored — paste to replace' : 'Paste the minted device token…'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">
              Owner email <span className="font-normal">(who this device acts as on the remote side)</span>
            </label>
            <input
              className={inputCls}
              type="email"
              placeholder="you@company.com"
              value={effectiveOwner}
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => connect.mutate()}
              disabled={connect.isPending || !canConnect}
              className="btn-primary text-xs"
            >
              {connect.isPending ? 'Connecting…' : s?.state === 'connected' ? 'Reconnect' : 'Connect'}
            </button>
            {s?.configured ? (
              <>
                <button
                  onClick={() => toggle.mutate(!s.enabled)}
                  disabled={toggle.isPending}
                  className="btn-secondary text-xs"
                >
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Forget the bridge config (including the stored token) and disconnect?')) {
                      clear.mutate();
                    }
                  }}
                  disabled={clear.isPending}
                  className="btn-ghost text-xs text-muted-foreground hover:text-red-400 gap-1.5"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  Forget
                </button>
              </>
            ) : null}
          </div>
          {connect.isError ? (
            <p className="text-xs text-red-400 break-all">
              {connect.error instanceof Error ? connect.error.message : 'Connect failed'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
