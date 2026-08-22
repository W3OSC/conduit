import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, RefreshCw, Loader2, CheckCircle2, XCircle, AlertTriangle, Database, Key, Plus, Copy,
  Trash2, X, Shield, Settings, PlugZap, Clock, FileText, Search,
} from 'lucide-react';
import {
  api,
} from '@/lib/api';
import { useSyncStore } from '@/store';
import { StatusBadge } from '@/components/shared/StatusDot';
import { cn, timeAgo } from '@/lib/utils';
import { toast } from '@/store';
import { SectionHeader, SectionTabs, SecretField, CopyableScope } from './shared';
import { PermissionsSection, type Service, type TestStep } from './ChatServiceAccordions';

// ─────────────────────────────────────────────────────────────────────────────
// Gmail / Calendar / Twitter simple accordions
// ─────────────────────────────────────────────────────────────────────────────

// ─── Add Google Account form (shared) ────────────────────────────────────────

function AddGoogleAccountForm({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: () => void }) {
  const qc = useQueryClient();
  const [fields, setFields] = useState({ clientId: '', clientSecret: '', accessToken: '', refreshToken: '' });
  const set = (k: string) => (v: string) => setFields((f) => ({ ...f, [k]: v }));

  const addAccount = useMutation({
    mutationFn: () => api.addGoogleAccount(fields),
    onSuccess: (d) => {
      toast({ title: `Added ${d.email}`, description: `${d.accountCount} account(s) connected`, variant: 'success' });
      setFields({ clientId: '', clientSecret: '', accessToken: '', refreshToken: '' });
      qc.invalidateQueries({ queryKey: ['google-status'] });
      qc.invalidateQueries({ queryKey: ['gmail-account-statuses'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      onSuccess();
    },
    onError: (e: Error) => toast({ title: 'Failed to add account', description: e.message, variant: 'destructive' }),
  });

  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="space-y-3 rounded-xl border border-border bg-secondary/20 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Add Google Account</p>
        <button onClick={onCancel} className="btn-ghost p-1"><X className="w-4 h-4" /></button>
      </div>
      <div className="text-xs text-muted-foreground rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 space-y-2.5">
        <p className="font-semibold text-foreground/80">1. Create a Google Cloud project</p>
        <p>
          Go to{' '}
          <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">console.cloud.google.com</a>
          {' '}→ click the project dropdown at the top → <strong className="text-foreground/80">New Project</strong>           → give it any name (e.g. <code className="bg-secondary/80 px-1 rounded">Conduit</code>) → click <strong className="text-foreground/80">Create</strong>. Make sure the new project is selected in the dropdown before continuing.
        </p>
        <p className="font-semibold text-foreground/80">2. Enable APIs</p>
        <p>
          Enable the{' '}
          <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">Gmail API</a>
          {', '}
          <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">Calendar API</a>
          {', '}
          <a href="https://console.cloud.google.com/apis/library/meet.googleapis.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">Google Meet API</a>
          {', and '}
          <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">Google Drive API</a>
          {' '}— click each link and press <strong className="text-foreground/80">Enable</strong>.
        </p>
        <p className="font-semibold text-foreground/80">3. Configure the OAuth consent screen</p>
        <p>
          Go to{' '}
          <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer" className="text-primary hover:underline">Auth → Overview</a>
          {' '}→ click <strong className="text-foreground/80">Get started</strong> → fill in any <strong className="text-foreground/80">App name</strong> and your email for the support address → choose <strong className="text-foreground/80">External</strong> as the audience → click through and <strong className="text-foreground/80">Save</strong> on each screen until done.
        </p>
        <p className="font-semibold text-foreground/80">4. Create OAuth credentials</p>
        <p>
          Go to{' '}
          <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer" className="text-primary hover:underline">Auth → Clients</a>
          {' '}→ <strong className="text-foreground/80">+ Create client</strong> → type <strong className="text-foreground/80">Web application</strong> → give it any name → under <strong className="text-foreground/80">Authorized redirect URIs</strong> click <strong className="text-foreground/80">+ Add URI</strong> and enter <code className="bg-secondary/80 px-1 rounded">https://developers.google.com/oauthplayground</code> → click <strong className="text-foreground/80">Create</strong>. Copy the <strong className="text-foreground/80">Client ID</strong> and <strong className="text-foreground/80">Client Secret</strong> from the dialog.
        </p>
        <p className="font-semibold text-foreground/80">5. Generate tokens via OAuth Playground</p>
        <p>
          Open the{' '}
          <a href="https://developers.google.com/oauthplayground/" target="_blank" rel="noreferrer" className="text-primary hover:underline">OAuth 2.0 Playground</a>
          {' '}→ click the <strong className="text-foreground/80">⚙ gear</strong> (top-right) → check <strong className="text-foreground/80">"Use your own OAuth credentials"</strong> → paste your Client ID and Client Secret → close the panel.
          In the <strong className="text-foreground/80">Input your own scopes</strong> box at the top of the scope list, paste the following and click <strong className="text-foreground/80">Authorize APIs</strong>:
        </p>
        <CopyableScope scope="https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.readonly" />
        <p>
          Sign in with your Google account → click <strong className="text-foreground/80">Allow</strong> → then click <strong className="text-foreground/80">Exchange authorization code for tokens</strong>. Copy the <strong className="text-foreground/80">Access token</strong> and <strong className="text-foreground/80">Refresh token</strong> and paste them below. The last two scopes enable Gemini meeting notes — remove them if you don't need that feature.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <SecretField label="Client ID" value={fields.clientId} onChange={set('clientId')} placeholder="*.apps.googleusercontent.com" />
        <SecretField label="Client Secret" value={fields.clientSecret} onChange={set('clientSecret')} placeholder="GOCSPX-..." />
        <SecretField label="Access Token" value={fields.accessToken} onChange={set('accessToken')} placeholder="ya29...." />
        <SecretField label="Refresh Token" value={fields.refreshToken} onChange={set('refreshToken')} placeholder="1//0..." />
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="btn-secondary text-xs flex-1">Cancel</button>
        <button
          onClick={() => addAccount.mutate()}
          disabled={!fields.accessToken || !fields.refreshToken || !fields.clientId || addAccount.isPending}
          className="btn-primary text-xs flex-1"
        >
          {addAccount.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Add Account
        </button>
      </div>
    </motion.div>
  );
}

// ─── Per-account Gmail accordion ──────────────────────────────────────────────

type GmailSectionId = 'overview' | 'credentials' | 'permissions' | 'sync' | 'data';
const GMAIL_SECTIONS: Array<{ id: GmailSectionId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview',     label: 'Overview',    icon: PlugZap  },
  { id: 'credentials', label: 'Credentials', icon: Key      },
  { id: 'permissions', label: 'Permissions', icon: Shield   },
  { id: 'sync',        label: 'Sync',        icon: Clock    },
  { id: 'data',        label: 'Data',        icon: Database },
];

function GmailAccountAccordion({
  email,
  tokenValid,
  connStatus,
  onRemove,
}: {
  email: string;
  tokenValid: boolean;
  connStatus: { gmail: { status: string; error?: string }; calendar: { status: string; error?: string } } | null;
  onRemove: (email: string) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<GmailSectionId>('overview');
  const syncProgress = useSyncStore((s) => s.progress['gmail']);
  const isRunning = syncProgress?.status === 'running';

  const gmailStatus = connStatus?.gmail.status ?? 'disconnected';
  const calStatus   = connStatus?.calendar.status ?? 'disconnected';
  const isConnected = gmailStatus === 'connected' || calStatus === 'connected';
  const hasError    = gmailStatus === 'error' || calStatus === 'error';
  const chipCls     = isConnected ? 'chip-emerald' : hasError ? 'chip-red' : 'chip-zinc';
  const chipLabel   = isConnected ? 'Connected' : hasError ? 'Error' : 'Disconnected';

  // Test state
  const [testSteps, setTestSteps] = useState<TestStep[]>([]);
  const [testRunning, setTestRunning] = useState(false);

  const runTest = useCallback(async () => {
    setTestRunning(true);
    setTestSteps([]);
    try {
      const res = await fetch('/api/test/gmail');
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

  const connectMutation = useMutation({
    mutationFn: () => api.connectGmailAccount(email),
    onSuccess: () => {
      toast({ title: `Connecting ${email}…`, variant: 'default' });
      qc.invalidateQueries({ queryKey: ['gmail-account-statuses'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      setTimeout(runTest, 1000);
    },
    onError: (e: Error) => toast({ title: 'Connect failed', description: e.message, variant: 'destructive' }),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.disconnectGmailAccount(email),
    onSuccess: () => {
      toast({ title: `Disconnected ${email}` });
      qc.invalidateQueries({ queryKey: ['gmail-account-statuses'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      setTestSteps([]);
    },
    onError: (e: Error) => toast({ title: 'Disconnect failed', description: e.message, variant: 'destructive' }),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncGmailAccount(email),
    onSuccess: () => toast({ title: `Sync started for ${email}`, variant: 'default' }),
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const cancelSyncMutation = useMutation({
    mutationFn: () => api.cancelSync('gmail'),
    onSuccess: () => {
      toast({ title: 'Gmail sync cancelled', variant: 'default' });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.resetGmailAccount(email),
    onSuccess: () => {
      toast({ title: `${email} reset — full resync started`, variant: 'default' });
      qc.invalidateQueries({ queryKey: ['status'] });
      qc.invalidateQueries({ queryKey: ['gmail-account-statuses'] });
    },
    onError: (e: Error) => toast({ title: 'Reset failed', description: e.message, variant: 'destructive' }),
  });

  const [confirmReset, setConfirmReset] = useState(false);

  const { data: statusData } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: isRunning ? 2000 : 15000 });
  const msgCount  = statusData?.messageCounts['gmail'] ?? 0;
  const chatCount = statusData?.chatCounts['gmail'] ?? 0;
  const lastSyncRun = statusData?.lastSync['gmail'] as { startedAt?: string; messagesSaved?: number } | null;

  const allPassed = testSteps.length > 0 && testSteps.every((s) => s.status === 'success');
  const anyFailed = testSteps.some((s) => s.status === 'error');

  return (
    <motion.div layout className="rounded-xl border border-border overflow-hidden">
      {/* Account header */}
      <button
        onClick={() => setOpen(!open)}
        className={cn('w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors', open ? 'bg-card' : 'bg-card/50 hover:bg-card/80')}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{email}</p>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
            <span className={cn('flex items-center gap-1', gmailStatus === 'connected' ? 'text-emerald-400' : gmailStatus === 'error' ? 'text-red-400' : '')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', gmailStatus === 'connected' ? 'bg-emerald-400' : gmailStatus === 'error' ? 'bg-red-400' : 'bg-muted-foreground/40')} />
              Gmail
            </span>
            <span className={cn('flex items-center gap-1', calStatus === 'connected' ? 'text-emerald-400' : calStatus === 'error' ? 'text-red-400' : '')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', calStatus === 'connected' ? 'bg-emerald-400' : calStatus === 'error' ? 'bg-red-400' : 'bg-muted-foreground/40')} />
              Calendar
            </span>
            {!tokenValid && <span className="text-primary">Token expired</span>}
            {isRunning && (
              <span className="text-primary flex items-center gap-1">
                <RefreshCw className="w-3 h-3 animate-spin" />
                {syncProgress?.type === 'full' ? 'Full sync' : 'Syncing'}
              </span>
            )}
          </div>
        </div>
        <div className={cn('chip flex-shrink-0', chipCls)}>{chipLabel}</div>
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform duration-200 flex-shrink-0', open && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className="border-t border-border bg-card">
              {/* Section nav */}
              <SectionTabs sections={GMAIL_SECTIONS} active={activeSection} onSelect={setActiveSection} />

              {/* Section content */}
              <div className="p-4">
                <AnimatePresence mode="wait">
                  <motion.div key={activeSection} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>

                    {/* ── Overview ──────────────────────────────────────────── */}
                    {activeSection === 'overview' && (
                      <div className="space-y-5">
                        <SectionHeader icon={PlugZap} title="Overview" subtitle="Connect this Google account to start syncing Gmail and Calendar" />

                        {/* Status card */}
                        <div className={cn(
                          'rounded-xl border p-4',
                          isConnected && allPassed  ? 'border-emerald-500/20 bg-emerald-500/5' :
                          isConnected && anyFailed  ? 'border-primary/20  bg-primary/5' :
                          isConnected               ? 'border-emerald-500/20 bg-emerald-500/5' :
                          hasError                  ? 'border-red-500/20    bg-red-500/5' :
                                                      'border-border        bg-secondary/30',
                        )}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <StatusBadge status={(isConnected ? 'connected' : hasError ? 'error' : 'disconnected') as 'connected'|'disconnected'|'connecting'|'error'} />
                              </div>
                              {connStatus?.gmail.error && (
                                <p className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{connStatus.gmail.error}</p>
                              )}
                              {connStatus?.calendar.error && (
                                <p className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{connStatus.calendar.error}</p>
                              )}
                            </div>
                            {(isConnected || hasError) && (
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
                          {(isConnected || hasError) && testSteps.length === 0 && !testRunning && (
                            <p className="text-[11px] text-muted-foreground/40 mt-3 pt-3 border-t border-border/30">
                              No test run — click <span className="text-muted-foreground/60">Re-run Test</span> to verify credentials
                            </p>
                          )}
                        </div>

                        {/* Stats */}
                        <div className="grid grid-cols-3 gap-3">
                          <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Emails</p>
                            <p className="text-sm font-semibold">{msgCount.toLocaleString()}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Threads</p>
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
                                <span className="font-semibold text-primary">+{syncProgress!.messagesSaved!.toLocaleString()}</span> messages saved
                              </p>
                            )}
                            <div className="h-0.5 bg-muted-foreground/25 rounded-full overflow-hidden ml-6">
                              <motion.div className="h-full bg-primary rounded-full" animate={{ x: ['-100%', '100%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }} />
                            </div>
                            <div className="flex justify-end">
                              <button onClick={() => cancelSyncMutation.mutate()} disabled={cancelSyncMutation.isPending} className="btn-ghost text-xs text-primary/70 hover:text-primary gap-1.5">
                                <XCircle className="w-3.5 h-3.5" />
                                {cancelSyncMutation.isPending ? 'Cancelling…' : 'Cancel Sync'}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {!isConnected ? (
                            <button onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending} className="btn-primary text-xs">
                              {connectMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                              Connect
                            </button>
                          ) : (
                            <button onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending} className="btn-secondary text-xs">
                              {disconnectMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                              Disconnect
                            </button>
                          )}
                          <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending || !isConnected} className="btn-secondary text-xs">
                            <RefreshCw className={cn('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
                            Sync Now
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Credentials ───────────────────────────────────────── */}
                    {activeSection === 'credentials' && (
                      <div className="space-y-5">
                        <SectionHeader icon={Key} title="Credentials" subtitle="OAuth tokens for this Google account" />
                        <div className="rounded-xl border border-primary/15 bg-primary/5 px-3.5 py-3 text-xs text-muted-foreground">
                          Credentials are managed at the account level. To update tokens for <span className="text-foreground font-medium">{email}</span>, remove this account and re-add it with fresh tokens.
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <button
                            onClick={() => onRemove(email)}
                            className="btn-danger text-xs gap-1.5"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Remove Account
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Permissions ───────────────────────────────────────── */}
                    {activeSection === 'permissions' && <PermissionsSection service={'gmail' as Service} />}

                    {/* ── Sync ──────────────────────────────────────────────── */}
                    {activeSection === 'sync' && (
                      <div className="space-y-5">
                        <SectionHeader icon={Clock} title="Sync Settings" subtitle="Gmail and Calendar are polled every 2 minutes for new changes" />
                        <div className="rounded-xl border border-border bg-secondary/30 p-4 space-y-2">
                          <div className="flex items-center gap-2">
                            <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="text-sm font-medium">Polling interval</span>
                            <span className="chip chip-zinc text-[10px]">2 minutes</span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Gmail uses the History API and Calendar uses sync tokens to detect changes efficiently. Unlike Slack/Discord/Telegram, no persistent WebSocket is available — polling is the listener.
                          </p>
                        </div>
                        <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending || !isConnected} className="btn-primary text-xs">
                          {syncMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                          Sync Now
                        </button>
                      </div>
                    )}

                    {/* ── Data ──────────────────────────────────────────────── */}
                    {activeSection === 'data' && (
                      <div className="space-y-5">
                        <SectionHeader icon={Database} title="Data" subtitle={`Locally stored data for ${email}`} />
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-xl border border-border bg-secondary/30 p-4">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">Emails Stored</p>
                            <p className="text-xl font-semibold">{msgCount.toLocaleString()}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-secondary/30 p-4">
                            <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">Threads</p>
                            <p className="text-xl font-semibold">{chatCount.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="rounded-xl border border-red-500/15 bg-red-500/5 p-4 space-y-3">
                          <div>
                            <p className="text-sm font-semibold text-red-400">Reset &amp; Resync</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Wipes all locally stored emails, calendar events, historyId, sync tokens, and sync history for {email}. Credentials are preserved. A full resync starts automatically.
                            </p>
                          </div>
                          {confirmReset ? (
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-primary font-medium flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                This will delete all data for {email}. Continue?
                              </span>
                              <button onClick={() => setConfirmReset(false)} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
                              <button onClick={() => { resetMutation.mutate(); setConfirmReset(false); }} disabled={resetMutation.isPending} className="btn-danger text-xs py-1.5 px-3">
                                {resetMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
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

// ─── Google Services outer accordion ─────────────────────────────────────────

export function GoogleServicesAccordion({ standalone = false }: { standalone?: boolean }) {
  const [addingAccount, setAddingAccount] = useState(false);
  const qc = useQueryClient();

  const { data: googleStatus } = useQuery({
    queryKey: ['google-status'],
    queryFn: api.googleStatus,
    refetchInterval: 30000,
  });
  const { data: connectionStatuses } = useQuery({
    queryKey: ['gmail-account-statuses'],
    queryFn: api.gmailAccountStatuses,
    refetchInterval: 15000,
  });

  // Meet Notes
  const { data: meetNotesSettings } = useQuery({
    queryKey: ['meet-notes-settings'],
    queryFn: api.meetNotesSettings,
    staleTime: 60_000,
  });
  const { data: meetNotesData } = useQuery({
    queryKey: ['meet-notes-count'],
    queryFn: () => api.meetNotes({ limit: 1 }),
    staleTime: 60_000,
  });
  const updateMeetNotesSettings = useMutation({
    mutationFn: (s: { driveSearchEnabled: boolean }) => api.meetNotesUpdateSettings(s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meet-notes-settings'] }),
    onError: (e: Error) => toast({ title: 'Failed to save settings', description: e.message, variant: 'destructive' }),
  });
  const syncMeetNotes = useMutation({
    mutationFn: api.meetNotesSync,
    onSuccess: (r) => { toast({ title: 'Meeting notes synced', description: r.message, variant: 'default' }); qc.invalidateQueries({ queryKey: ['meet-notes-count'] }); },
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const removeAccount = useMutation({
    mutationFn: (email: string) => api.removeGoogleAccount(email),
    onSuccess: (_, email) => {
      toast({ title: `Removed ${email}`, variant: 'default' });
      qc.invalidateQueries({ queryKey: ['google-status'] });
      qc.invalidateQueries({ queryKey: ['gmail-account-statuses'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (e: Error) => toast({ title: 'Failed to remove account', description: e.message, variant: 'destructive' }),
  });

  const accounts = googleStatus?.accounts || [];
  const statusMap = new Map((connectionStatuses || []).map((s) => [s.email, s]));
  const connectedCount = [...statusMap.values()].filter((s) => s.gmail.status === 'connected' || s.calendar.status === 'connected').length;
  const driveEnabled = meetNotesSettings?.driveSearchEnabled ?? true;
  const totalNotes = meetNotesData?.total ?? 0;

  return (
    <motion.div layout={!standalone} className={cn('rounded-2xl border border-border overflow-hidden', standalone && 'card-warm')}>
      {/* Header — hidden in standalone mode (the settings shell renders the pane header) */}
      {!standalone && (
      <div className="w-full flex items-center gap-3 px-4 py-3 text-left bg-card">
        <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0 font-bold text-red-400">G</div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">Google</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {accounts.length === 0
              ? 'No accounts — add OAuth tokens to connect'
              : `Gmail · Calendar · Meet Notes · ${accounts.map((a) => a.email).filter(Boolean).join(', ')}`}
          </p>
        </div>
        <div className={cn('chip flex-shrink-0', connectedCount > 0 ? 'chip-emerald' : accounts.length > 0 ? 'chip-amber' : 'chip-zinc')}>
          {connectedCount > 0 ? `${connectedCount} connected` : accounts.length > 0 ? `${accounts.length} configured` : 'Not configured'}
        </div>
      </div>
      )}

      <div className={cn('bg-card p-4 space-y-3', !standalone && 'border-t border-border')}>

        {/* Add account button / form */}
        {addingAccount ? (
          <AddGoogleAccountForm onCancel={() => setAddingAccount(false)} onSuccess={() => setAddingAccount(false)} />
        ) : (
          <button onClick={() => setAddingAccount(true)} className="btn-primary text-xs w-full justify-center gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            Add Google Account
          </button>
        )}

        {/* Per-account accordions */}
        {accounts.length > 0 && (
          <div className="space-y-2">
            {accounts.map((acct) => {
              if (!acct.email) return null;
              const cs = statusMap.get(acct.email) ?? null;
              return (
                <GmailAccountAccordion
                  key={acct.email}
                  email={acct.email}
                  tokenValid={acct.tokenValid}
                  connStatus={cs}
                  onRemove={(e) => removeAccount.mutate(e)}
                />
              );
            })}
          </div>
        )}

        {/* ── Gemini Meeting Notes ── */}
        <div className="rounded-xl border border-border/60 overflow-hidden">
          {/* Sub-header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-secondary/20 border-b border-border/40">
            <FileText className="w-4 h-4 text-primary/60 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Gemini Meeting Notes</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                AI-generated smart notes from Google Meet — synced alongside Gmail &amp; Calendar
              </p>
            </div>
            <div className={cn('chip flex-shrink-0 text-[10px]', totalNotes > 0 ? 'chip-emerald' : 'chip-zinc')}>
              {totalNotes > 0 ? `${totalNotes} note${totalNotes !== 1 ? 's' : ''}` : 'No notes yet'}
            </div>
          </div>

          <div className="p-4 space-y-4">
            {/* OAuth scope notice */}
            <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-1.5 text-xs text-muted-foreground">
              <p className="font-medium text-foreground/70">Required OAuth scopes</p>
              <p>
                Your Google token must include{' '}
                <code className="bg-secondary/80 px-1 rounded">meetings.space.readonly</code>{' '}
                and{' '}
                <code className="bg-secondary/80 px-1 rounded">drive.readonly</code>.
                These are listed in the setup instructions above. If missing, remove and re-add your account — the connection test will catch it.
              </p>
            </div>

            {/* Drive search toggle */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Search Drive for shared notes</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Also finds notes from meetings others organized and shared with you. Disable to only show notes from meetings you organized.
                </p>
              </div>
              <button
                onClick={() => updateMeetNotesSettings.mutate({ driveSearchEnabled: !driveEnabled })}
                disabled={updateMeetNotesSettings.isPending}
                className={cn(
                  'flex-shrink-0 w-9 h-5 rounded-full border transition-all relative mt-0.5',
                  driveEnabled ? 'bg-primary border-primary/60' : 'bg-secondary border-border',
                )}
              >
                <span className={cn(
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
                  driveEnabled ? 'left-4' : 'left-0.5',
                )} />
              </button>
            </div>

            {/* Manual sync */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Sync now</p>
                <p className="text-xs text-muted-foreground">Fetch new notes from the last 7 days</p>
              </div>
              <button
                onClick={() => syncMeetNotes.mutate()}
                disabled={syncMeetNotes.isPending || connectedCount === 0}
                className="btn-secondary text-xs gap-1.5"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', syncMeetNotes.isPending && 'animate-spin')} />
                {syncMeetNotes.isPending ? 'Syncing…' : 'Sync Notes'}
              </button>
            </div>
          </div>
        </div>

      </div>
    </motion.div>
  );
}
