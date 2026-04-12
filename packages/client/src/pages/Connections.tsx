/**
 * Services page — unified Connections + Settings
 *
 * Each service (Slack, Discord, Telegram) has a full-width accordion with
 * five vertically-stacked sections: Overview, Credentials, Permissions,
 * Sync, and Data. Multiple accordions can be open simultaneously.
 *
 * Below the service accordions: Global Settings (app name, sync intervals)
 * and API Key management.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, Eye, EyeOff, RefreshCw, Loader2, CheckCircle2,
  XCircle, AlertTriangle, Database, Key, Plus, Copy, Check, Trash2, X,
  Send, Server, Shield, Settings, PlugZap, UserCircle2, Clock, Users, ExternalLink,
  MessageSquare as MessageSquareIcon, Mail as MailIcon, Lock, ShieldCheck, QrCode,
  LogOut, Zap, FileText, Bot, Unplug, ArrowRight, CircleCheck, CircleX, Bell, Volume2, VolumeX,
  BookOpen, GitBranch, Palette,
} from 'lucide-react';
import { AppearanceTab } from '@/components/settings/AppearanceTab';
import {
  api, uiAuth, type ServiceCredential, type DiscordGuildInfo, type Permission, type ApiKeyItem,
  type ContactCriteria, type KeyPermissionsResponse, type KeyServicePerm, type AiConnection, type AiPermissions,
  type ObsidianVaultConfigRow,
} from '@/lib/api';
import { useConnectionStore, useSyncStore, type SyncProgress } from '@/store';
import { ServiceIcon, SERVICE_CONFIG } from '@/components/shared/ServiceBadge';
import { StatusBadge, StatusDot } from '@/components/shared/StatusDot';
import { cn, timeAgo, formatDate } from '@/lib/utils';
import { toast } from '@/store';
import type { NotificationSoundSettings, SoundStyle } from '@/hooks/useNotificationSound';
import { DEFAULT_SOUND_SETTINGS } from '@/hooks/useNotificationSound';

type Service = 'slack' | 'discord' | 'telegram';
const SERVICES: Service[] = ['slack', 'discord', 'telegram'];

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, title, subtitle }: {
  icon: React.ComponentType<{ className?: string }>; title: string; subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-3 mb-5">
      <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/8 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function SecretField({ label, value, onChange, placeholder, hint, readOnly }: {
  label: string; value: string; onChange?: (v: string) => void;
  placeholder?: string; hint?: React.ReactNode; readOnly?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          placeholder={placeholder}
          readOnly={readOnly}
          className={cn(
            'input-warm pr-10 font-mono',
            readOnly && 'cursor-default opacity-70',
          )}
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground/60">{hint}</p>}
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input-warm"
      />
    </div>
  );
}

function Toggle({ checked, onChange, label, description }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={cn(
          'relative flex-shrink-0 w-10 h-6 rounded-full transition-all duration-200 focus:outline-none',
          checked ? 'bg-primary shadow-amber' : 'bg-warm-700',
        )}
      >
        <span className={cn(
          'absolute top-1 w-4 h-4 rounded-full bg-white shadow-warm-sm transition-all duration-200',
          checked ? 'left-5' : 'left-1',
        )} />
      </button>
    </div>
  );
}

function CopyableScope({ scope }: { scope: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(scope).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2">
      <code className="flex-1 text-[10px] text-foreground/80 break-all leading-relaxed">{scope}</code>
      <button
        type="button"
        onClick={copy}
        className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title="Copy scopes"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Panel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Section: Overview  (test results live inline in the status card)
// ─────────────────────────────────────────────────────────────────────────────

interface TestStep {
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

function CredentialsSection({ service }: { service: Service }) {
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
    mutationFn: () => api.updateCredentials(service, fields),
    onSuccess: () => {
      toast({ title: 'Credentials saved', variant: 'success' });
      setSavedFields({ ...fields }); // reset dirty state
      qc.invalidateQueries({ queryKey: ['credentials-raw', service] });
      qc.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const tgAuth = credInfo?.telegram?.authenticated;

  return (
    <div className="space-y-5">
      <SectionHeader icon={Key} title="Credentials" subtitle="Tokens and authentication secrets stored locally in the database" />

      {service === 'slack' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-2.5 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground text-[13px]">How to get your Slack tokens</p>
            <ol className="space-y-1.5 list-decimal list-inside marker:text-muted-foreground/50">
              <li>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-primary hover:underline">api.slack.com/apps</a> → click <strong className="text-foreground/80">Create New App</strong> → choose <strong className="text-foreground/80">From scratch</strong> → name it anything → select your workspace → click <strong className="text-foreground/80">Create App</strong></li>
              <li>In the left sidebar click <strong className="text-foreground/80">OAuth &amp; Permissions</strong> → scroll to <strong className="text-foreground/80">User Token Scopes</strong> (not Bot Token Scopes) → click <strong className="text-foreground/80">Add an OAuth Scope</strong> and add all of these: <code className="bg-secondary/80 px-1 rounded text-[10px]">channels:history</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">channels:read</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">channels:write</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">groups:history</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">groups:read</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">groups:write</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">im:history</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">im:read</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">im:write</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">mpim:history</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">mpim:read</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">mpim:write</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">chat:write</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">users:read</code></li>
              <li>Scroll back to the top of <strong className="text-foreground/80">OAuth &amp; Permissions</strong> → click <strong className="text-foreground/80">Install to Workspace</strong> → click <strong className="text-foreground/80">Allow</strong> → copy the <strong className="text-foreground/80">User OAuth Token</strong> (<code className="bg-secondary/80 px-1 rounded text-[10px]">xoxp-…</code>) and paste it below</li>
              <li>For real-time events: in the sidebar click <strong className="text-foreground/80">Socket Mode</strong> → toggle <strong className="text-foreground/80">Enable Socket Mode</strong> on → create a token with any name → copy the <strong className="text-foreground/80">App-Level Token</strong> (<code className="bg-secondary/80 px-1 rounded text-[10px]">xapp-…</code>) and paste it below</li>
              <li>In the sidebar click <strong className="text-foreground/80">Event Subscriptions</strong> → toggle <strong className="text-foreground/80">Enable Events</strong> on → under <strong className="text-foreground/80">Subscribe to events on behalf of users</strong> add: <code className="bg-secondary/80 px-1 rounded text-[10px]">message.channels</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">message.groups</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">message.im</code> <code className="bg-secondary/80 px-1 rounded text-[10px]">message.mpim</code> → click <strong className="text-foreground/80">Save Changes</strong></li>
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
          <SecretField
            label="User Token"
            value={fields.token || ''}
            onChange={set('token')}
            placeholder="Discord user token"
            hint={<><a href="https://discord.com/app" target="_blank" rel="noreferrer" className="text-primary hover:underline">Open Discord in your browser</a> → press <kbd className="bg-secondary/80 border border-border rounded px-1 text-[10px]">F12</kbd> → Network tab → click any request to <code className="bg-secondary/80 px-1 rounded text-[10px]">discord.com</code> → copy the <code className="bg-secondary/80 px-1 rounded text-[10px]">Authorization</code> header value.</>}
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

function PermissionsSection({ service }: { service: Service }) {
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
          { key: 'markReadEnabled',  label: 'Mark as Read',        desc: 'Opening a conversation in Chat marks it as read on the platform. When off, read state is only tracked locally.' },
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

function ServiceAccordion({ service }: { service: Service }) {
  const cfg = SERVICE_CONFIG[service];
  const connStatus   = useConnectionStore((s) => s.statuses[service]);
  const syncProgress = useSyncStore((s) => s.progress[service]);
  const status = connStatus?.status ?? 'disconnected';
  const [open, setOpen] = useState(status === 'error' || status === 'disconnected');
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
                    {activeSection === 'credentials' && <CredentialsSection service={service} />}
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

// ─────────────────────────────────────────────────────────────────────────────
// Global: API Keys
// ─────────────────────────────────────────────────────────────────────────────

function ApiKeysPanel() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  const { data: keys = [] } = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const active = keys.filter((k) => !k.revokedAt);

  const create = useMutation({
    mutationFn: () => api.createApiKey(name),
    onSuccess: (d) => { setNewKey(d.key || null); setName(''); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeApiKey(id),
    onSuccess: () => { toast({ title: 'API key revoked' }); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
  });

  const copy = (v: string) => { navigator.clipboard.writeText(v); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div className="space-y-4">
      {/* New key form */}
      {creating ? (
        <div className="rounded-xl border border-border bg-secondary/30 p-4 space-y-3">
          {newKey ? (
            <>
              <p className="text-sm font-medium">Key Generated</p>
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-2 text-xs text-primary">
                Copy this key now — it will not be shown again.
              </div>
              <div className="flex items-center gap-2 bg-secondary rounded-xl p-3 border border-border">
                <code className="flex-1 text-xs font-mono text-emerald-400 break-all">{newKey}</code>
                <button onClick={() => copy(newKey)} className="btn-ghost p-1.5 flex-shrink-0">
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <button onClick={() => { setNewKey(null); setCreating(false); }} className="btn-primary text-xs">Done</button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Generate API Key</p>
              <input
                autoFocus value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Key name (e.g. Claude Assistant)"
                className="input-warm"
                onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create.mutate(); }}
              />
              <div className="flex gap-2">
                <button onClick={() => { setCreating(false); setName(''); }} className="btn-secondary text-xs flex-1">Cancel</button>
                <button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending} className="btn-primary text-xs flex-1">
                  {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  Generate
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <button onClick={() => setCreating(true)} className="btn-primary text-xs self-start">
          <Plus className="w-3.5 h-3.5" /> Generate Key
        </button>
      )}

      {/* Keys list */}
      {active.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/40">
                {['Name', 'Prefix', 'Created', 'Last Used', ''].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {active.map((k) => (
                <tr key={k.id} className="hover:bg-secondary/20 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium">{k.name}</td>
                  <td className="px-4 py-3">
                    <code className="chip chip-emerald font-mono">{k.keyPrefix}…</code>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(k.createdAt, 'MMM d, yyyy')}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'Never'}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => revoke.mutate(k.id)} disabled={revoke.isPending}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active.length === 0 && !creating && (
        <div className="flex flex-col items-center py-8 gap-2 text-muted-foreground border border-dashed border-border rounded-xl">
          <Key className="w-8 h-8 opacity-20" />
          <p className="text-sm">No API keys yet</p>
          <p className="text-xs opacity-60">Generate a key to allow AI agents to access messages</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Permissions tab + Install tab + Security tab
// ─────────────────────────────────────────────────────────────────────────────

const ALL_SERVICES = ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter', 'notion'] as const;

const PERM_COLS: Array<{ key: 'readEnabled' | 'sendEnabled' | 'requireApproval'; label: string; description: string }> = [
  { key: 'readEnabled',     label: 'Read',     description: 'Can read messages and data' },
  { key: 'sendEnabled',     label: 'Send',     description: 'Can create outbox items / send messages' },
  { key: 'requireApproval', label: 'Approval', description: 'All sends require manual approval' },
];

// ── Shared primitives ─────────────────────────────────────────────────────────

function MiniToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative w-9 h-5 rounded-full transition-all duration-200 flex-shrink-0',
        checked ? 'bg-primary shadow-amber' : 'bg-warm-700',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-warm-sm transition-all duration-200', checked ? 'left-4' : 'left-0.5')} />
    </button>
  );
}

const SVC_LABEL: Record<string, string> = {
  slack: 'Slack', discord: 'Discord', telegram: 'Telegram',
  gmail: 'Gmail', calendar: 'Calendar', twitter: 'Twitter', notion: 'Notion',
};

const SVC_COLOR: Record<string, string> = {
  slack: 'text-violet-400', discord: 'text-indigo-400', telegram: 'text-sky-400',
  gmail: 'text-red-400', calendar: 'text-primary', twitter: 'text-sky-300', notion: 'text-zinc-300',
};

// ── Permissions tab ───────────────────────────────────────────────────────────

// Compact table of all service permissions for the UI user
function UiPermissionsTable({ perms, onUpdate }: { perms: Permission[]; onUpdate: (service: string, field: keyof Permission, value: boolean) => void }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-secondary/10">
            <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground" rowSpan={2}>
              Service
            </th>
            <th
              className="w-[22%] px-3 py-1.5 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border"
              rowSpan={2}
              title="View messages, contacts, and data in the UI"
            >
              Read
            </th>
            <th
              className="w-[44%] px-3 py-1.5 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground border-l border-border"
              colSpan={2}
            >
              Send
            </th>
            <th
              className="w-[22%] px-3 py-1.5 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border border-l border-border"
              rowSpan={2}
              title="Opening a chat marks it as read via the platform API. Off = local-only read state."
            >
              Mark Read
            </th>
          </tr>
          <tr className="border-b border-border bg-secondary/10">
            <th
              className="px-3 py-1.5 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground border-l border-border border-t border-border"
              title="Create outbox items and initiate sends"
            >
              Enabled
            </th>
            <th
              className="px-3 py-1.5 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground/60 border-t border-border"
              title="All outgoing messages need manual confirmation before sending"
            >
              Req. Approval
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {perms.map((perm) => {
            const sendOff = !perm.sendEnabled;
            return (
              <tr key={perm.service} className="hover:bg-secondary/10 transition-colors">
                <td className={cn('px-4 py-2.5 text-xs font-medium', SVC_COLOR[perm.service] || 'text-foreground')}>
                  {SVC_LABEL[perm.service] || perm.service}
                </td>
                <td className="px-3 py-2.5 text-center">
                  <MiniToggle checked={!!perm.readEnabled} onChange={(v) => onUpdate(perm.service, 'readEnabled', v)} />
                </td>
                <td className="px-3 py-2.5 text-center border-l border-border">
                  <MiniToggle checked={!!perm.sendEnabled} onChange={(v) => onUpdate(perm.service, 'sendEnabled', v)} />
                </td>
                <td className={cn('px-3 py-2.5 text-center transition-opacity', sendOff && 'opacity-30')}>
                  <input
                    type="checkbox"
                    checked={!!perm.requireApproval}
                    onChange={(e) => !sendOff && onUpdate(perm.service, 'requireApproval', e.target.checked)}
                    disabled={sendOff}
                    className="w-3.5 h-3.5 rounded accent-primary cursor-pointer disabled:cursor-not-allowed"
                  />
                </td>
                <td className="px-3 py-2.5 text-center border-l border-border">
                  <MiniToggle checked={!!perm.markReadEnabled} onChange={(v) => onUpdate(perm.service, 'markReadEnabled', v)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PermissionsTab() {
  const qc = useQueryClient();
  const { data: perms } = useQuery({ queryKey: ['permissions'], queryFn: api.permissions });
  const [local, setLocal] = useState<Permission[]>([]);
  useEffect(() => { if (perms) setLocal([...perms]); }, [perms]);

  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const updatePerm = useMutation({
    mutationFn: ({ service, field, value }: { service: string; field: string; value: boolean }) =>
      api.updatePermission(service, { [field]: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions'] }),
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const handleUiPerm = (service: string, field: keyof Permission, value: boolean) => {
    const extra = field === 'requireApproval' ? { directSendFromUi: !value } : {};
    setLocal((p) => p.map((r) => r.service === service ? { ...r, [field]: value, ...extra } : r));
    updatePerm.mutate({ service, field, value });
    if (field === 'requireApproval') updatePerm.mutate({ service, field: 'directSendFromUi', value: !value });
  };

  const createKey = useMutation({
    mutationFn: () => api.createApiKey(newKeyName),
    onSuccess: (d) => { setNewKey(d.key || null); setNewKeyName(''); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const { data: keys = [] } = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const activeKeys = keys.filter((k) => !k.revokedAt);

  const copyKey = (v: string) => { navigator.clipboard.writeText(v); setCopiedKey(true); setTimeout(() => setCopiedKey(false), 2000); };

  const orderedPerms = ALL_SERVICES.map((svc) => local.find((p) => p.service === svc)).filter(Boolean) as Permission[];

  return (
    <div className="space-y-8">

      {/* ── UI User ── */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">You (UI)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Controls what you can do in the browser. These are also the defaults inherited by API keys.
          </p>
        </div>
        <UiPermissionsTable perms={orderedPerms} onUpdate={handleUiPerm} />
      </div>

      {/* ── API Keys ── */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">API Keys</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each key inherits the UI permissions above. Expand a key to set per-service overrides.
            </p>
          </div>
          {!creating && (
            <button onClick={() => setCreating(true)} className="btn-primary text-xs flex-shrink-0">
              <Plus className="w-3.5 h-3.5" /> New Key
            </button>
          )}
        </div>

        {/* Generate form */}
        {creating && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-border bg-secondary/20 p-4 space-y-3"
          >
            {newKey ? (
              <>
                <p className="text-sm font-semibold">Key generated</p>
                <div className="chip chip-amber text-xs w-fit">Copy now — will not be shown again</div>
                <div className="flex items-center gap-2 bg-secondary rounded-xl p-3 border border-border">
                  <code className="flex-1 text-xs font-mono text-emerald-400 break-all">{newKey}</code>
                  <button onClick={() => copyKey(newKey)} className="btn-ghost p-1.5 flex-shrink-0">
                    {copiedKey ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <button onClick={() => { setNewKey(null); setCreating(false); }} className="btn-primary text-xs">Done</button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold">Generate API key</p>
                <input
                  autoFocus value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Name — e.g. Claude, OpenClaw, Home Assistant"
                  className="input-warm"
                  onKeyDown={(e) => { if (e.key === 'Enter' && newKeyName.trim()) createKey.mutate(); }}
                />
                <div className="flex gap-2">
                  <button onClick={() => { setCreating(false); setNewKeyName(''); }} className="btn-secondary text-xs flex-1">Cancel</button>
                  <button onClick={() => createKey.mutate()} disabled={!newKeyName.trim() || createKey.isPending} className="btn-primary text-xs flex-1">
                    {createKey.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Generate
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}

        {/* Key list */}
        {activeKeys.length > 0 ? (
          <div className="space-y-2">
            {activeKeys.map((k) => <ApiKeyRow key={k.id} apiKey={k} />)}
          </div>
        ) : !creating && (
          <div className="flex flex-col items-center py-8 gap-2 text-muted-foreground border border-dashed border-border rounded-xl">
            <Key className="w-7 h-7 opacity-20" />
            <p className="text-sm">No API keys</p>
            <p className="text-xs opacity-50">Keys allow AI agents to access Conduit via the REST API</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Per-key expandable row with service-level permission overrides
function ApiKeyRow({ apiKey }: { apiKey: ApiKeyItem }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['key-permissions', apiKey.id],
    queryFn: () => api.keyPermissions(apiKey.id),
    enabled: expanded,
  });

  const update = useMutation({
    mutationFn: ({ service, field, value }: { service: string; field: string; value: boolean | null }) =>
      api.updateKeyPermission(apiKey.id, service, { [field]: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['key-permissions', apiKey.id] }),
  });

  const revoke = useMutation({
    mutationFn: () => api.revokeApiKey(apiKey.id),
    onSuccess: () => { toast({ title: 'API key revoked' }); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
  });

  const COLS: Array<{ key: 'readEnabled' | 'sendEnabled' | 'requireApproval'; label: string }> = [
    { key: 'readEnabled',     label: 'Read'     },
    { key: 'sendEnabled',     label: 'Send'     },
    { key: 'requireApproval', label: 'Approval' },
  ];

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-secondary/20">
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2.5 flex-1 text-left min-w-0">
          <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150', expanded && 'rotate-180')} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{apiKey.name}</span>
              <code className="chip chip-emerald font-mono text-[10px]">{apiKey.keyPrefix}…</code>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {apiKey.lastUsedAt ? `Last used ${timeAgo(apiKey.lastUsedAt)}` : 'Never used'}
            </p>
          </div>
        </button>
        <button onClick={() => revoke.mutate()} disabled={revoke.isPending} title="Revoke"
          className="p-1.5 rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ duration: 0.18 }}
            className="overflow-hidden border-t border-border"
          >
            {isLoading ? (
              <div className="flex items-center justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            ) : data ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-secondary/10">
                      <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Service</th>
                      {COLS.map((c) => (
                        <th key={c.key} className="px-4 py-2 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.permissions.map((perm) => (
                      <tr key={perm.service} className="hover:bg-secondary/10 transition-colors">
                        <td className={cn('px-4 py-2.5 text-xs font-medium', SVC_COLOR[perm.service] || 'text-foreground')}>
                          {SVC_LABEL[perm.service] || perm.service}
                        </td>
                        {COLS.map((c) => {
                          const isOverridden = perm.overrides[c.key] !== null;
                          return (
                            <td key={c.key} className="px-4 py-2.5 text-center">
                              <div className="flex flex-col items-center gap-0.5">
                                <MiniToggle
                                  checked={perm[c.key]}
                                  onChange={(v) => update.mutate({ service: perm.service, field: c.key, value: v })}
                                />
                                {isOverridden ? (
                                  <button onClick={() => update.mutate({ service: perm.service, field: c.key, value: null })}
                                    className="text-[9px] text-primary hover:underline leading-tight">reset</button>
                                ) : (
                                  <span className="text-[9px] text-muted-foreground/35 leading-tight">inherit</span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Install tab ───────────────────────────────────────────────────────────────

function InstallTab() {
  const [copied, setCopied] = useState(false);
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://your-server:3101';

  const snippet = `{
  "name": "Conduit",
  "description": "Personal messaging hub — read messages, manage email, calendar, and send requests across Slack, Discord, Telegram, Gmail, Twitter/X.",
  "api": {
    "type": "openapi",
    "url": "${baseUrl}/api/openapi.json"
  },
  "auth": {
    "type": "header",
    "header": "X-API-Key"
  }
}`;

  const copy = () => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Conduit as a Skill</h3>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
          Conduit exposes a full REST API that AI agents can use to read messages, manage email and calendar,
          send outbox requests, look up contacts, and explore Twitter. Generate an API key in the Permissions tab, then use the config below.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { name: 'OpenClaw', icon: '🦾', step: 'Settings → Skills → Add Custom Skill → paste the config' },
          { name: 'Claude Projects', icon: '🤖', step: 'Project → Add Tool → Custom Tool → enter the API URL and key' },
          { name: 'Any OpenAPI agent', icon: '⚡', step: 'Point to the spec URL and set X-API-Key in headers' },
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
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">Skill Config</p>
          <button onClick={copy} className="btn-ghost text-xs gap-1.5">
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="text-xs font-mono bg-secondary/40 border border-border rounded-xl px-4 py-3 overflow-x-auto text-foreground/75 leading-relaxed">
          {snippet}
        </pre>
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

// ── Security tab ──────────────────────────────────────────────────────────────

function SecurityTab() {
  const qc = useQueryClient();
  const { data: authConfig, isLoading } = useQuery({
    queryKey: ['ui-auth-config'],
    queryFn: uiAuth.config,
    staleTime: 10000,
  });

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [loginEnabled, setLoginEnabled] = useState(false);

  useEffect(() => {
    if (authConfig) setLoginEnabled(authConfig.enabled);
  }, [authConfig]);

  const saveConfig = useMutation({
    mutationFn: (body: Parameters<typeof uiAuth.updateConfig>[0]) => uiAuth.updateConfig(body),
    onSuccess: () => { toast({ title: 'Security settings saved', variant: 'success' }); qc.invalidateQueries({ queryKey: ['ui-auth-config'] }); setPassword(''); setConfirmPassword(''); setCurrentPassword(''); },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const setupTotp = useMutation({
    mutationFn: uiAuth.totpSetup,
    onSuccess: (data) => setTotpSetupData(data),
  });

  const verifyTotp = useMutation({
    mutationFn: () => uiAuth.totpVerify(totpCode),
    onSuccess: () => {
      toast({ title: '2FA enabled', variant: 'success' });
      setTotpSetupData(null); setTotpCode('');
      qc.invalidateQueries({ queryKey: ['ui-auth-config'] });
    },
    onError: (e: Error) => toast({ title: 'Invalid code', description: e.message, variant: 'destructive' }),
  });

  const disableTotp = useMutation({
    mutationFn: uiAuth.totpDisable,
    onSuccess: () => { toast({ title: '2FA disabled' }); qc.invalidateQueries({ queryKey: ['ui-auth-config'] }); },
  });

  const handleSavePassword = () => {
    if (password && password !== confirmPassword) {
      toast({ title: 'Passwords do not match', variant: 'destructive' }); return;
    }
    if (password && password.length < 8) {
      toast({ title: 'Password must be at least 8 characters', variant: 'destructive' }); return;
    }
    saveConfig.mutate({ password: password || undefined, currentPassword: currentPassword || undefined });
  };

  const handleToggleLogin = () => {
    if (!loginEnabled && !authConfig?.hasPassword && !password) {
      toast({ title: 'Set a password first', variant: 'destructive' }); return;
    }
    saveConfig.mutate({ enabled: !loginEnabled, password: password || undefined });
  };

  if (isLoading) return <div className="text-xs text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 max-w-lg">

      {/* Login toggle */}
      <div className="rounded-xl border border-border bg-secondary/20 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Password login</p>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {loginEnabled
                ? 'The UI requires a password to access. API keys are unaffected.'
                : 'The UI is accessible without login. Recommended only on private/local networks.'}
            </p>
          </div>
          <MiniToggle checked={loginEnabled} onChange={handleToggleLogin} />
        </div>
        {!authConfig?.hasPassword && !loginEnabled && (
          <p className="text-[11px] text-primary mt-3 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Set a password below before enabling login
          </p>
        )}
      </div>

      {/* Password */}
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold">{authConfig?.hasPassword ? 'Change password' : 'Set password'}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Minimum 8 characters</p>
        </div>

        {authConfig?.hasPassword && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Current password</label>
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Current password" className="input-warm pr-10 w-full" />
              <button type="button" onClick={() => setShowPw(!showPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">New password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="New password" className="input-warm w-full" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Confirm</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password" className="input-warm w-full"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSavePassword(); }} />
          </div>
        </div>

        <button onClick={handleSavePassword} disabled={saveConfig.isPending || (!password && !currentPassword)} className="btn-primary text-xs">
          {saveConfig.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          {authConfig?.hasPassword ? 'Update Password' : 'Set Password'}
        </button>
      </div>

      {/* 2FA */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className={cn('w-4 h-4', authConfig?.totpEnabled ? 'text-emerald-400' : 'text-muted-foreground')} />
              <p className="text-sm font-semibold">Two-factor authentication (TOTP)</p>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {authConfig?.totpEnabled ? 'Active — using an authenticator app' : 'Not enabled'}
            </p>
          </div>
          {authConfig?.totpEnabled ? (
            <button onClick={() => disableTotp.mutate()} disabled={disableTotp.isPending}
              className="btn-danger text-xs py-1.5 px-3">Disable</button>
          ) : !totpSetupData ? (
            <button onClick={() => setupTotp.mutate()} disabled={setupTotp.isPending || !authConfig?.hasPassword}
              className="btn-secondary text-xs py-1.5 px-3 gap-1.5">
              <QrCode className="w-3.5 h-3.5" /> Set up
            </button>
          ) : null}
        </div>

        {/* TOTP setup flow */}
        {totpSetupData && !authConfig?.totpEnabled && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-border bg-secondary/20 p-4 space-y-4"
          >
            <p className="text-sm font-semibold">Set up authenticator</p>
            <ol className="text-xs text-muted-foreground space-y-2 list-decimal pl-4">
              <li>Open your authenticator app (Google Authenticator, Authy, 1Password, etc.)</li>
              <li>Scan the QR code or enter the secret key manually</li>
              <li>Enter the 6-digit code below to confirm</li>
            </ol>

            {/* QR code via a public API — safe since it's just encoding the URI */}
            <div className="flex flex-col items-center gap-3 py-2">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(totpSetupData.otpauthUrl)}`}
                alt="TOTP QR code"
                className="w-40 h-40 rounded-xl border border-border bg-white p-1"
              />
              <div className="text-center">
                <p className="text-[10px] text-muted-foreground mb-1">Or enter manually:</p>
                <code className="text-xs font-mono bg-secondary/80 px-3 py-1 rounded-lg tracking-widest text-foreground/80">
                  {totpSetupData.secret}
                </code>
              </div>
            </div>

            <div className="space-y-2">
              <input
                type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="input-warm w-full text-center text-lg font-mono tracking-[0.4em]"
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={() => { setTotpSetupData(null); setTotpCode(''); }} className="btn-secondary text-xs flex-1">Cancel</button>
                <button onClick={() => verifyTotp.mutate()} disabled={totpCode.length !== 6 || verifyTotp.isPending} className="btn-primary text-xs flex-1">
                  {verifyTotp.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  Verify & Enable
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* Session info */}
      {loginEnabled && (
        <div className="rounded-xl border border-border bg-secondary/20 p-4 flex items-start gap-3">
          <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            Session lasts <span className="text-foreground font-medium">7 days</span> from last login.
            Logging out or changing the password immediately invalidates the current session.
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

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
              <span className={cn('w-1.5 h-1.5 rounded-full', gmailStatus === 'connected' ? 'bg-emerald-400' : gmailStatus === 'error' ? 'bg-red-400' : 'bg-warm-600')} />
              Gmail
            </span>
            <span className={cn('flex items-center gap-1', calStatus === 'connected' ? 'text-emerald-400' : calStatus === 'error' ? 'text-red-400' : '')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', calStatus === 'connected' ? 'bg-emerald-400' : calStatus === 'error' ? 'bg-red-400' : 'bg-warm-600')} />
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
              <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-secondary/20 overflow-x-auto">
                {GMAIL_SECTIONS.map(({ id, label, icon: Icon }) => (
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
                            <div className="h-0.5 bg-warm-700/60 rounded-full overflow-hidden ml-6">
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

function GoogleServicesAccordion() {
  const [open, setOpen] = useState(true);
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
    <motion.div layout className="rounded-2xl border border-border overflow-hidden">
      {/* Header */}
      <button onClick={() => setOpen(!open)} className={cn('w-full flex items-center gap-3 px-4 py-3 text-left transition-colors', open ? 'bg-card' : 'bg-card/50 hover:bg-card/80')}>
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
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform duration-200 flex-shrink-0', open && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className="border-t border-border bg-card p-4 space-y-3">

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
        )}
      </AnimatePresence>
    </motion.div>
  );
}

type TwitterSectionId = 'overview' | 'credentials' | 'permissions' | 'sync' | 'data';
const TWITTER_SECTIONS: Array<{ id: TwitterSectionId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview',     label: 'Overview',    icon: PlugZap  },
  { id: 'credentials', label: 'Credentials', icon: Key      },
  { id: 'permissions', label: 'Permissions', icon: Shield   },
  { id: 'sync',        label: 'Sync',        icon: Clock    },
  { id: 'data',        label: 'Data',        icon: Database },
];

function TwitterAccordion() {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<TwitterSectionId>('overview');
  const qc = useQueryClient();

  const { data: authStatus } = useQuery({ queryKey: ['twitter-auth-status'], queryFn: api.twitterAuthStatus, refetchInterval: 30000 });
  const connStatus = useConnectionStore((s) => s.statuses['twitter' as Service]);
  const syncProgress = useSyncStore((s) => s.progress['twitter']);
  const isRunning = syncProgress?.status === 'running';

  const status = connStatus?.status ?? (authStatus?.connected ? 'connected' : 'disconnected');

  // Credentials state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [twitterEmail, setTwitterEmail] = useState('');
  const [credsDirty, setCredsDirty] = useState(false);
  useEffect(() => { setCredsDirty(!!(username || password || twitterEmail)); }, [username, password, twitterEmail]);

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

  const connect = useMutation({
    mutationFn: () => api.twitterConnect(username, password, twitterEmail),
    onSuccess: (d) => {
      if (d.success) {
        toast({ title: `Connected as @${d.handle}`, variant: 'success' });
        qc.invalidateQueries({ queryKey: ['twitter-auth-status'] });
        qc.invalidateQueries({ queryKey: ['connections'] });
        setUsername(''); setPassword(''); setTwitterEmail('');
        setTimeout(runTest, 800);
      } else {
        toast({ title: 'Connection failed', description: d.error, variant: 'destructive' });
      }
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
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
    <motion.div layout className={cn('rounded-2xl border overflow-hidden transition-all duration-200', open ? 'border-border shadow-warm-md' : 'border-border/60 hover:border-border')}>
      {/* Header */}
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

      {/* Body */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className="border-t border-border bg-card">
              {/* Section nav */}
              <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-secondary/20 overflow-x-auto">
                {TWITTER_SECTIONS.map(({ id, label, icon: Icon }) => (
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
                            <div className="h-0.5 bg-warm-700/60 rounded-full overflow-hidden ml-6">
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
                              Connect (enter credentials)
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
                        <SectionHeader icon={Key} title="Credentials" subtitle="Your twitter.com login — no developer account or API key needed" />
                        <div className="space-y-3">
                          <TextField label="Twitter / X Username" value={username} onChange={(v) => setUsername(v)} placeholder="handle (without @)" />
                          <TextField label="Email Address" value={twitterEmail} onChange={(v) => setTwitterEmail(v)} placeholder="your@email.com" type="email" />
                          <SecretField label="Password" value={password} onChange={(v) => setPassword(v)} placeholder="••••••••" />
                        </div>
                        {authStatus?.handle && (
                          <p className="text-xs text-emerald-400 flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Currently connected as @{authStatus.handle}
                          </p>
                        )}
                        <button
                          onClick={() => connect.mutate()}
                          disabled={!username || !password || !twitterEmail || connect.isPending}
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

// ─────────────────────────────────────────────────────────────────────────────
// Notion Accordion
// ─────────────────────────────────────────────────────────────────────────────

type NotionSectionId = 'overview' | 'credentials' | 'permissions';
const NOTION_SECTIONS: Array<{ id: NotionSectionId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview',     label: 'Overview',    icon: PlugZap },
  { id: 'credentials', label: 'Credentials', icon: Key     },
  { id: 'permissions', label: 'Permissions', icon: Shield  },
];

function NotionAccordion() {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<NotionSectionId>('overview');
  const qc = useQueryClient();

  const connStatus = useConnectionStore((s) => s.statuses['notion' as Service]);
  const status = connStatus?.status ?? 'disconnected';

  // Credentials state
  const { data: raw } = useQuery({
    queryKey: ['credentials-raw', 'notion'],
    queryFn: () => api.credentialsRaw('notion'),
  });
  const [token, setToken] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [credsDirty, setCredsDirty] = useState(false);

  useEffect(() => {
    if (raw) {
      setToken('');  // keep token field empty; we never echo secrets back
      setWorkspaceName((raw as Record<string, string>).workspaceName || '');
    }
  }, [raw]);

  useEffect(() => {
    setCredsDirty(!!(token));
  }, [token]);

  // Test state
  const [testSteps, setTestSteps] = useState<TestStep[]>([]);
  const [testRunning, setTestRunning] = useState(false);

  const runTest = useCallback(async () => {
    setTestRunning(true);
    setTestSteps([]);
    try {
      const res = await fetch('/api/test/notion');
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

  const saveAndConnect = useMutation({
    mutationFn: async () => {
      // Save token first (only if a new one was typed), then connect
      const fields: Record<string, string> = { workspaceName };
      if (token) fields.token = token;
      await api.updateCredentials('notion', fields);
      const res = await fetch('/api/connections/notion/connect', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Notion connected', variant: 'success' });
      qc.invalidateQueries({ queryKey: ['credentials-raw', 'notion'] });
      qc.invalidateQueries({ queryKey: ['credentials'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      setToken('');
      setCredsDirty(false);
      setTimeout(runTest, 800);
    },
    onError: (e: Error) => toast({ title: 'Connection failed', description: e.message, variant: 'destructive' }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/connections/notion/disconnect', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Notion disconnected' });
      qc.invalidateQueries({ queryKey: ['connections'] });
      setTestSteps([]);
    },
    onError: (e: Error) => toast({ title: 'Disconnect failed', description: e.message, variant: 'destructive' }),
  });

  const allPassed = testSteps.length > 0 && testSteps.every((s) => s.status === 'success');
  const anyFailed = testSteps.some((s) => s.status === 'error');

  // Permissions
  const { data: perms } = useQuery({ queryKey: ['permissions'], queryFn: api.permissions });
  const perm = perms?.find((p) => p.service === 'notion');
  const [localPerm, setLocalPerm] = useState<Permission | null>(null);
  useEffect(() => { if (perm) setLocalPerm({ ...perm }); }, [perm]);

  const updatePerm = useMutation({
    mutationFn: (updates: Partial<Permission>) => api.updatePermission('notion', updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions'] }),
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <motion.div layout className={cn('rounded-2xl border overflow-hidden transition-all duration-200', open ? 'border-border shadow-warm-md' : 'border-border/60 hover:border-border')}>
      {/* Header */}
      <button onClick={() => setOpen(!open)} className={cn('w-full flex items-center gap-3 px-4 py-3 text-left transition-colors', open ? 'bg-card' : 'bg-card/50 hover:bg-card/80')}>
        <div className="w-10 h-10 rounded-xl bg-zinc-500/10 border border-zinc-500/20 flex items-center justify-center flex-shrink-0">
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-zinc-300" aria-hidden>
            <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-base font-semibold">Notion</h2>
            <StatusBadge status={status as 'connected'|'disconnected'|'connecting'|'error'} />
            {connStatus?.displayName && <span className="text-xs text-muted-foreground">{connStatus.displayName}</span>}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <span>Passthrough • no local sync</span>
            {!testRunning && testSteps.length > 0 && !open && (
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

      {/* Body */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className="border-t border-border bg-card">
              {/* Section nav */}
              <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-secondary/20 overflow-x-auto">
                {NOTION_SECTIONS.map(({ id, label, icon: Icon }) => (
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
                  <motion.div key={activeSection} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>

                    {/* ── Overview ─────────────────────────────────────────── */}
                    {activeSection === 'overview' && (
                      <div className="space-y-5">
                        <SectionHeader icon={PlugZap} title="Overview" subtitle="Passthrough integration — all operations run live against the Notion API, nothing is stored locally" />

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
                                <span className="chip chip-zinc text-[10px]">internal integration token</span>
                              </div>
                              {connStatus?.displayName && (
                                <div className="flex items-center gap-1.5 mt-1.5">
                                  <UserCircle2 className="w-3.5 h-3.5 text-muted-foreground" />
                                  <p className="text-xs text-muted-foreground">{connStatus.displayName}</p>
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

                        {/* Connect / Disconnect buttons */}
                        <div className="flex gap-2 flex-wrap">
                          {status !== 'connected' && (
                            <button
                              onClick={() => saveAndConnect.mutate()}
                              disabled={saveAndConnect.isPending}
                              className="btn-primary text-xs"
                            >
                              {saveAndConnect.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                              Connect
                            </button>
                          )}
                          {status === 'connected' && (
                            <button
                              onClick={() => disconnect.mutate()}
                              disabled={disconnect.isPending}
                              className="btn-secondary text-xs"
                            >
                              {disconnect.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unplug className="w-3.5 h-3.5" />}
                              Disconnect
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* ── Credentials ───────────────────────────────────────── */}
                    {activeSection === 'credentials' && (
                      <div className="space-y-5">
                        <SectionHeader icon={Key} title="Credentials" subtitle="Notion internal integration token stored locally in the database" />

                        <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-2.5 text-xs text-muted-foreground">
                          <p className="font-semibold text-foreground text-[13px]">How to get your Notion integration token</p>
                          <ol className="space-y-1.5 list-decimal list-inside marker:text-muted-foreground/50">
                            <li>Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer" className="text-primary hover:underline">notion.so/my-integrations</a> → click <strong className="text-foreground/80">+ New integration</strong></li>
                            <li>Give it a name, select your workspace, set <strong className="text-foreground/80">Type</strong> to <strong className="text-foreground/80">Internal</strong>, and click <strong className="text-foreground/80">Save</strong></li>
                            <li>Under <strong className="text-foreground/80">Capabilities</strong>, enable the permissions you need (Read content, Update content, Insert content)</li>
                            <li>Copy the <strong className="text-foreground/80">Internal Integration Secret</strong> (<code className="bg-secondary/80 px-1 rounded text-[10px]">secret_…</code>) and paste it below</li>
                            <li>Share each database or page you want to access with the integration via the <strong className="text-foreground/80">Share</strong> button in Notion</li>
                          </ol>
                        </div>

                        <div className="space-y-4">
                          <SecretField
                            label="Integration Secret (secret_…)"
                            value={token}
                            onChange={setToken}
                            placeholder="secret_..."
                            hint={raw && (raw as Record<string, string>).configured ? 'A token is already stored — paste a new one to replace it' : undefined}
                          />
                          <TextField
                            label="Workspace Name (optional)"
                            value={workspaceName}
                            onChange={setWorkspaceName}
                            placeholder="My Workspace"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => saveAndConnect.mutate()}
                              disabled={saveAndConnect.isPending || (!credsDirty && !workspaceName)}
                              className="btn-primary text-xs"
                            >
                              {saveAndConnect.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                              Save &amp; Connect
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── Permissions ───────────────────────────────────────── */}
                    {activeSection === 'permissions' && localPerm && (
                      <div className="space-y-5">
                        <SectionHeader icon={Shield} title="Permissions" subtitle="Control what Conduit can read and write in your Notion workspace" />
                        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
                          {([
                            { key: 'readEnabled' as const,      label: 'Read Access',         desc: 'Allow reading pages, databases, and blocks directly (bypasses outbox)' },
                            { key: 'sendEnabled' as const,       label: 'Write Access',        desc: 'Allow queuing create/update/append/archive operations to the outbox' },
                            { key: 'requireApproval' as const,   label: 'Require Approval',    desc: 'All write operations must be manually approved before executing. When off, operations from the Chat UI execute immediately.' },
                          ]).map(({ key, label, desc }) => (
                            <div key={key} className="px-4 bg-secondary/20">
                              <Toggle
                                checked={!!localPerm[key]}
                                onChange={(v) => {
                                  const extra = key === 'requireApproval' ? { directSendFromUi: !v } : {};
                                  setLocalPerm({ ...localPerm, [key]: v, ...extra });
                                  updatePerm.mutate({ [key]: v, ...extra });
                                }}
                                label={label}
                                description={desc}
                              />
                            </div>
                          ))}
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

// ─────────────────────────────────────────────────────────────────────────────
// AI Connection Tab
// ─────────────────────────────────────────────────────────────────────────────

function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <div className={cn(
          'flex-1 rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm overflow-x-auto whitespace-nowrap',
          mono ? 'font-mono text-primary/80' : 'text-foreground',
        )}>
          {value}
        </div>
        <button onClick={copy} className="btn-ghost p-2 flex-shrink-0" title="Copy">
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 border border-primary/25 flex items-center justify-center">
      <span className="text-[11px] font-bold text-primary">{n}</span>
    </div>
  );
}

// ─── AI Permissions Panel ─────────────────────────────────────────────────────

const READ_CHECKS: Array<{ key: 'readMessages' | 'readEmails' | 'readCalendar' | 'readContacts'; label: string }> = [
  { key: 'readMessages', label: 'Messages' },
  { key: 'readEmails',   label: 'Emails'   },
  { key: 'readCalendar', label: 'Calendar' },
  { key: 'readContacts', label: 'Contacts' },
];

function AiPermissionsPanel() {
  const qc = useQueryClient();

  const { data: perms, isLoading } = useQuery<AiPermissions>({
    queryKey: ['ai-permissions'],
    queryFn: api.aiPermissions,
    staleTime: 15000,
  });

  const [local, setLocal] = useState<AiPermissions | null>(null);
  useEffect(() => { if (perms) setLocal({ ...perms }); }, [perms]);

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<AiPermissions>) => api.updateAiPermissions(patch),
    onSuccess: (updated) => { setLocal(updated); qc.invalidateQueries({ queryKey: ['ai-permissions'] }); },
    onError: (e: Error) => toast({ title: 'Failed to save permission', description: e.message, variant: 'destructive' }),
  });

  const set = (patch: Partial<AiPermissions>) => {
    if (!local) return;
    if ('sendOutbox' in patch && !patch.sendOutbox) patch.requireApproval = true;
    setLocal((prev) => prev ? { ...prev, ...patch } : prev);
    updateMutation.mutate(patch);
  };

  if (isLoading || !local) {
    return <div className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>;
  }

  // Read access is "on" if any read sub-permission is enabled
  const anyRead = READ_CHECKS.some(({ key }) => local[key]);

  const toggleReadAll = (on: boolean) => {
    const patch = Object.fromEntries(READ_CHECKS.map(({ key }) => [key, on])) as Partial<AiPermissions>;
    set(patch);
  };

  return (
    <div className="rounded-xl border border-border bg-secondary/30 overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Shield className="w-3 h-3 text-muted-foreground" />
          <p className="text-xs font-semibold text-foreground">Permissions</p>
        </div>
        <p className="text-[10px] text-muted-foreground">Takes effect on next conversation</p>
      </div>

      {/* Read row */}
      <div className="divide-y divide-border">
        <div className="flex items-center gap-3 px-3 py-2">
          <p className="text-xs text-foreground/80 flex-shrink-0">Read access</p>
          {/* Checkboxes sit between label and toggle, fade in when read is on */}
          <div className="flex items-center gap-3 flex-1">
            <AnimatePresence initial={false}>
              {anyRead && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-3"
                >
                  {READ_CHECKS.map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={local[key]}
                        onChange={(e) => set({ [key]: e.target.checked })}
                        className="w-3 h-3 rounded accent-primary cursor-pointer"
                      />
                      <span className="text-[11px] text-muted-foreground">{label}</span>
                    </label>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <MiniToggle checked={anyRead} onChange={toggleReadAll} />
        </div>

        {/* Send row */}
        <div className="px-3 py-2 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-foreground/80">Queue messages for sending</p>
            <MiniToggle checked={local.sendOutbox} onChange={(v) => set({ sendOutbox: v })} />
          </div>
          <AnimatePresence initial={false}>
            {local.sendOutbox && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                <div className="flex items-center justify-between pl-1">
                  <p className="text-[11px] text-muted-foreground">Require approval before sending</p>
                  <MiniToggle checked={local.requireApproval} onChange={(v) => set({ requireApproval: v })} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

type AiSetupMethod = 'channel' | 'gateway' | 'cli' | 'other';

function AiConnectionTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [webhookUrl, setWebhookUrl] = useState('');
  const [shownApiKey, setShownApiKey] = useState<string | null>(null);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [method, setMethod] = useState<AiSetupMethod>('channel');

  const { data: conn, isLoading } = useQuery<AiConnection>({
    queryKey: ['ai-connection'],
    queryFn: api.aiConnection,
    staleTime: 10000,
  });

  const setupMutation = useMutation({
    mutationFn: (url: string) => api.setupAiConnection(url),
    onSuccess: (data) => {
      if (data.apiKey) setShownApiKey(data.apiKey);
      qc.invalidateQueries({ queryKey: ['ai-connection'] });
      toast({ title: 'AI connection saved', variant: 'success' });
    },
    onError: (err) => toast({ title: 'Setup failed', description: String(err), variant: 'destructive' }),
  });

  const handleTest = async () => {
    setTestState('testing');
    setTestError(null);
    try {
      const result = await api.testAiConnection();
      if (result.success) {
        setTestState('success');
        toast({ title: `Connection verified (${result.latencyMs}ms)`, variant: 'success' });
      } else {
        setTestState('error');
        setTestError(result.error ?? 'Unknown error');
      }
    } catch (e) {
      setTestState('error');
      setTestError(String(e));
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.disconnectAi();
      setShownApiKey(null);
      setTestState('idle');
      qc.invalidateQueries({ queryKey: ['ai-connection'] });
      toast({ title: 'AI connection removed' });
    } catch (e) {
      toast({ title: 'Failed to disconnect', description: String(e), variant: 'destructive' });
    } finally {
      setDisconnecting(false);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  const configured = conn?.configured ?? false;

  const methods: { id: AiSetupMethod; label: string; sub: string }[] = [
    { id: 'channel', label: 'OpenClaw Channel', sub: '@w3os/openclaw-conduit plugin' },
    { id: 'gateway', label: 'OpenClaw Gateway', sub: 'via webhooks plugin' },
    { id: 'cli',     label: 'OpenClaw CLI',     sub: 'direct session injection' },
    { id: 'other',   label: 'Other tools',       sub: 'n8n, custom scripts, etc.' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
          <Bot className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-sm font-semibold">AI Connection</h2>
            {configured ? (
              <span className="chip chip-emerald text-[10px]">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                Connected
              </span>
            ) : (
              <span className="chip chip-zinc text-[10px]">Not configured</span>
            )}
          </div>
          {configured && (
            <button onClick={() => navigate('/ai')} className="mt-2 inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors">
              Open AI Chat <ArrowRight className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* ── PERMISSIONS (always visible) ── */}
      <AiPermissionsPanel />

      {/* ── METHOD SELECTOR ── */}
      {!configured && (
        <div className="flex gap-2 flex-wrap">
          {methods.map((m) => (
            <button
              key={m.id}
              onClick={() => setMethod(m.id)}
              className={cn(
                'flex-1 min-w-[140px] rounded-xl border px-3 py-2.5 text-left transition-colors',
                method === m.id
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-border bg-secondary/20 text-muted-foreground hover:border-border/80 hover:bg-secondary/40',
              )}
            >
              <p className="text-xs font-semibold leading-tight">{m.label}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{m.sub}</p>
            </button>
          ))}
        </div>
      )}

      {/* ── SETUP FLOW ── */}
      {!configured ? (
        <div className="space-y-5">

          {/* ── Gateway (OpenClaw webhooks) ── */}
          {/* ── OpenClaw Channel plugin ── */}
          {method === 'channel' && (
            <div className="rounded-xl border border-border bg-secondary/30 divide-y divide-border">
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={1} />
                  <h3 className="text-sm font-semibold">Install the Conduit channel plugin</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80">{`openclaw plugins install @w3os/openclaw-conduit`}</pre>
                </div>
              </div>

              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={2} />
                  <h3 className="text-sm font-semibold">Generate a Conduit API key</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Go to <strong>Settings → Permissions</strong> and generate an API key. You will add it to your OpenClaw config in the next step.
                  </p>
                </div>
              </div>

              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={3} />
                  <h3 className="text-sm font-semibold">Add the channel config to OpenClaw</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Edit <code className="font-mono text-primary/70 text-[11px]">~/.openclaw/openclaw.json</code> and add:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80 leading-relaxed">{                   `{
  "channels": {
    "conduit": {
      "baseUrl": "${typeof window !== 'undefined' ? window.location.origin : 'http://your-conduit-host:3101'}",
      "apiKey": "<your sk-arb-... key from Step 2>",
      "allowFrom": [],
      "webhookSecret": "<optional shared secret>"
    }
  }
}`}</pre>
                  <p className="text-xs text-muted-foreground">
                    Restart the Gateway: <code className="font-mono text-primary/70 text-[11px]">openclaw gateway</code>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The plugin registers an inbound route at: <code className="font-mono text-primary/70 text-[11px]">http://&lt;openclaw-host&gt;:18789/channels/conduit/inbound</code>
                  </p>
                </div>
              </div>

              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={4} />
                  <h3 className="text-sm font-semibold">Enter the inbound URL and connect</h3>
                </div>
                <div className="pl-8 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Conduit will POST AI chat messages to this URL. If you set a <code className="font-mono text-primary/70 text-[11px]">webhookSecret</code> above, Conduit sends it as <code className="font-mono text-primary/70 text-[11px]">Authorization: Bearer &lt;secret&gt;</code>.
                  </p>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="http://localhost:18789/channels/conduit/inbound"
                    className="input-warm"
                  />
                  <button
                    onClick={() => setupMutation.mutate(webhookUrl)}
                    disabled={!webhookUrl.trim() || setupMutation.isPending}
                    className="btn-primary"
                  >
                    {setupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                    Connect
                  </button>
                </div>
              </div>
            </div>
          )}

          {method === 'gateway' && (
            <div className="rounded-xl border border-border bg-secondary/30 divide-y divide-border">
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={1} />
                  <h3 className="text-sm font-semibold">Enable the Webhooks plugin</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Edit <code className="font-mono text-primary/70 text-[11px]">~/.openclaw/openclaw.json</code> and add:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80 leading-relaxed">{`{
  "plugins": {
    "entries": {
      "webhooks": {
        "enabled": true,
        "config": {
          "routes": {
              "conduit": {
                "path": "/plugins/webhooks/conduit",
                "sessionKey": "agent:main:main",
                "secret": "YOUR_STRONG_SECRET_HERE",
                "description": "Conduit AI chat bridge"
            }
          }
        }
      }
    }
  }
}`}</pre>
                  <p className="text-xs text-muted-foreground">
                    Restart the Gateway: <code className="font-mono text-primary/70 text-[11px]">openclaw gateway</code>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Webhook URL (local): <code className="font-mono text-primary/70 text-[11px]">http://&lt;machine-ip&gt;:18789/plugins/webhooks/conduit</code>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Webhook URL (Tailscale Serve): <code className="font-mono text-primary/70 text-[11px]">https://&lt;magicdns&gt;/plugins/webhooks/conduit</code>
                  </p>
                </div>
              </div>

              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={2} />
                  <h3 className="text-sm font-semibold">Enter the webhook URL and connect</h3>
                </div>
                <div className="pl-8 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Conduit will send <code className="font-mono text-primary/70 text-[11px]">Authorization: Bearer &lt;secret&gt;</code> on every request.
                  </p>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="http://192.168.1.x:18789/plugins/webhooks/conduit"
                    className="input-warm"
                  />
                  <button
                    onClick={() => setupMutation.mutate(webhookUrl)}
                    disabled={!webhookUrl.trim() || setupMutation.isPending}
                    className="btn-primary"
                  >
                    {setupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                    Connect
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── CLI (direct session injection) ── */}
          {method === 'cli' && (
            <div className="rounded-xl border border-border bg-secondary/30 divide-y divide-border">
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={1} />
                  <h3 className="text-sm font-semibold">Generate an API key</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Go to <strong>Settings → Permissions</strong> and generate an API key. All CLI requests must include <code className="font-mono text-primary/70 text-[11px]">X-API-Key: &lt;your-key&gt;</code>.
                  </p>
                </div>
              </div>

              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={2} />
                  <h3 className="text-sm font-semibold">Enter a webhook URL and connect</h3>
                </div>
                <div className="pl-8 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Provide a URL that Conduit will POST new chat messages to. This can be a local HTTP server, a script, or any endpoint you control.
                  </p>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="http://localhost:8080/conduit-hook"
                    className="input-warm"
                  />
                  <button
                    onClick={() => setupMutation.mutate(webhookUrl)}
                    disabled={!webhookUrl.trim() || setupMutation.isPending}
                    className="btn-primary"
                  >
                    {setupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                    Connect
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={3} />
                  <h3 className="text-sm font-semibold">Handle incoming payloads and stream back</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Conduit POSTs JSON to your webhook URL on each message:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80 leading-relaxed">{`{
  "sessionId": "<uuid>",
  "streamUrl": "<baseUrl>/api/ai/sessions/<id>/stream",
  "messages": [{ "role": "user", "content": "..." }],
  "systemPrompt": "..."
}`}</pre>
                  <p className="text-xs text-muted-foreground">
                    Stream your response back by POSTing chunks to <code className="font-mono text-primary/70 text-[11px]">streamUrl</code>:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80 leading-relaxed">{`# First chunk — omit messageId, save the returned one
POST <streamUrl>
X-API-Key: <your-key>
{ "delta": "text chunk", "done": false }

# Subsequent chunks
{ "delta": "next chunk", "done": false, "messageId": "<returned-id>" }

# Final chunk
{ "delta": "", "done": true, "messageId": "<returned-id>" }`}</pre>
                </div>
              </div>
            </div>
          )}

          {/* ── Other tools ── */}
          {method === 'other' && (
            <div className="rounded-xl border border-border bg-secondary/30 divide-y divide-border">
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={1} />
                  <h3 className="text-sm font-semibold">Generate an API key</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Go to <strong>Settings → Permissions</strong> and generate an API key. Include it as <code className="font-mono text-primary/70 text-[11px]">X-API-Key: &lt;your-key&gt;</code> on every request.
                  </p>
                </div>
              </div>

              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={2} />
                  <h3 className="text-sm font-semibold">Point your tool at the OpenAPI spec</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    The full REST API is described at:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80">{`GET ${typeof window !== 'undefined' ? window.location.origin : '<baseUrl>'}/api/openapi.json`}</pre>
                  <p className="text-xs text-muted-foreground">
                    Configure your tool (n8n, Zapier, custom script, etc.) to use that spec URL and set <code className="font-mono text-primary/70 text-[11px]">X-API-Key</code> as an auth header.
                  </p>
                </div>
              </div>

              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={3} />
                  <h3 className="text-sm font-semibold">Register a webhook URL and connect</h3>
                </div>
                <div className="pl-8 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Provide the URL Conduit will POST AI chat messages to. Your tool must listen at that URL and stream responses back.
                  </p>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://your-tool.example.com/webhook"
                    className="input-warm"
                  />
                  <button
                    onClick={() => setupMutation.mutate(webhookUrl)}
                    disabled={!webhookUrl.trim() || setupMutation.isPending}
                    className="btn-primary"
                  >
                    {setupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                    Connect
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={4} />
                  <h3 className="text-sm font-semibold">Stream responses back</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Conduit POSTs this payload to your webhook on each message:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80 leading-relaxed">{`{
  "sessionId": "<uuid>",
  "streamUrl": "<baseUrl>/api/ai/sessions/<id>/stream",
  "messages": [{ "role": "user", "content": "..." }],
  "systemPrompt": "..."
}`}</pre>
                  <p className="text-xs text-muted-foreground">
                    POST token chunks to <code className="font-mono text-primary/70 text-[11px]">streamUrl</code> with <code className="font-mono text-primary/70 text-[11px]">X-API-Key</code>:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80 leading-relaxed">{`{ "delta": "text chunk", "done": false }              // first — save returned messageId
{ "delta": "next chunk", "done": false, "messageId": "<id>" }
{ "delta": "", "done": true,  "messageId": "<id>" }    // final`}</pre>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-5">

          {/* Shown-once API key banner */}
          {shownApiKey && (
            <div className="rounded-xl border border-primary/30 bg-primary/8 p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <Key className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-primary/90">Conduit API key — save it now</p>
                  <p className="text-xs text-primary/70 mt-0.5">Shown once. Add it to your agent or tool as <code className="font-mono text-[11px]">X-API-Key</code>.</p>
                </div>
              </div>
              <CopyField label="Conduit API Key" value={shownApiKey} />
            </div>
          )}

          {/* Connection details */}
          <div className="rounded-xl border border-border bg-secondary/30 divide-y divide-border">
            <div className="p-4 space-y-1.5">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Webhook URL</p>
              <p className="text-sm text-foreground font-mono break-all">{conn?.webhookUrl}</p>
            </div>
            <div className="p-4 space-y-1.5">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Conduit API Key</p>
              <p className="text-sm text-foreground font-mono">
                {conn?.keyPrefix}<span className="text-muted-foreground">••••••••••••••••••••••••••••••••••••</span>
              </p>
              <p className="text-[11px] text-muted-foreground">To rotate, disconnect and reconnect.</p>
            </div>
          </div>

          {/* Add Conduit skill to OpenClaw workspace */}
          {conn && (
            <div className="rounded-xl border border-border bg-secondary/30 divide-y divide-border">
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2.5">
                  <StepNumber n={3} />
                  <h3 className="text-sm font-semibold">Add the Conduit skill to your OpenClaw workspace</h3>
                </div>
                <div className="pl-8 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Create <code className="font-mono text-primary/70 text-[11px]">~/.openclaw/workspace/skills/conduit/SKILL.md</code>:
                  </p>
                  <pre className="text-[11px] font-mono bg-background border border-border rounded-xl p-3 overflow-x-auto text-foreground/80 leading-relaxed whitespace-pre-wrap break-all">{`---
name: conduit
description: Read the user's messages, emails, and calendar via Conduit, and stream responses back to the Conduit AI chat interface.
---

You have access to the Conduit API — a personal communications hub.

Base URL: ${conn.baseUrl}
API Key: <the key shown above>
OpenAPI spec: ${conn.openApiUrl}

Include X-API-Key: <key> on every request.

Key endpoints:
- GET /api/activity
- GET /api/messages?source=<platform>&chat_id=<id>
- GET /api/contacts
- GET /api/gmail/messages
- GET /api/calendar/events
- POST /api/outbox

Streaming responses back to Conduit:
POST chunks to: ${conn.streamUrlTemplate.replace('{sessionId}', '<sessionId from payload>')}

Body: { "delta": "text chunk", "done": false, "messageId": "<id>" }
- Omit messageId on the first chunk; use the returned ID on all subsequent chunks.
- Send { "done": true } on the final chunk.
- Always include X-API-Key: <key>.`}</pre>
                  <p className="text-xs text-muted-foreground">
                    Restart the Gateway: <code className="font-mono text-primary/70 text-[11px]">openclaw gateway</code>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Conduit endpoints */}
          {conn && (
            <div className="rounded-xl border border-border bg-secondary/30 divide-y divide-border">
              <div className="p-4 space-y-3">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Conduit endpoints</p>
                <CopyField label="Stream endpoint template" value={conn.streamUrlTemplate} />
                <CopyField label="OpenAPI spec URL" value={conn.openApiUrl} />
              </div>
            </div>
          )}

          {/* Test */}
          <div className="rounded-xl border border-border bg-secondary/30 p-4 space-y-3">
            <div className="flex items-center gap-2.5">
              <StepNumber n={4} />
              <h3 className="text-sm font-semibold">Test the connection</h3>
            </div>
            <p className="text-xs text-muted-foreground pl-8">
              Ensure your Gateway is running (<code className="font-mono text-primary/70 text-[11px]">openclaw gateway</code>), then send a test ping.
            </p>
            <div className="pl-8 flex items-center gap-3 flex-wrap">
              <button
                onClick={handleTest}
                disabled={testState === 'testing'}
                className="btn-secondary"
              >
                {testState === 'testing'
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <RefreshCw className="w-4 h-4" />}
                {testState === 'testing' ? 'Testing…' : 'Test connection'}
              </button>
              {testState === 'success' && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <CircleCheck className="w-4 h-4" /> Round-trip confirmed
                </span>
              )}
              {testState === 'error' && (
                <span className="flex items-center gap-1.5 text-xs text-red-400">
                  <CircleX className="w-4 h-4" /> {testError}
                </span>
              )}
            </div>
            {testState === 'success' && (
              <div className="pl-8">
                <button onClick={() => navigate('/ai')} className="btn-primary">
                  <Bot className="w-4 h-4" /> Open AI Chat
                </button>
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div className="rounded-xl border border-red-500/15 bg-red-500/5 p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">Disconnect AI</p>
              <p className="text-xs text-muted-foreground mt-0.5">Revokes the API key and clears the webhook URL. Chat sessions and messages are preserved.</p>
            </div>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="btn-danger flex-shrink-0"
            >
              {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unplug className="w-4 h-4" />}
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications Tab
// ─────────────────────────────────────────────────────────────────────────────

const SOUND_OPTIONS: Array<{ value: SoundStyle; label: string }> = [
  { value: 'default', label: 'Default ding' },
  { value: 'chime',   label: 'Chime' },
  { value: 'pop',     label: 'Pop' },
  { value: 'none',    label: 'None (silent)' },
];

function SoundSelect({ value, onChange }: { value: SoundStyle; onChange: (v: SoundStyle) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SoundStyle)}
      className="text-xs bg-secondary border border-border rounded-lg px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
    >
      {SOUND_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function NotificationsTab() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 30_000 });

  const raw = (settings?.notifications as { sounds?: NotificationSoundSettings } | undefined)?.sounds;
  const sounds: NotificationSoundSettings = raw ?? DEFAULT_SOUND_SETTINGS;

  const save = async (patch: Partial<NotificationSoundSettings>) => {
    const next = { ...sounds, ...patch };
    await api.updateSettings({ notifications: { sounds: next } });
    qc.invalidateQueries({ queryKey: ['settings'] });
    toast({ title: 'Sound settings saved', variant: 'success' });
  };

  const rows: Array<{ key: keyof Omit<NotificationSoundSettings, 'enabled'>; label: string; desc: string }> = [
    { key: 'message',  label: 'Chat messages',   desc: 'Discord, Slack, Telegram DMs and channel messages' },
    { key: 'email',    label: 'Email',            desc: 'New Gmail messages arriving in inbox' },
    { key: 'calendar', label: 'Calendar',         desc: 'New or updated calendar events' },
    { key: 'outbox',   label: 'Outbox',           desc: 'When a message is approved and sent' },
  ];

  return (
    <div className="space-y-5">
      {/* Master toggle */}
      <div className="flex items-center justify-between py-3 px-4 rounded-xl bg-secondary/40 border border-border/40">
        <div className="flex items-center gap-3">
          {sounds.enabled ? <Volume2 className="w-4 h-4 text-primary" /> : <VolumeX className="w-4 h-4 text-muted-foreground" />}
          <div>
            <p className="text-sm font-medium">Notification sounds</p>
            <p className="text-xs text-muted-foreground">Play a sound when new items arrive</p>
          </div>
        </div>
        <button
          onClick={() => save({ enabled: !sounds.enabled })}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none',
            sounds.enabled ? 'bg-primary' : 'bg-muted',
          )}
        >
          <span className={cn(
            'inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform',
            sounds.enabled ? 'translate-x-6' : 'translate-x-1',
          )} />
        </button>
      </div>

      {/* Per-type sound selection */}
      {sounds.enabled && (
        <div className="space-y-1">
          {rows.map(({ key, label, desc }) => (
            <div key={key} className="flex items-center gap-3 py-3 px-4 rounded-xl hover:bg-white/[0.02] transition-colors">
              <Bell className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
              <SoundSelect
                value={sounds[key]}
                onChange={(v) => save({ [key]: v })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Obsidian Vault Tab
// ─────────────────────────────────────────────────────────────────────────────

function ObsidianVaultTab() {
  const qc = useQueryClient();
  const connStatus = useConnectionStore((s) => s.statuses['obsidian']);
  const status = connStatus?.status ?? 'disconnected';

  const { data: configData, isLoading: configLoading, refetch: refetchConfig } = useQuery({
    queryKey: ['obsidian-config'],
    queryFn: () => api.obsidianConfig(),
    staleTime: 10000,
  });

  const vault = configData?.vault as ObsidianVaultConfigRow | undefined;
  const configured = configData?.configured ?? false;

  // Form state
  const [name, setName] = useState(vault?.name ?? '');
  const [remoteUrl, setRemoteUrl] = useState(vault?.remoteUrl ?? '');
  const [authType, setAuthType] = useState<'https' | 'ssh'>(vault?.authType ?? 'https');
  const [httpsToken, setHttpsToken] = useState('');
  const [branch, setBranch] = useState(vault?.branch ?? 'main');
  const [showToken, setShowToken] = useState(false);
  const [sshPublicKey, setSshPublicKey] = useState(vault?.sshPublicKey ?? '');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (vault) {
      setName(vault.name);
      setRemoteUrl(vault.remoteUrl);
      setAuthType(vault.authType);
      setBranch(vault.branch);
      setSshPublicKey(vault.sshPublicKey ?? '');
    }
  }, [vault]);

  const saveConfig = useMutation({
    mutationFn: () => api.saveObsidianConfig({
      name,
      remote_url: remoteUrl,
      auth_type: authType,
      https_token: httpsToken || undefined,
      branch,
    }),
    onSuccess: () => {
      toast({ title: 'Vault configuration saved' });
      refetchConfig();
      qc.invalidateQueries({ queryKey: ['obsidian-config'] });
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const cloneVault = useMutation({
    mutationFn: () => api.cloneObsidianVault(),
    onSuccess: () => {
      toast({ title: 'Clone started — this may take a moment' });
      setTimeout(() => {
        refetchConfig();
        qc.invalidateQueries({ queryKey: ['connections'] });
      }, 3000);
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const syncVault = useMutation({
    mutationFn: () => api.syncObsidianVault(),
    onSuccess: () => {
      toast({ title: 'Sync started' });
      setTimeout(() => refetchConfig(), 3000);
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const generateSshKey = useMutation({
    mutationFn: () => api.generateObsidianSshKey(),
    onSuccess: (data) => {
      setSshPublicKey(data.publicKey);
      toast({ title: 'SSH key generated. Add the public key to your git host.' });
      refetchConfig();
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const deleteVault = useMutation({
    mutationFn: () => api.deleteObsidianConfig(false),
    onSuccess: () => {
      toast({ title: 'Vault configuration removed' });
      refetchConfig();
      qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const copyPublicKey = () => {
    navigator.clipboard.writeText(sshPublicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (configLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status overview */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
          <BookOpen className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="text-sm font-semibold">{vault?.name || 'Obsidian Vault'}</h3>
            <StatusBadge status={status as 'connected'|'disconnected'|'connecting'|'error'} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 space-y-0.5">
            {vault?.lastSyncedAt && (
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                <span>Last synced {timeAgo(vault.lastSyncedAt)}</span>
              </div>
            )}
            {vault?.lastCommitHash && (
              <div className="flex items-center gap-1.5">
                <GitBranch className="w-3 h-3" />
                <span className="font-mono">{vault.lastCommitHash.slice(0, 8)}</span>
              </div>
            )}
            {vault?.syncError && (
              <div className="flex items-center gap-1.5 text-red-400">
                <XCircle className="w-3 h-3" />
                <span>{vault.syncError}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {configured && (
            <button
              onClick={() => syncVault.mutate()}
              disabled={syncVault.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', syncVault.isPending && 'animate-spin')} />
              Sync Now
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-muted-foreground">Vault Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-vault"
          className="input-warm"
        />
        <p className="text-[11px] text-muted-foreground/60">A short identifier. Used as the local folder name.</p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-muted-foreground">Remote URL</label>
        <input
          type="text"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://github.com/user/vault.git or git@github.com:user/vault.git"
          className="input-warm font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground/60">The git remote where your obsidian-git plugin pushes to.</p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-muted-foreground">Branch</label>
        <input
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          className="input-warm"
        />
      </div>

      {/* Auth type selector */}
      <div className="space-y-3">
        <label className="block text-xs font-medium text-muted-foreground">Authentication</label>
        <div className="flex gap-2">
          <button
            onClick={() => setAuthType('https')}
            className={cn(
              'flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all',
              authType === 'https'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'border-white/10 text-muted-foreground hover:border-white/20',
            )}
          >
            HTTPS / Token
          </button>
          <button
            onClick={() => setAuthType('ssh')}
            className={cn(
              'flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all',
              authType === 'ssh'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'border-white/10 text-muted-foreground hover:border-white/20',
            )}
          >
            SSH Key
          </button>
        </div>

        {authType === 'https' && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">Personal Access Token</label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={httpsToken}
                onChange={(e) => setHttpsToken(e.target.value)}
                placeholder={vault?.hasHttpsToken ? '••••••••••••••••' : 'ghp_...'}
                className="input-warm pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              {vault?.hasHttpsToken ? 'A token is already saved. Enter a new one to replace it.' : 'Create a GitHub/GitLab PAT with repo read/write scope.'}
            </p>
          </div>
        )}

        {authType === 'ssh' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-medium text-muted-foreground">SSH Public Key</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => generateSshKey.mutate()}
                    disabled={generateSshKey.isPending}
                    className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80"
                  >
                    {generateSshKey.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    Generate new key
                  </button>
                  {sshPublicKey && (
                    <button
                      onClick={copyPublicKey}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
              </div>
              {sshPublicKey ? (
                <textarea
                  readOnly
                  value={sshPublicKey}
                  rows={3}
                  className="w-full bg-black/20 border border-white/10 rounded-xl p-3 text-[11px] font-mono text-foreground/60 resize-none focus:outline-none"
                />
              ) : (
                <div className="bg-black/20 border border-white/10 rounded-xl p-3 text-xs text-muted-foreground text-center">
                  No SSH key generated yet. Click "Generate new key" above.
                </div>
              )}
              <p className="text-[11px] text-muted-foreground/60">
                Add this public key to your GitHub/GitLab deploy keys (read + write access).
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Save */}
      <div className="flex gap-2">
        <button
          onClick={() => saveConfig.mutate()}
          disabled={saveConfig.isPending || !name || !remoteUrl}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saveConfig.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          Save Configuration
        </button>
        {configured && !cloneVault.isPending && status !== 'connected' && (
          <button
            onClick={() => cloneVault.mutate()}
            disabled={cloneVault.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 text-sm font-medium hover:bg-white/5 transition-colors"
          >
            {cloneVault.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
            Clone Vault
          </button>
        )}
        {configured && status === 'connected' && (
          <a href="/vault" className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 text-sm font-medium hover:bg-white/5 transition-colors">
            <BookOpen className="w-4 h-4" />
            Open Vault
          </a>
        )}
      </div>

      {/* Danger zone */}
      {configured && (
        <div className="border border-red-500/20 rounded-xl p-4 space-y-3">
          <h4 className="text-xs font-semibold text-red-400">Danger Zone</h4>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-foreground">Remove vault configuration</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Removes the config from Conduit. The local clone is kept on disk.</p>
            </div>
            <button
              onClick={() => deleteVault.mutate()}
              disabled={deleteVault.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
            >
              {deleteVault.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

// Legacy connection tab IDs that now live under the 'connections' tab — kept in
// VALID_TABS so old /settings/<id> URLs redirect gracefully instead of 404-ing.
type ConnectionSubTabId = 'messaging' | 'email-calendar' | 'ai' | 'vault' | 'install';
type TopTabId = 'connections' | 'permissions' | 'notifications' | 'security' | 'appearance';
type TabId = TopTabId | 'settings' | ConnectionSubTabId; // 'settings' kept for backward-compat

const VALID_TABS = new Set<TabId>([
  'connections', 'permissions', 'notifications', 'security', 'appearance',
  // legacy / backward-compat aliases that map → 'connections'
  'messaging', 'email-calendar', 'ai', 'vault', 'install', 'settings',
]);

// Sub-tabs shown inside the Connections section
const CONNECTION_SUB_TABS: { id: ConnectionSubTabId; label: string; icon: React.ElementType }[] = [
  { id: 'messaging',      label: 'Messaging', icon: MessageSquareIcon },
  { id: 'email-calendar', label: 'Google',    icon: MailIcon },
  { id: 'ai',             label: 'AI',        icon: Bot },
  { id: 'vault',          label: 'Vault',     icon: FileText },
  { id: 'install',        label: 'Install',   icon: Zap },
];

// Map legacy connection tab ids to the top-level 'connections' tab so that old
// bookmarks / redirects still land on the right top-level section.
const LEGACY_TO_TOP: Partial<Record<TabId, TopTabId>> = {
  messaging: 'connections',
  'email-calendar': 'connections',
  ai: 'connections',
  vault: 'connections',
  install: 'connections',
  settings: 'permissions',
};

// Map legacy connection tab ids to their connection sub-tab equivalent.
const LEGACY_TO_SUB: Partial<Record<TabId, ConnectionSubTabId>> = {
  messaging: 'messaging',
  'email-calendar': 'email-calendar',
  ai: 'ai',
  vault: 'vault',
  install: 'install',
};

export default function Connections() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { tab } = useParams<{ tab: string }>();
  const setAllStatuses = useConnectionStore((s) => s.setAllStatuses);
  const seedFromActiveSyncs = useSyncStore((s) => s.seedFromActiveSyncs);
  const syncProgress = useSyncStore((s) => s.progress);

  // Resolve the URL param → a valid top-level tab, falling back to 'connections'.
  const resolvedTopTab: TopTabId = (() => {
    if (!tab || !VALID_TABS.has(tab as TabId)) return 'connections';
    const mapped = LEGACY_TO_TOP[tab as TabId];
    if (mapped) return mapped;
    return tab as TopTabId;
  })();

  const [activeTab, setActiveTabState] = React.useState<TopTabId>(resolvedTopTab);
  const setActiveTab = (id: TopTabId) => {
    setActiveTabState(id);
    navigate(`/settings/${id}`, { replace: true });
  };

  // Connection sub-tab state — initialise from legacy URL param if present.
  const initialSubTab: ConnectionSubTabId = LEGACY_TO_SUB[tab as TabId] ?? 'messaging';
  const [activeConnTab, setActiveConnTab] = React.useState<ConnectionSubTabId>(initialSubTab);

  const anyRunning = Object.values(syncProgress).some((p) => p?.status === 'running');

  const { data: connections } = useQuery({
    queryKey: ['connections'],
    queryFn: api.connections,
    refetchInterval: 8000,
  });

  // Page-level status poll — always active regardless of which accordion is open.
  // Fast-polls when any sync is running so counts update live across all services.
  const { data: statusData } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: anyRunning ? 2000 : 15000,
  });

  // Seed sync store from DB-persisted active syncs — runs for every service
  // regardless of accordion state, so Discord/Telegram show up correctly.
  useEffect(() => {
    if (statusData?.activeSyncs) {
      seedFromActiveSyncs(statusData.activeSyncs);
    }
  }, [statusData?.activeSyncs, seedFromActiveSyncs]);

  useEffect(() => {
    if (connections) setAllStatuses(connections);
  }, [connections, setAllStatuses]);

  return (
    <div className="p-4 space-y-3 animate-fade-in max-w-4xl mx-auto overflow-y-auto h-full">
      {/* Top-level tab switcher */}
      <div className="flex items-center gap-0.5 bg-secondary border border-border rounded-xl p-1 flex-wrap">
        {([
          { id: 'connections',   label: 'Connections',  icon: PlugZap },
          { id: 'permissions',   label: 'Permissions',  icon: Shield },
          { id: 'notifications', label: 'Notifications', icon: Bell },
          { id: 'security',      label: 'Security',     icon: Lock },
          { id: 'appearance',    label: 'Appearance',   icon: Palette },
        ] as const).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap',
              activeTab === id ? 'bg-background text-foreground shadow-warm-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}
          className="space-y-3"
        >
          {activeTab === 'connections' && (
            <>
              {/* Connection sub-tab bar */}
              <div className="flex items-center gap-0.5 border border-border rounded-lg p-0.5 self-start w-fit">
                {CONNECTION_SUB_TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveConnTab(id)}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap',
                      activeConnTab === id
                        ? 'bg-background text-foreground shadow-warm-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Connection sub-tab content */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeConnTab}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.12 }}
                  className="space-y-3"
                >
                  {activeConnTab === 'messaging' && (
                    <>
                      {SERVICES.map((svc) => (
                        <ServiceAccordion key={svc} service={svc} />
                      ))}
                      <TwitterAccordion />
                      <NotionAccordion />
                    </>
                  )}
                  {activeConnTab === 'email-calendar' && (
                    <GoogleServicesAccordion />
                  )}
                  {activeConnTab === 'ai' && (
                    <div className="card-warm overflow-hidden">
                      <div className="px-4 py-3 border-b border-border bg-secondary/20">
                        <h2 className="text-sm font-semibold">AI Connection</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">Connect an AI agent like OpenClaw to the Conduit chat</p>
                      </div>
                      <div className="p-4"><AiConnectionTab /></div>
                    </div>
                  )}
                  {activeConnTab === 'vault' && (
                    <div className="card-warm overflow-hidden">
                      <div className="px-4 py-3 border-b border-border bg-secondary/20">
                        <h2 className="text-sm font-semibold">Obsidian Vault</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">Connect a git-synced Obsidian vault for AI-assisted note reading and editing</p>
                      </div>
                      <div className="p-4"><ObsidianVaultTab /></div>
                    </div>
                  )}
                  {activeConnTab === 'install' && (
                    <div className="card-warm overflow-hidden">
                      <div className="px-4 py-3 border-b border-border bg-secondary/20">
                        <h2 className="text-sm font-semibold">Install as a Skill</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">Connect Conduit to your AI agent</p>
                      </div>
                      <div className="p-4"><InstallTab /></div>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </>
          )}
          {activeTab === 'permissions' && (
            <div className="card-warm overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-secondary/20">
                <h2 className="text-sm font-semibold">Permissions</h2>
                <p className="text-xs text-muted-foreground mt-0.5">What you and each API key can do per service</p>
              </div>
              <div className="p-4"><PermissionsTab /></div>
            </div>
          )}
          {activeTab === 'notifications' && (
            <div className="card-warm overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-secondary/20">
                <h2 className="text-sm font-semibold">Notifications &amp; Sounds</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Configure notification sounds for each event type</p>
              </div>
              <div className="p-4"><NotificationsTab /></div>
            </div>
          )}
          {activeTab === 'security' && (
            <div className="card-warm overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-secondary/20">
                <h2 className="text-sm font-semibold">Security</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Password login and two-factor authentication</p>
              </div>
              <div className="p-4"><SecurityTab /></div>
            </div>
          )}
          {activeTab === 'appearance' && (
            <div className="card-warm overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-secondary/20">
                <h2 className="text-sm font-semibold">Appearance</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Customize the look and feel of the interface</p>
              </div>
              <div className="p-4 max-w-lg"><AppearanceTab /></div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
