import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, RefreshCw, Loader2, CheckCircle2, XCircle, AlertTriangle, Database, Key, Copy,
  Check, X, Shield, Settings, PlugZap, UserCircle2, Clock,
} from 'lucide-react';
import {
  api,
} from '@/lib/api';
import { useConnectionStore, useSyncStore } from '@/store';
import { StatusBadge } from '@/components/shared/StatusDot';
import { cn, timeAgo } from '@/lib/utils';
import { toast } from '@/store';
import { SectionHeader, SectionTabs } from './shared';
import { PermissionsSection, type Service, type TestStep } from './ChatServiceAccordions';

type TwitterSectionId = 'overview' | 'credentials' | 'permissions' | 'sync' | 'data';
const TWITTER_SECTIONS: Array<{ id: TwitterSectionId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview',     label: 'Overview',    icon: PlugZap  },
  { id: 'credentials', label: 'Credentials', icon: Key      },
  { id: 'permissions', label: 'Permissions', icon: Shield   },
  { id: 'sync',        label: 'Sync',        icon: Clock    },
  { id: 'data',        label: 'Data',        icon: Database },
];

export function TwitterAccordion({ standalone = false }: { standalone?: boolean }) {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<TwitterSectionId>('overview');
  const qc = useQueryClient();

  const { data: authStatus } = useQuery({ queryKey: ['twitter-auth-status'], queryFn: api.twitterAuthStatus, refetchInterval: 30000 });
  const connStatus = useConnectionStore((s) => s.statuses['twitter' as Service]);
  const syncProgress = useSyncStore((s) => s.progress['twitter']);
  const isRunning = syncProgress?.status === 'running';

  const status = connStatus?.status ?? (authStatus?.connected ? 'connected' : 'disconnected');

  // Until cookie credentials are saved, Credentials is the only usable section.
  const needsCredentials = authStatus ? !authStatus.configured : false;
  useEffect(() => {
    if (needsCredentials) setActiveSection('credentials');
  }, [needsCredentials]);

  // Credentials state
  const [cookieString, setCookieString] = useState('');
  const [credsDirty, setCredsDirty] = useState(false);
  useEffect(() => { setCredsDirty(!!cookieString.trim()); }, [cookieString]);

  // Test state
  const [testSteps, setTestSteps] = useState<TestStep[]>([]);
  const [testRunning, setTestRunning] = useState(false);

  const runTest = useCallback(async () => {
    setTestRunning(true);
    setTestSteps([]);
    try {
      const res = await fetch('/api/test/twitter');
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6)) as TestStep & { done?: boolean };
            if (d.done) break;
            setTestSteps((prev) => {
              const idx = prev.findIndex((s) => s.step === d.step);
              if (idx >= 0) { const next = [...prev]; next[idx] = d; return next; }
              return [...prev, d];
            });
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    setTestRunning(false);
  }, []);

  // React to async connection result arriving via WebSocket
  const prevConnStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevConnStatus.current;
    const cur = connStatus?.status;
    if (prev === cur) return;
    prevConnStatus.current = cur;
    if (prev === 'connecting' && cur === 'connected') {
      const handle = connStatus?.displayName || '';
      toast({ title: `Connected${handle ? ` as ${handle}` : ''}`, variant: 'success' });
      qc.invalidateQueries({ queryKey: ['twitter-auth-status'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      setTimeout(runTest, 800);
    } else if (prev === 'connecting' && cur === 'error') {
      toast({ title: 'Twitter connection failed', description: connStatus?.error || 'Check your credentials', variant: 'destructive' });
    }
  }, [connStatus, qc, runTest]);

  const connect = useMutation({
    mutationFn: () => api.twitterConnect(cookieString),
    onSuccess: () => {
      // Connection is async — status arrives via WebSocket / polling.
      toast({ title: 'Connecting to Twitter…', description: 'Verifying cookie session…' });
      setCookieString('');
      qc.invalidateQueries({ queryKey: ['twitter-auth-status'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (e: Error) => toast({ title: 'Failed to start connection', description: e.message, variant: 'destructive' }),
  });

  const disconnect = useMutation({
    mutationFn: () => api.twitterDisconnect(),
    onSuccess: () => {
      toast({ title: 'Twitter disconnected' });
      qc.invalidateQueries({ queryKey: ['twitter-auth-status'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      setTestSteps([]);
    },
  });

  const syncNow = useMutation({
    mutationFn: () => api.triggerSync('twitter'),
    onSuccess: () => toast({ title: 'Twitter DM sync started', variant: 'default' }),
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const cancelSync = useMutation({
    mutationFn: () => api.cancelSync('twitter'),
    onSuccess: () => {
      toast({ title: 'Twitter sync cancelled' });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
  });

  const resetService = useMutation({
    mutationFn: () => api.resetService('twitter'),
    onSuccess: () => {
      toast({ title: 'Twitter reset — resync started', variant: 'default' });
      qc.invalidateQueries({ queryKey: ['status'] });
      setConfirmReset(false);
    },
    onError: (e: Error) => { toast({ title: 'Reset failed', description: e.message, variant: 'destructive' }); setConfirmReset(false); },
  });

  const [confirmReset, setConfirmReset] = useState(false);

  const { data: statusData } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: isRunning ? 2000 : 15000 });
  const msgCount  = statusData?.messageCounts['twitter'] ?? 0;
  const chatCount = statusData?.chatCounts['twitter'] ?? 0;
  const lastSyncRun = statusData?.lastSync['twitter'] as { startedAt?: string; messagesSaved?: number } | null;

  const allPassed = testSteps.length > 0 && testSteps.every((s) => s.status === 'success');
  const anyFailed = testSteps.some((s) => s.status === 'error');

  return (
    <motion.div layout={!standalone} className={cn(
      'rounded-2xl border overflow-hidden transition-all duration-200',
      standalone ? 'card-warm' : open ? 'border-border shadow-warm-md' : 'border-border/60 hover:border-border',
    )}>
      {/* Header — hidden in standalone mode (the settings shell renders the pane header) */}
      {!standalone && (
      <button onClick={() => setOpen(!open)} className={cn('w-full flex items-center gap-3 px-4 py-3 text-left transition-colors', open ? 'bg-card' : 'bg-card/50 hover:bg-card/80')}>
        <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center flex-shrink-0 font-bold text-sky-400">𝕏</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-base font-semibold">Twitter / X</h2>
            <StatusBadge status={status as 'connected'|'disconnected'|'connecting'|'error'} />
            {authStatus?.handle && <span className="text-xs text-muted-foreground">@{authStatus.handle}</span>}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <span>{msgCount.toLocaleString()} DMs</span>
            {isRunning && (
              <span className="text-primary flex items-center gap-1">
                <RefreshCw className="w-3 h-3 animate-spin" />
                {syncProgress?.type === 'full' ? 'Full sync' : 'Syncing'}
              </span>
            )}
            {!isRunning && testSteps.length > 0 && !open && (
              testSteps.every((s) => s.status === 'success')
                ? <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Tests passed</span>
                : testSteps.some((s) => s.status === 'error')
                  ? <span className="text-red-400 flex items-center gap-1"><XCircle className="w-3 h-3" />Test failed</span>
                  : null
            )}
          </div>
        </div>
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center border transition-all', open ? 'bg-secondary border-border' : 'bg-secondary/50 border-border/50')}>
          <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} />
        </div>
      </button>
      )}

      {/* Body */}
      <AnimatePresence initial={false}>
        {(standalone || open) && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className={cn('bg-card', !standalone && 'border-t border-border')}>
              {/* Section nav */}
              <SectionTabs
                sections={TWITTER_SECTIONS}
                active={activeSection}
                onSelect={setActiveSection}
                disabledIds={needsCredentials ? TWITTER_SECTIONS.filter((s) => s.id !== 'credentials').map((s) => s.id) : undefined}
                disabledTitle="Save credentials first"
              />

              {/* Section content */}
              <div className="p-4">
                <AnimatePresence mode="wait">
                  <motion.div key={activeSection} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>

                    {/* ── Overview ──────────────────────────────────────────── */}
                    {activeSection === 'overview' && (
                      <div className="space-y-5">
                        <SectionHeader icon={PlugZap} title="Overview" subtitle="Enable to activate DM polling and sync — no developer account required" />

                        {/* Status card */}
                        <div className={cn(
                          'rounded-xl border p-4',
                          status === 'connected' && allPassed  ? 'border-emerald-500/20 bg-emerald-500/5' :
                          status === 'connected' && anyFailed  ? 'border-primary/20  bg-primary/5' :
                          status === 'connected'               ? 'border-emerald-500/20 bg-emerald-500/5' :
                          status === 'error'                   ? 'border-red-500/20    bg-red-500/5' :
                          status === 'connecting'              ? 'border-primary/20  bg-primary/5' :
                                                                 'border-border        bg-secondary/30',
                        )}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <StatusBadge status={status as 'connected'|'disconnected'|'connecting'|'error'} />
                                <span className="chip chip-zinc text-[10px]">cookie</span>
                              </div>
                              {authStatus?.handle && (
                                <div className="flex items-center gap-1.5 mt-1.5">
                                  <UserCircle2 className="w-3.5 h-3.5 text-muted-foreground" />
                                  <p className="text-xs text-muted-foreground">@{authStatus.handle}</p>
                                </div>
                              )}
                              {connStatus?.error && (
                                <p className="text-xs text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{connStatus.error}</p>
                              )}
                            </div>
                            {(status === 'connected' || status === 'error') && (
                              <button onClick={runTest} disabled={testRunning} className="btn-ghost text-xs flex-shrink-0 gap-1.5 text-muted-foreground hover:text-foreground">
                                <RefreshCw className={cn('w-3.5 h-3.5', testRunning && 'animate-spin')} />
                                {testRunning ? 'Testing…' : 'Re-run Test'}
                              </button>
                            )}
                          </div>
                          {testSteps.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-border/40 space-y-1">
                              {testSteps.map((step) => (
                                <motion.div key={step.step} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2.5">
                                  <div className="flex-shrink-0 w-4">
                                    {step.status === 'running' && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />}
                                    {step.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                                    {step.status === 'error'   && <XCircle className="w-3.5 h-3.5 text-red-400" />}
                                  </div>
                                  <span className={cn('text-xs flex-1', step.status === 'error' ? 'text-foreground/80' : 'text-muted-foreground')}>{step.name}</span>
                                  {step.detail && (
                                    <span className={cn('text-[11px] truncate max-w-[200px] text-right', step.status === 'error' ? 'text-red-400' : 'text-muted-foreground/60')}>
                                      {step.detail}
                                    </span>
                                  )}
                                </motion.div>
                              ))}
                            </div>
                          )}
                          {(status === 'connected' || status === 'error') && testSteps.length === 0 && !testRunning && (
                            <p className="text-[11px] text-muted-foreground/40 mt-3 pt-3 border-t border-border/30">
                              No test run — click <span className="text-muted-foreground/60">Re-run Test</span> to verify credentials
                            </p>
                          )}
                        </div>

                        {/* Stats */}
                        <div className="grid grid-cols-3 gap-3">
                          <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">DMs</p>
                            <p className="text-sm font-semibold">{msgCount.toLocaleString()}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Conversations</p>
                            <p className="text-sm font-semibold">{chatCount.toLocaleString()}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Last Sync</p>
                            <p className="text-sm font-semibold">{lastSyncRun?.startedAt ? timeAgo(lastSyncRun.startedAt) : 'Never'}</p>
                          </div>
                        </div>

                        {/* Sync progress */}
                        {isRunning && (
                          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-2.5">
                            <div className="flex items-center gap-2.5">
                              <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0" />
                              <p className="text-xs font-semibold text-primary flex-1">
                                {syncProgress?.type === 'full' ? 'Full sync' : 'Sync'} in progress
                              </p>
                            </div>
                            {(syncProgress?.messagesSaved ?? 0) > 0 && (
                              <p className="text-xs text-primary/80 pl-6">
                                <span className="font-semibold text-primary">+{syncProgress!.messagesSaved!.toLocaleString()}</span> DMs saved
                              </p>
                            )}
                            <div className="h-0.5 bg-muted-foreground/25 rounded-full overflow-hidden ml-6">
                              <motion.div className="h-full bg-primary rounded-full" animate={{ x: ['-100%', '100%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }} />
                            </div>
                            <div className="flex justify-end">
                              <button onClick={() => cancelSync.mutate()} disabled={cancelSync.isPending} className="btn-ghost text-xs text-primary/70 hover:text-primary gap-1.5">
                                <XCircle className="w-3.5 h-3.5" />
                                {cancelSync.isPending ? 'Cancelling…' : 'Cancel Sync'}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {status !== 'connected' ? (
                            <button onClick={() => setActiveSection('credentials')} className="btn-primary text-xs">
                              <PlugZap className="w-3.5 h-3.5" />
                              Connect (paste cookies)
                            </button>
                          ) : (
                            <button onClick={() => disconnect.mutate()} disabled={disconnect.isPending} className="btn-secondary text-xs">
                              {disconnect.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                              Disconnect
                            </button>
                          )}
                          <button onClick={() => syncNow.mutate()} disabled={syncNow.isPending || status !== 'connected'} className="btn-secondary text-xs">
                            <RefreshCw className={cn('w-3.5 h-3.5', syncNow.isPending && 'animate-spin')} />
                            Sync Now
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Credentials ───────────────────────────────────────── */}
                    {activeSection === 'credentials' && (
                      <div className="space-y-5">
                        <SectionHeader icon={Key} title="Cookie Authentication" subtitle="Paste your browser session cookies — works with 2FA, no password needed" />

                        {/* How-to instructions */}
                        <div className="rounded-xl border border-border bg-secondary/30 p-4 space-y-2.5 text-xs text-muted-foreground">
                          <p className="font-semibold text-foreground text-[11px] uppercase tracking-wider">How to get your cookies</p>
                          <ol className="space-y-1.5 list-decimal list-inside">
                            <li>Open <span className="font-mono text-foreground/80">x.com</span> (or <span className="font-mono text-foreground/80">twitter.com</span>) and make sure you are logged in</li>
                            <li>Open DevTools: <span className="chip chip-zinc text-[10px]">F12</span> or right-click → Inspect</li>
                            <li>Go to the <span className="font-semibold text-foreground/80">Network</span> tab, then reload the page</li>
                            <li>Click any request to <span className="font-mono text-foreground/80">x.com</span> or <span className="font-mono text-foreground/80">twitter.com</span></li>
                            <li>In <span className="font-semibold text-foreground/80">Request Headers</span>, find the <span className="font-mono text-foreground/80">cookie:</span> header</li>
                            <li>Right-click → Copy value, then paste below</li>
                          </ol>
                          <p className="text-[11px] text-muted-foreground/60 pt-1 border-t border-border/40">
                            The value looks like: <span className="font-mono text-foreground/50">auth_token=abc123; ct0=xyz...; ...</span>
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <label className="block text-xs font-medium text-muted-foreground">Cookie Header Value</label>
                          <textarea
                            value={cookieString}
                            onChange={(e) => setCookieString(e.target.value)}
                            placeholder="auth_token=…; ct0=…; twid=…"
                            rows={4}
                            className="input-warm font-mono text-xs resize-none w-full"
                            spellCheck={false}
                            autoComplete="off"
                          />
                          <p className="text-[11px] text-muted-foreground/50">
                            Your cookies are stored locally and never sent anywhere except Twitter's API.
                          </p>
                        </div>

                        {authStatus?.handle && (
                          <p className="text-xs text-emerald-400 flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Currently connected as @{authStatus.handle}
                          </p>
                        )}
                        <button
                          onClick={() => connect.mutate()}
                          disabled={!cookieString.trim() || connect.isPending}
                          className="btn-primary text-xs"
                        >
                          {connect.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                          {connect.isPending ? 'Connecting…' : credsDirty ? 'Connect' : 'Reconnect'}
                        </button>
                      </div>
                    )}

                    {/* ── Permissions ───────────────────────────────────────── */}
                    {activeSection === 'permissions' && <PermissionsSection service={'twitter' as Service} />}

                    {/* ── Sync ──────────────────────────────────────────────── */}
                    {activeSection === 'sync' && (
                      <div className="space-y-5">
                        <SectionHeader icon={Clock} title="Sync Settings" subtitle="Twitter DMs are polled every 2 minutes via cookie-based session" />
                        <div className="rounded-xl border border-border bg-secondary/30 p-4 space-y-2">
                          <div className="flex items-center gap-2">
                            <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="text-sm font-medium">DM polling interval</span>
                            <span className="chip chip-zinc text-[10px]">2 minutes</span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Twitter does not offer a public WebSocket or push API — polling is the live listener. The session cookie is refreshed automatically when it expires.
                          </p>
                        </div>
                        <button onClick={() => syncNow.mutate()} disabled={syncNow.isPending || status !== 'connected'} className="btn-primary text-xs">
                          {syncNow.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                          Sync Now
                        </button>
                      </div>
                    )}

                    {/* ── Data ──────────────────────────────────────────────── */}
                    {activeSection === 'data' && (
                      <div className="space-y-5">
                        <SectionHeader icon={Database} title="Data" subtitle="Manage locally stored Twitter DMs" />
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-xl border border-border bg-secondary/30 p-4">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">DMs Stored</p>
                            <p className="text-xl font-semibold">{msgCount.toLocaleString()}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-secondary/30 p-4">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">Conversations</p>
                            <p className="text-xl font-semibold">{chatCount.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="rounded-xl border border-red-500/15 bg-red-500/5 p-4 space-y-3">
                          <div>
                            <p className="text-sm font-semibold text-red-400">Reset &amp; Resync</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Wipes all locally stored DMs and sync history. Credentials and session are preserved. A full resync starts automatically.
                            </p>
                          </div>
                          {confirmReset ? (
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-primary font-medium flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                This will delete all Twitter DMs. Continue?
                              </span>
                              <button onClick={() => setConfirmReset(false)} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
                              <button onClick={() => resetService.mutate()} disabled={resetService.isPending} className="btn-danger text-xs py-1.5 px-3">
                                {resetService.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                Confirm Reset
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => setConfirmReset(true)} className="btn-danger text-xs">
                              <Database className="w-3.5 h-3.5" /> Reset &amp; Resync
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
