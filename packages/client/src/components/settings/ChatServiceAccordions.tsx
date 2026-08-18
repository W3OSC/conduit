import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, Eye, EyeOff, RefreshCw, Loader2, CheckCircle2, XCircle, AlertTriangle, Database,
  Key, Copy, Check, Send, Server, Shield, Settings, PlugZap, UserCircle2, Clock, Users,
  ExternalLink,
} from 'lucide-react';
import {
  api, type DiscordGuildInfo, type Permission, type ContactCriteria,
} from '@/lib/api';
import { useConnectionStore, useSyncStore } from '@/store';
import { ServiceIcon, SERVICE_CONFIG } from '@/components/shared/ServiceBadge';
import { StatusBadge } from '@/components/shared/StatusDot';
import { cn, timeAgo } from '@/lib/utils';
import { CopyButton } from '@/components/shared/CopyButton';
import { toast } from '@/store';
import { SectionHeader, SecretField, TextField, Toggle } from './shared';

export type Service = 'slack' | 'discord' | 'telegram';
export const SERVICES: Service[] = ['slack', 'discord', 'telegram'];

const SLACK_MANIFEST = JSON.stringify({
  display_information: {
    name: 'Conduit',
    description: 'Personal communications hub',
    background_color: '#000000',
  },
  oauth_config: {
    scopes: {
      user: [
        'channels:history', 'channels:read', 'channels:write',
        'groups:history',   'groups:read',   'groups:write',
        'im:history',       'im:read',       'im:write',
        'mpim:history',     'mpim:read',     'mpim:write',
        'chat:write',       'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: {
      user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim'],
    },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}, null, 2);

export interface TestStep {
  step: number;
  name: string;
  status: 'running' | 'success' | 'error';
  detail?: string;
}

interface OverviewSectionProps {
  service: Service;
  testSteps: TestStep[];
  testRunning: boolean;
  runTest: () => void;
  clearTestSteps: () => void;
}

function OverviewSection({ service, testSteps, testRunning, runTest, clearTestSteps }: OverviewSectionProps) {
  const qc = useQueryClient();
  const connStatus   = useConnectionStore((s) => s.statuses[service]);
  const syncProgress = useSyncStore((s) => s.progress[service]);
  const status = connStatus?.status ?? 'disconnected';

  const isRunning = syncProgress?.status === 'running';

  // Use the page-level status query (shared cache key) — no duplicate fetching
  const { data: statusData } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: isRunning ? 2000 : 15000,
  });

  const msgCount      = statusData?.messageCounts[service] ?? 0;
  const chatCount     = statusData?.chatCounts[service] ?? 0;
  const lastSyncRun   = statusData?.lastSync[service] as { startedAt?: string; messagesSaved?: number; status?: string } | null;
  const lastSync      = lastSyncRun?.startedAt;
  const lastSyncSaved = lastSyncRun?.messagesSaved;

  // Use live counts from DB during a sync, otherwise use stored last-run values
  const liveSaved   = isRunning ? (syncProgress?.messagesSaved ?? 0) : undefined;
  const liveChats   = isRunning ? (syncProgress?.chatsVisited ?? 0) : undefined;

  const connectMutation = useMutation({
    mutationFn: () => api.connect(service),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      // Auto-run test immediately after connect — no manual trigger needed
      setTimeout(runTest, 800); // small delay to let connection:status propagate
    },
    onError: (e: Error) => toast({ title: 'Connect failed', description: e.message, variant: 'destructive' }),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.disconnect(service),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); clearTestSteps(); },
  });

  const syncMutation = useMutation({
    mutationFn: () => api.triggerSync(service),
    onSuccess: () => toast({ title: `${service} sync started`, variant: 'default' }),
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const cancelSyncMutation = useMutation({
    mutationFn: () => api.cancelSync(service),
    onSuccess: () => {
      toast({ title: `${service} sync cancelled`, variant: 'default' });
      // Immediately refresh so the progress bar disappears without waiting for the next poll
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (e: Error) => toast({ title: 'Cancel failed', description: e.message, variant: 'destructive' }),
  });

  const allPassed = testSteps.length > 0 && testSteps.every((s) => s.status === 'success');
  const anyFailed = testSteps.some((s) => s.status === 'error');

  return (
    <div className="space-y-5">
      <SectionHeader icon={PlugZap} title="Overview" subtitle="Enable to activate the live listener and sync" />

      {/* Status card — test results live here */}
      <div className={cn(
        'rounded-xl border p-4',
        status === 'connected' && allPassed  ? 'border-emerald-500/20 bg-emerald-500/5' :
        status === 'connected' && anyFailed  ? 'border-primary/20  bg-primary/5' :
        status === 'connected'               ? 'border-emerald-500/20 bg-emerald-500/5' :
        status === 'error'                   ? 'border-red-500/20    bg-red-500/5' :
        status === 'connecting'              ? 'border-primary/20  bg-primary/5' :
                                               'border-border        bg-secondary/30',
      )}>
        {/* Header row: status badge + re-run button */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={status as 'connected'|'disconnected'|'connecting'|'error'} />
              {connStatus?.mode && <span className="chip chip-zinc text-[10px]">{connStatus.mode}</span>}
            </div>
            {connStatus?.displayName && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <UserCircle2 className="w-3.5 h-3.5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">{connStatus.displayName}</p>
                {connStatus.accountId && (
                  <span className="text-[10px] text-muted-foreground/50 font-mono">({connStatus.accountId})</span>
                )}
              </div>
            )}
            {connStatus?.error && (
              <p className="text-xs text-red-400 mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />{connStatus.error}
              </p>
            )}
          </div>

          {/* Re-run test button — only when connected or errored */}
          {(status === 'connected' || status === 'error') && (
            <button
              onClick={runTest}
              disabled={testRunning}
              className="btn-ghost text-xs flex-shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
              title="Re-run connection test"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', testRunning && 'animate-spin')} />
              {testRunning ? 'Testing…' : 'Re-run Test'}
            </button>
          )}
        </div>

        {/* Test steps — always visible, no expand/collapse */}
        {testSteps.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/40 space-y-1">
            {testSteps.map((step) => (
              <motion.div
                key={step.step}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2.5"
              >
                <div className="flex-shrink-0 w-4">
                  {step.status === 'running' && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />}
                  {step.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                  {step.status === 'error'   && <XCircle className="w-3.5 h-3.5 text-red-400" />}
                </div>
                <span className={cn(
                  'text-xs flex-1',
                  step.status === 'error' ? 'text-foreground/80' : 'text-muted-foreground',
                )}>
                  {step.name}
                </span>
                {step.detail && (
                  <span className={cn(
                    'text-[11px] truncate max-w-[200px] text-right',
                    step.status === 'error' ? 'text-red-400' : 'text-muted-foreground/60',
                  )}>
                    {step.detail}
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {/* Empty state — connected but no test run yet */}
        {(status === 'connected' || status === 'error') && testSteps.length === 0 && !testRunning && (
          <p className="text-[11px] text-muted-foreground/40 mt-3 pt-3 border-t border-border/30">
            No test run — click <span className="text-muted-foreground/60">Re-run Test</span> to verify credentials
          </p>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Messages</p>
          <p className="text-sm font-semibold text-foreground">{msgCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Chats</p>
          <p className="text-sm font-semibold text-foreground">{chatCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/30 p-3.5 text-center">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Last Sync</p>
          <p className="text-sm font-semibold text-foreground">{lastSync ? timeAgo(lastSync) : 'Never'}</p>
          {lastSync && lastSyncSaved != null && (
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">
              +{lastSyncSaved.toLocaleString()} added
            </p>
          )}
        </div>
      </div>

      {/* Sync progress — shown when running (survives page refresh via DB seed) */}
      {isRunning && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-primary">
                  {syncProgress?.type === 'full' ? 'Full sync' : 'Sync'} in progress
                </p>
                {syncProgress?.startedAt && (
                  <span className="text-[10px] text-primary/60">
                    {timeAgo(syncProgress.startedAt)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Live counters */}
          {(liveSaved !== undefined || liveChats !== undefined) && (
            <div className="flex items-center gap-4 text-xs text-primary/80 pl-6">
              {liveChats !== undefined && liveChats > 0 && (
                <span><span className="font-semibold text-primary">{liveChats}</span> chats visited</span>
              )}
              {liveSaved !== undefined && liveSaved > 0 && (
                <span><span className="font-semibold text-primary">+{liveSaved.toLocaleString()}</span> messages saved</span>
              )}
            </div>
          )}

          {/* Animated progress bar */}
          <div className="h-0.5 bg-warm-700/60 rounded-full overflow-hidden ml-6">
            <motion.div
              className="h-full bg-primary rounded-full"
              animate={{ x: ['-100%', '100%'] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
            />
          </div>

          {syncProgress?.error && (
            <p className="text-xs text-red-400 pl-6">{syncProgress.error}</p>
          )}

          {/* Cancel button */}
          <div className="flex justify-end">
            <button
              onClick={() => cancelSyncMutation.mutate()}
              disabled={cancelSyncMutation.isPending}
              className="btn-ghost text-xs text-primary/70 hover:text-primary gap-1.5"
            >
              <XCircle className="w-3.5 h-3.5" />
              {cancelSyncMutation.isPending ? 'Cancelling…' : 'Cancel Sync'}
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        {status !== 'connected' ? (
          <button
            onClick={() => connectMutation.mutate()}
            disabled={connectMutation.isPending || status === 'connecting'}
            className="btn-primary text-xs"
          >
            {connectMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
            Connect
          </button>
        ) : (
          <button
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
            className="btn-secondary text-xs"
          >
            {disconnectMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
            Disconnect
          </button>
        )}
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending || status !== 'connected'}
          className="btn-secondary text-xs"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
          Sync Now
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Credentials
// ─────────────────────────────────────────────────────────────────────────────

type TgStep = 'creds' | 'otp' | 'password' | 'done';

interface TelegramOTPFlowProps {
  onDone: () => void;
  savedApiId?: string;
  savedApiHash?: string;
  savedPhone?: string;
}

function TelegramOTPFlow({ onDone, savedApiId = '', savedApiHash = '', savedPhone = '' }: TelegramOTPFlowProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<TgStep>('creds');
  const [apiId, setApiId]     = useState(savedApiId);
  const [apiHash, setApiHash] = useState(savedApiHash);
  const [phone, setPhone]     = useState(savedPhone);
  const [otp, setOtp]               = useState('');
  const [otpErr, setOtpErr]         = useState('');
  const [twoFaPassword, setTwoFaPassword] = useState('');
  const [twoFaErr, setTwoFaErr]     = useState('');
  const [showTwoFaPw, setShowTwoFaPw] = useState(false);

  // Pre-populate if saved values arrive after initial render (async fetch)
  useEffect(() => { if (savedApiId  && !apiId)   setApiId(savedApiId); },   [savedApiId]);
  useEffect(() => { if (savedApiHash && !apiHash) setApiHash(savedApiHash); }, [savedApiHash]);
  useEffect(() => { if (savedPhone  && !phone)   setPhone(savedPhone); },   [savedPhone]);

  // Whether the current fields differ from what is already saved
  const hasChanges = apiId !== savedApiId || apiHash !== savedApiHash || phone !== savedPhone;

  const saveCreds = useMutation({
    mutationFn: () => api.updateCredentials('telegram', { apiId, apiHash, phone }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credentials-raw', 'telegram'] });
      qc.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (e: Error) => toast({ title: 'Failed to save credentials', description: e.message, variant: 'destructive' }),
  });

  const sendCode = useMutation({
    mutationFn: () => api.telegramSendCode(apiId, apiHash, phone),
    onSuccess: () => setStep('otp'),
    onError: (e: Error) => toast({ title: 'Failed to send code', description: e.message, variant: 'destructive' }),
  });

  const handleSendCode = async () => {
    // Always persist credentials first so they survive a page reload
    if (hasChanges) await saveCreds.mutateAsync();
    sendCode.mutate();
  };

  const signIn = useMutation({
    mutationFn: () => api.telegramSignIn(otp),
    onSuccess: (res) => {
      if (res.passwordRequired) {
        setStep('password');
      } else {
        setStep('done');
        toast({ title: 'Telegram authenticated', variant: 'success' });
        onDone();
      }
    },
    onError: (e: Error) => setOtpErr(e.message),
  });

  const checkPassword = useMutation({
    mutationFn: () => api.telegramCheckPassword(twoFaPassword),
    onSuccess: () => { setStep('done'); toast({ title: 'Telegram authenticated', variant: 'success' }); onDone(); },
    onError: (e: Error) => setTwoFaErr(e.message),
  });

  if (step === 'done') return (
    <div className="flex items-center gap-2 text-emerald-400 text-sm">
      <CheckCircle2 className="w-4 h-4" />
      Authenticated — session stored in database
    </div>
  );

  if (step === 'otp') return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A verification code was sent to your Telegram app for <span className="text-foreground font-medium">{phone}</span>.
      </p>
      <TextField label="Verification Code" value={otp} onChange={setOtp} placeholder="5-digit code" type="text" />
      {otpErr && <p className="text-xs text-red-400">{otpErr}</p>}
      <div className="flex gap-2">
        <button onClick={() => setStep('creds')} className="btn-secondary text-xs flex-1">Back</button>
        <button
          onClick={() => signIn.mutate()}
          disabled={!otp || signIn.isPending}
          className="btn-primary text-xs flex-1"
        >
          {signIn.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Verify
        </button>
      </div>
    </div>
  );

  if (step === 'password') return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 text-primary flex-shrink-0" />
        <p className="text-xs text-primary">Two-factor authentication is enabled on this account. Enter your Telegram cloud password to continue.</p>
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-muted-foreground">Cloud Password</label>
        <div className="relative">
          <input
            autoFocus
            type={showTwoFaPw ? 'text' : 'password'}
            value={twoFaPassword}
            onChange={(e) => { setTwoFaPassword(e.target.value); setTwoFaErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && twoFaPassword) checkPassword.mutate(); }}
            placeholder="Your Telegram 2FA password"
            className="input-warm pr-10 w-full"
          />
          <button
            type="button"
            onClick={() => setShowTwoFaPw(!showTwoFaPw)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showTwoFaPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      {twoFaErr && <p className="text-xs text-red-400">{twoFaErr}</p>}
      <div className="flex gap-2">
        <button onClick={() => { setStep('otp'); setTwoFaPassword(''); setTwoFaErr(''); }} className="btn-secondary text-xs flex-1">Back</button>
        <button
          onClick={() => checkPassword.mutate()}
          disabled={!twoFaPassword || checkPassword.isPending}
          className="btn-primary text-xs flex-1"
        >
          {checkPassword.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Confirm Password
        </button>
      </div>
    </div>
  );

  const isBusy = saveCreds.isPending || sendCode.isPending;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-2.5 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground text-[13px]">How to get your Telegram API credentials</p>
        <ol className="space-y-1.5 list-decimal list-inside marker:text-muted-foreground/50">
          <li>Go to <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-primary hover:underline">my.telegram.org</a> and sign in with your Telegram phone number</li>
          <li>Click <strong className="text-foreground/80">API development tools</strong></li>
          <li>Fill in the form — the values don't matter, but here's what to put:
            <ul className="mt-1.5 ml-4 space-y-1 list-disc marker:text-muted-foreground/40">
              <li><strong className="text-foreground/80">App title:</strong> anything, e.g. <code className="bg-secondary/80 px-1 rounded text-[10px]">Conduit</code></li>
              <li><strong className="text-foreground/80">Short name:</strong> one word, e.g. <code className="bg-secondary/80 px-1 rounded text-[10px]">conduit</code> (no spaces)</li>
              <li><strong className="text-foreground/80">URL:</strong> leave blank</li>
              <li><strong className="text-foreground/80">Platform:</strong> choose <code className="bg-secondary/80 px-1 rounded text-[10px]">Desktop</code></li>
              <li><strong className="text-foreground/80">Description:</strong> leave blank</li>
            </ul>
          </li>
          <li>Click <strong className="text-foreground/80">Create application</strong> — your <strong className="text-foreground/80">App api_id</strong> (a number) and <strong className="text-foreground/80">App api_hash</strong> (a 32-character string) will appear on the page</li>
          <li>Paste them below along with your phone number, then click <strong className="text-foreground/80">Send Code</strong> — Telegram will send a login code to your Telegram app</li>
        </ol>
        <p className="text-[11px] text-primary/80 flex items-start gap-1.5 pt-1 border-t border-border/40">
          <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          If the form fails to submit or shows an error, disable browser extensions (especially ad blockers or privacy shields) and try again in a plain browser window.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="API ID" value={apiId} onChange={setApiId} placeholder="Numeric ID" />
        <SecretField label="API Hash" value={apiHash} onChange={setApiHash} placeholder="32-char hash" />
      </div>
      <TextField label="Phone Number" value={phone} onChange={setPhone} placeholder="+15551234567" type="tel" />
      <button
        onClick={handleSendCode}
        disabled={!apiId || !apiHash || !phone || isBusy}
        className="btn-primary text-xs"
      >
        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        {hasChanges ? 'Save & Send Code' : 'Send Code'}
      </button>
    </div>
  );
}

function DiscordGuildPicker({ isConnected }: { isConnected: boolean }) {
  const qc = useQueryClient();
  const { data: guilds, isLoading, error } = useQuery({
    queryKey: ['discord-guilds'],
    queryFn: api.discordGuilds,
    enabled: isConnected,
    retry: false,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inited, setInited] = useState(false);

  useEffect(() => {
    if (guilds && !inited) {
      setSelected(new Set(guilds.filter((g) => g.synced).map((g) => g.id)));
      setInited(true);
    }
  }, [guilds, inited]);

  const save = useMutation({
    mutationFn: () => api.setDiscordSyncGuilds(Array.from(selected)),
    onSuccess: () => { toast({ title: 'Server sync preferences saved', variant: 'success' }); qc.invalidateQueries({ queryKey: ['discord-guilds'] }); },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (!isConnected) return <p className="text-xs text-muted-foreground">Connect Discord to select servers to sync. DMs are always synced.</p>;
  if (isLoading)    return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading servers…</div>;
  if (error || !guilds) return <p className="text-xs text-muted-foreground">Could not load servers.</p>;
  if (guilds.length === 0) return <p className="text-xs text-muted-foreground">No servers visible to this account.</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Servers to sync — DMs are always included</p>
        <span className="text-[11px] text-muted-foreground">{selected.size}/{guilds.length}</span>
      </div>
      <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
        {guilds.map((g) => <GuildRow key={g.id} guild={g} checked={selected.has(g.id)} onToggle={() => toggle(g.id)} />)}
      </div>
      <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-xs">
        {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
        Save Selection
      </button>
    </div>
  );
}

function GuildRow({ guild, checked, onToggle }: { guild: DiscordGuildInfo; checked: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  const iconUrl = guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=32` : null;

  return (
    <div className={cn(
      'rounded-xl border transition-all duration-150 overflow-hidden',
      checked ? 'border-primary/25 bg-primary/5' : 'border-border bg-secondary/30',
    )}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button" onClick={onToggle}
          className={cn(
            'w-4 h-4 rounded flex-shrink-0 border-2 flex items-center justify-center transition-all',
            checked ? 'bg-primary border-primary' : 'border-warm-600',
          )}
        >
          {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
        </button>
        {iconUrl
          ? <img src={iconUrl} alt={guild.name} className="w-6 h-6 rounded-full flex-shrink-0 object-cover" />
          : <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0"><Server className="w-3.5 h-3.5 text-indigo-400" /></div>
        }
        <span className="flex-1 text-xs font-medium truncate">{guild.name}</span>
        {guild.channels.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)} className="btn-ghost p-0.5">
            <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="px-4 pb-2 space-y-0.5 border-t border-border/50">
              {guild.channels.map((ch) => (
                <div key={ch.id} className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
                  <span className="text-warm-600">#</span> {ch.name}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CredentialsSection({ service, onConnected }: { service: Service; onConnected?: () => void }) {
  const qc = useQueryClient();
  const connStatus = useConnectionStore((s) => s.statuses[service]);
  const isConnected = connStatus?.status === 'connected';

  const { data: raw } = useQuery({
    queryKey: ['credentials-raw', service],
    queryFn: () => api.credentialsRaw(service),
  });
  const { data: credInfo } = useQuery({ queryKey: ['credentials'], queryFn: api.credentials });

  const [fields, setFields] = useState<Record<string, string>>({});
  // Track the last value fetched from the server so we can detect edits
  const [savedFields, setSavedFields] = useState<Record<string, string>>({});

  useEffect(() => {
    if (raw) {
      setFields({ ...raw });
      setSavedFields({ ...raw });
    }
  }, [raw]);

  const set = (k: string) => (v: string) => setFields((f) => ({ ...f, [k]: v }));

  // Only enable Save when at least one field has changed from the saved value
  const isDirty = Object.keys(fields).some((k) => fields[k] !== (savedFields[k] ?? ''))
    || Object.keys(savedFields).some((k) => (fields[k] ?? '') !== savedFields[k]);

  const save = useMutation({
    mutationFn: () => {
      // Strip accidental surrounding quotes (e.g. copied from Local Storage as `"token-value"`)
      const cleaned = Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, v.replace(/^["']|["']$/g, '')])
      );
      return api.updateCredentials(service, cleaned);
    },
    onSuccess: async () => {
      // Reflect stripped values back and sync savedFields to the same cleaned snapshot
      const cleaned = Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, v.replace(/^["']|["']$/g, '')])
      );
      setFields(cleaned);
      toast({ title: 'Credentials saved', variant: 'success' });
      setSavedFields(cleaned); // reset dirty state
      qc.invalidateQueries({ queryKey: ['credentials-raw', service] });
      qc.invalidateQueries({ queryKey: ['credentials'] });
      // Auto-connect when credentials are saved for the first time or while disconnected.
      // Telegram uses its own OTP flow so skip auto-connect there.
      if (!isConnected && service !== 'telegram') {
        await api.connect(service);
        qc.invalidateQueries({ queryKey: ['connections'] });
        onConnected?.();
      }
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const tgAuth = credInfo?.telegram?.authenticated;

  return (
    <div className="space-y-5">
      <SectionHeader icon={Key} title="Credentials" subtitle="Tokens and authentication secrets stored locally in the database" />

      {service === 'slack' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground text-[13px]">How to get your Slack tokens</p>
            <ol className="space-y-3 list-decimal list-inside marker:text-muted-foreground/50">
              <li>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-primary hover:underline">api.slack.com/apps</a> → <strong className="text-foreground/80">Create New App</strong> → choose <strong className="text-foreground/80">From an app manifest</strong> → select your workspace</li>
              <li>
                <span>Copy the manifest and paste it into Slack → click <strong className="text-foreground/80">Next</strong> → <strong className="text-foreground/80">Create</strong></span>
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-foreground/70">App Manifest</p>
                    <CopyButton text={SLACK_MANIFEST} title="Copy manifest" />
                  </div>
                  <pre className="rounded-lg bg-background border border-border p-3 text-[10px] font-mono text-foreground/70 overflow-x-auto whitespace-pre leading-relaxed">{SLACK_MANIFEST}</pre>
                </div>
              </li>
              <li>In Slack's app settings go to <strong className="text-foreground/80">OAuth &amp; Permissions</strong> → click <strong className="text-foreground/80">Install to Workspace</strong> → <strong className="text-foreground/80">Allow</strong> → back on that same page, copy the <strong className="text-foreground/80">User OAuth Token</strong> (<code className="bg-secondary/80 px-1 rounded text-[10px]">xoxp-…</code>) and paste it below</li>
              <li>For real-time: sidebar → <strong className="text-foreground/80">Socket Mode</strong> → enable → generate a token → copy the <strong className="text-foreground/80">App-Level Token</strong> (<code className="bg-secondary/80 px-1 rounded text-[10px]">xapp-…</code>) and paste it below</li>
            </ol>
          </div>
          <SecretField
            label="User OAuth Token (xoxp-…)"
            value={fields.token || ''}
            onChange={set('token')}
            placeholder="xoxp-..."
          />
          <SecretField
            label="App-Level Token (xapp-…) — optional, enables real-time events"
            value={fields.appToken || ''}
            onChange={set('appToken')}
            placeholder="xapp-..."
            hint="Without this, Conduit falls back to polling every 2 minutes."
          />
          <button onClick={() => save.mutate()} disabled={save.isPending || !isDirty} className="btn-primary text-xs">
            {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Save Credentials
          </button>
        </div>
      )}

      {service === 'discord' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground text-[13px]">How to get your Discord user token</p>
            <ol className="space-y-3 list-decimal list-inside marker:text-muted-foreground/50">
              <li>Go to <a href="https://discord.com/app" target="_blank" rel="noreferrer" className="text-primary hover:underline">discord.com/app</a> and log in</li>
              <li>Press <kbd className="bg-secondary/80 border border-border rounded px-1 text-[10px]">F12</kbd> → <strong className="text-foreground/80">Application</strong> tab → <strong className="text-foreground/80">Local Storage</strong> → <code className="bg-secondary/80 px-1 rounded text-[10px]">https://discord.com</code> → find the key <code className="bg-secondary/80 px-1 rounded text-[10px]">token</code></li>
              <li>Double-click the value column and copy it</li>
            </ol>
          </div>
          <SecretField
            label="User Token"
            value={fields.token || ''}
            onChange={set('token')}
            placeholder="Discord user token"
          />
          <button onClick={() => save.mutate()} disabled={save.isPending || !isDirty} className="btn-primary text-xs">
            {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Save Credentials
          </button>

          <div className="divider" />
          <div>
            <p className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" />
              Server Sync Selection
            </p>
            <DiscordGuildPicker isConnected={isConnected} />
          </div>
        </div>
      )}

      {service === 'telegram' && (
        <div className="space-y-4">
          {tgAuth ? (
            <>
              <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-emerald-400">Authenticated</p>
                  <p className="text-xs text-muted-foreground">Session is stored in the database and persists across restarts</p>
                </div>
              </div>
              {raw && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <TextField label="API ID" value={fields.apiId || ''} onChange={set('apiId')} placeholder="Numeric ID" />
                    <SecretField label="API Hash" value={fields.apiHash || ''} onChange={set('apiHash')} placeholder="32-char hash" />
                  </div>
                  <TextField label="Phone" value={fields.phone || ''} onChange={set('phone')} placeholder="+15551234567" type="tel" />
                  <div className="flex gap-2">
                    <button onClick={() => save.mutate()} disabled={save.isPending || !isDirty} className="btn-primary text-xs">
                      {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      Save
                    </button>
                    <button
                      onClick={() => {
                        qc.invalidateQueries({ queryKey: ['credentials'] });
                        toast({ title: 'Re-auth flow started', variant: 'default' });
                      }}
                      className="btn-secondary text-xs"
                    >
                      Re-authenticate
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <TelegramOTPFlow
              onDone={() => { qc.invalidateQueries({ queryKey: ['credentials'] }); }}
              savedApiId={fields.apiId || ''}
              savedApiHash={fields.apiHash || ''}
              savedPhone={fields.phone || ''}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Permissions
// ─────────────────────────────────────────────────────────────────────────────

export function PermissionsSection({ service }: { service: Service }) {
  const qc = useQueryClient();
  const { data: perms } = useQuery({ queryKey: ['permissions'], queryFn: api.permissions });
  const perm = perms?.find((p) => p.service === service);
  const [local, setLocal] = useState<Permission | null>(null);
  useEffect(() => { if (perm) setLocal({ ...perm }); }, [perm]);

  const update = useMutation({
    mutationFn: (updates: Partial<Permission>) => api.updatePermission(service, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions'] }),
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const handleToggle = (field: keyof Permission, value: boolean) => {
    if (!local) return;
    const extra = field === 'requireApproval' ? { directSendFromUi: !value } : {};
    setLocal({ ...local, [field]: value, ...extra });
    update.mutate({ [field]: value, ...extra });
  };

  if (!local) return null;

  return (
    <div className="space-y-5">
      <SectionHeader icon={Shield} title="Permissions" subtitle="Control what Conduit can read and send on your behalf" />
      <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
        {([
          { key: 'readEnabled',      label: 'Read Access',         desc: 'Allow Conduit to read messages from this service' },
          { key: 'sendEnabled',      label: 'Send Messages',       desc: 'Allow sending messages through this service' },
          { key: 'requireApproval',  label: 'Require Approval',    desc: 'All outgoing messages must be manually approved first. When off, messages sent from the UI go immediately without outbox review.' },
        ] as { key: keyof Permission; label: string; desc: string }[]).map(({ key, label, desc }) => (
          <div key={key} className="px-4 bg-secondary/20">
            <Toggle
              checked={!!local[key]}
              onChange={(v) => handleToggle(key, v)}
              label={label}
              description={desc}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Sync Settings
// ─────────────────────────────────────────────────────────────────────────────

function SyncSection({ service }: { service: Service }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [interval, setInterval] = useState(service === 'discord' ? 30 : 5);

  useEffect(() => {
    const iv = settings?.incrementalIntervalMinutes as Record<string, number> | undefined;
    if (iv?.[service] != null) setInterval(iv[service]);
  }, [settings, service]);

  const save = useMutation({
    mutationFn: () => {
      const iv = (settings?.incrementalIntervalMinutes as Record<string, number>) ?? {};
      return api.updateSettings({ incrementalIntervalMinutes: { ...iv, [service]: interval } });
    },
    onSuccess: () => { toast({ title: 'Sync interval saved', variant: 'success' }); qc.invalidateQueries({ queryKey: ['settings'] }); },
  });

  return (
    <div className="space-y-5">
      <SectionHeader icon={Clock} title="Sync Settings" subtitle="Control how often Conduit polls for new messages" />
      <div className="max-w-xs space-y-4">
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted-foreground">
            Incremental Poll Interval (minutes)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range" min={1} max={120} value={interval}
              onChange={(e) => setInterval(parseInt(e.target.value))}
              className="flex-1 accent-primary"
            />
            <input
              type="number" min={1} max={120} value={interval}
              onChange={(e) => setInterval(Math.max(1, Math.min(120, parseInt(e.target.value) || 1)))}
              className="input-warm w-20 text-center font-mono"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            How often to check for new messages when no realtime connection is available.
            {service === 'slack' && ' Set up Socket Mode in Credentials for instant delivery.'}
            {service === 'discord' && ' Discord Gateway provides realtime events automatically.'}
            {service === 'telegram' && ' Telegram MTProto provides realtime events automatically.'}
          </p>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-xs">
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Data
// ─────────────────────────────────────────────────────────────────────────────

function DataSection({ service }: { service: Service }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const reset = useMutation({
    mutationFn: () => api.resetService(service),
    onSuccess: () => {
      toast({ title: `${service} reset — full resync started`, variant: 'default' });
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ['chats'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (e: Error) => { toast({ title: 'Reset failed', description: e.message, variant: 'destructive' }); setConfirming(false); },
  });

  const { data: statusData } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 10000 });

  return (
    <div className="space-y-5">
      <SectionHeader icon={Database} title="Data" subtitle="Manage the locally stored message data for this service" />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border bg-secondary/30 p-4">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">Messages Stored</p>
          <p className="text-xl font-semibold">{(statusData?.messageCounts[service] ?? 0).toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/30 p-4">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">Synced Chats</p>
          <p className="text-xl font-semibold">{(statusData?.chatCounts[service] ?? 0).toLocaleString()}</p>
        </div>
      </div>

      {/* Reset */}
      <div className="rounded-xl border border-red-500/15 bg-red-500/5 p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-red-400">Reset &amp; Resync</p>
          <p className="text-xs text-muted-foreground mt-1">
            Wipes all locally stored messages, chat state, and sync history for {service}.
            Your credentials and session are preserved. The live listener is re-established
            before the resync begins so nothing is missed during the process.
          </p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-primary font-medium flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              This will delete all {service} data. Continue?
            </span>
            <button onClick={() => setConfirming(false)} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
            <button
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
              className="btn-danger text-xs py-1.5 px-3"
            >
              {reset.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Confirm Reset
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="btn-danger text-xs">
            <Database className="w-3.5 h-3.5" /> Reset &amp; Resync
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Service Accordion
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Section: Contacts
// ─────────────────────────────────────────────────────────────────────────────

function ContactsSection({ service }: { service: Service }) {
  const qc = useQueryClient();
  const { data: criteria, isLoading: criteriaLoading } = useQuery({
    queryKey: ['contact-criteria', service],
    queryFn: () => api.contactCriteria(service),
  });
  const { data: contactsData } = useQuery({
    queryKey: ['contacts', service],
    queryFn: () => api.contacts({ source: service, limit: 1 }),
  });

  const [local, setLocal] = useState<ContactCriteria | null>(null);
  useEffect(() => { if (criteria) setLocal({ ...criteria }); }, [criteria]);

  const saveCriteria = useMutation({
    mutationFn: () => api.updateContactCriteria(service, local!),
    onSuccess: () => {
      toast({ title: 'Contact criteria saved', variant: 'success' });
      qc.invalidateQueries({ queryKey: ['contact-criteria', service] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const syncContacts = useMutation({
    mutationFn: () => api.triggerSync(service),
    onSuccess: () => toast({ title: `${service} contact sync triggered`, variant: 'default' }),
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const rebuildContacts = useMutation({
    mutationFn: () => api.rebuildContacts(service),
    onSuccess: (d) => {
      toast({ title: `Rebuilt ${d.upserted} contacts from existing messages`, variant: 'success' });
      qc.invalidateQueries({ queryKey: ['contacts', service] });
    },
    onError: (e: Error) => toast({ title: 'Rebuild failed', description: e.message, variant: 'destructive' }),
  });

  if (criteriaLoading || !local) {
    return <div className="text-xs text-muted-foreground">Loading criteria…</div>;
  }

  const isSlack = service === 'slack';
  const totalContacts = contactsData?.total ?? 0;

  const CRITERIA_FIELDS: Array<{ key: keyof ContactCriteria; label: string; description: string; slackHide?: boolean }> = [
    { key: 'hasDm', label: 'Direct Messages', description: 'Include anyone you have a DM conversation with' },
    { key: 'ownedGroup', label: 'Groups/Channels You Own or Admin', description: 'Include members of groups where you are creator or admin', slackHide: true },
    { key: 'smallGroup', label: 'Small Groups', description: `Include members of groups with fewer than ${local.smallGroupThreshold} people`, slackHide: true },
    { key: 'nativeContacts', label: 'Platform Contact List', description: service === 'slack' ? 'All workspace members (Slack includes everyone)' : service === 'discord' ? "Your Discord friend list" : 'Your Telegram contacts list' },
  ];

  return (
    <div className="space-y-5">
      <SectionHeader icon={Users} title="Contacts" subtitle="Configure which platform users are tracked as contacts" />

      {/* Stats */}
      <div className="flex items-center gap-4 rounded-xl border border-border bg-secondary/30 px-4 py-3">
        <div>
          <p className="text-2xl font-bold">{totalContacts.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">contacts synced</p>
        </div>
        <div className="flex-1" />
        <a href="/contacts" className="btn-ghost text-xs gap-1.5">
          <ExternalLink className="w-3.5 h-3.5" />
          Browse all contacts
        </a>
      </div>

      {/* Criteria toggles */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground mb-3">
          {isSlack
            ? 'Slack syncs all workspace members. Criteria flags are still tracked to identify how each person qualifies.'
            : 'A user is included if they meet ANY of the enabled criteria below.'}
        </p>

        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
          {/* Enabled toggle */}
          <div className="px-4 bg-secondary/30">
            <div className="flex items-start justify-between gap-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Contact Sync Enabled</p>
                <p className="text-xs text-muted-foreground mt-0.5">When disabled, no contact data will be collected for this service</p>
              </div>
              <button
                type="button"
                onClick={() => setLocal((p) => p ? { ...p, enabled: !p.enabled } : p)}
                className={cn(
                  'relative flex-shrink-0 w-10 h-6 rounded-full transition-all duration-200',
                  local.enabled ? 'bg-primary shadow-amber' : 'bg-warm-700',
                )}
              >
                <span className={cn('absolute top-1 w-4 h-4 rounded-full bg-white shadow-warm-sm transition-all duration-200', local.enabled ? 'left-5' : 'left-1')} />
              </button>
            </div>
          </div>

          {CRITERIA_FIELDS.filter((f) => !f.slackHide || !isSlack).map(({ key, label, description }) => (
            <div key={key} className={cn('px-4', !local.enabled && 'opacity-50 pointer-events-none')}>
              <div className="flex items-start justify-between gap-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setLocal((p) => p ? { ...p, [key]: !p[key] } : p)}
                  className={cn(
                    'relative flex-shrink-0 w-10 h-6 rounded-full transition-all duration-200',
                    local[key] ? 'bg-primary shadow-amber' : 'bg-warm-700',
                  )}
                >
                  <span className={cn('absolute top-1 w-4 h-4 rounded-full bg-white shadow-warm-sm transition-all duration-200', local[key] ? 'left-5' : 'left-1')} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Small group threshold */}
      {!isSlack && (
        <div className={cn('space-y-2 max-w-xs', !local.enabled && 'opacity-50 pointer-events-none')}>
          <label className="block text-xs font-medium text-muted-foreground">
            Small Group Threshold (members)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range" min={5} max={500} value={local.smallGroupThreshold}
              onChange={(e) => setLocal((p) => p ? { ...p, smallGroupThreshold: parseInt(e.target.value) } : p)}
              className="flex-1 accent-primary"
            />
            <input
              type="number" min={5} max={500} value={local.smallGroupThreshold}
              onChange={(e) => setLocal((p) => p ? { ...p, smallGroupThreshold: Math.max(5, Math.min(500, parseInt(e.target.value) || 50)) } : p)}
              className="input-warm w-20 text-center font-mono"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Groups with fewer than this many members qualify for the "Small Group" criterion</p>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => saveCriteria.mutate()} disabled={saveCriteria.isPending} className="btn-primary text-xs">
          {saveCriteria.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Save Criteria
        </button>
        <button
          onClick={() => rebuildContacts.mutate()}
          disabled={rebuildContacts.isPending}
          className="btn-secondary text-xs"
          title="Re-applies current criteria to existing synced messages without calling the platform API"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', rebuildContacts.isPending && 'animate-spin')} />
          Rebuild from Messages
        </button>
        <button onClick={() => syncContacts.mutate()} disabled={syncContacts.isPending} className="btn-secondary text-xs">
          <RefreshCw className={cn('w-3.5 h-3.5', syncContacts.isPending && 'animate-spin')} />
          Full Sync
        </button>
      </div>

      <p className="text-xs text-muted-foreground/50">
        <strong className="text-muted-foreground/70">Rebuild from Messages</strong> — applies current criteria to already-synced messages instantly, no platform API calls.{' '}
        <strong className="text-muted-foreground/70">Full Sync</strong> — fetches fresh data from {service}'s API.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
const SERVICE_SECTIONS = [
  { id: 'overview',     label: 'Overview',     icon: PlugZap  },
  { id: 'credentials', label: 'Credentials',  icon: Key      },
  { id: 'permissions', label: 'Permissions',  icon: Shield   },
  { id: 'sync',        label: 'Sync',         icon: Clock    },
  { id: 'contacts',    label: 'Contacts',     icon: Users    },
  { id: 'data',        label: 'Data',         icon: Database },
] as const;

type SectionId = typeof SERVICE_SECTIONS[number]['id'];

export function ServiceAccordion({ service }: { service: Service }) {
  const cfg = SERVICE_CONFIG[service];
  const connStatus   = useConnectionStore((s) => s.statuses[service]);
  const syncProgress = useSyncStore((s) => s.progress[service]);
  const status = connStatus?.status ?? 'disconnected';
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const isSyncing = syncProgress?.status === 'running';

  // Test state lives here so it survives accordion collapse/expand
  const [testSteps, setTestSteps] = useState<TestStep[]>([]);
  const [testRunning, setTestRunning] = useState(false);

  const runTest = useCallback(async () => {
    setTestRunning(true);
    setTestSteps([]);
    try {
      const res = await fetch(`/api/test/${service}`);
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
    } catch { /* ignore stream errors */ }
    setTestRunning(false);
  }, [service]);

  const { data: statusData } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 10000 });
  const msgCount = statusData?.messageCounts[service] ?? 0;

  return (
    <motion.div
      layout
      className={cn(
        'rounded-2xl border overflow-hidden transition-all duration-200',
        open
          ? 'border-border shadow-warm-md'
          : 'border-border/60 hover:border-border',
      )}
    >
      {/* Accordion header */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors',
          open ? 'bg-card' : 'bg-card/50 hover:bg-card/80',
        )}
      >
        <ServiceIcon service={service} size="md" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-base font-semibold capitalize">{service}</h2>
            <StatusBadge status={status as 'connected'|'disconnected'|'connecting'|'error'} />
            {connStatus?.displayName && (
              <span className="text-xs text-muted-foreground truncate">{connStatus.displayName}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <span>{msgCount.toLocaleString()} messages</span>
            {connStatus?.mode && <span>• {connStatus.mode}</span>}
            {/* Sync running indicator — visible even when accordion is collapsed */}
            {isSyncing && (
              <span className="text-primary flex items-center gap-1">
                <RefreshCw className="w-3 h-3 animate-spin" />
                {syncProgress?.type === 'full' ? 'Full sync' : 'Syncing'}
                {syncProgress?.messagesSaved ? ` · +${syncProgress.messagesSaved.toLocaleString()}` : ''}
              </span>
            )}
            {!isSyncing && testSteps.length > 0 && !open && (
              testSteps.every((s) => s.status === 'success')
                ? <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Tests passed</span>
                : testSteps.some((s) => s.status === 'error')
                  ? <span className="text-red-400 flex items-center gap-1"><XCircle className="w-3 h-3" />Test failed</span>
                  : testRunning
                    ? <span className="text-primary flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Testing…</span>
                    : null
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {connStatus?.error && !open && (
            <span className="hidden sm:flex items-center gap-1 text-xs text-red-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              {connStatus.error.slice(0, 40)}
            </span>
          )}
          <div className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center border transition-all',
            open ? 'bg-secondary border-border' : 'bg-secondary/50 border-border/50',
          )}>
            <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} />
          </div>
        </div>
      </button>

      {/* Accordion body */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border bg-card">
              {/* Section nav tabs */}
              <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-secondary/20 overflow-x-auto">
                {SERVICE_SECTIONS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveSection(id)}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150',
                      activeSection === id
                        ? 'bg-primary/15 text-primary border border-primary/25'
                        : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Section content */}
              <div className="p-4">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeSection}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.15 }}
                  >
                    {activeSection === 'overview'    && <OverviewSection    service={service} testSteps={testSteps} testRunning={testRunning} runTest={runTest} clearTestSteps={() => setTestSteps([])} />}
                    {activeSection === 'credentials' && <CredentialsSection service={service} onConnected={() => setActiveSection('overview')} />}
                    {activeSection === 'permissions' && <PermissionsSection service={service} />}
                    {activeSection === 'sync'        && <SyncSection        service={service} />}
                    {activeSection === 'contacts'    && <ContactsSection    service={service} />}
                    {activeSection === 'data'        && <DataSection        service={service} />}
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
