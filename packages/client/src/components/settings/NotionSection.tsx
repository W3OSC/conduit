import React, { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, RefreshCw, Loader2, CheckCircle2, XCircle, AlertTriangle, Key, Copy, Shield,
  PlugZap, UserCircle2, Unplug,
} from 'lucide-react';
import {
  api, type Permission,
} from '@/lib/api';
import { useConnectionStore } from '@/store';
import { StatusBadge } from '@/components/shared/StatusDot';
import { cn } from '@/lib/utils';
import { toast } from '@/store';
import { SectionHeader, SectionTabs, SecretField, TextField, Toggle } from './shared';
import { type Service, type TestStep } from './ChatServiceAccordions';

// ─────────────────────────────────────────────────────────────────────────────
// Notion Accordion
// ─────────────────────────────────────────────────────────────────────────────

type NotionSectionId = 'overview' | 'credentials' | 'permissions';
const NOTION_SECTIONS: Array<{ id: NotionSectionId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview',     label: 'Overview',    icon: PlugZap },
  { id: 'credentials', label: 'Credentials', icon: Key     },
  { id: 'permissions', label: 'Permissions', icon: Shield  },
];

export function NotionAccordion() {
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
  const [savedWorkspaceName, setSavedWorkspaceName] = useState('');

  useEffect(() => {
    if (raw) {
      setToken('');  // keep token field empty; we never echo secrets back
      const wn = (raw as Record<string, string>).workspaceName || '';
      setWorkspaceName(wn);
      setSavedWorkspaceName(wn);
    }
  }, [raw]);

  // The raw endpoint returns the bare creds object (no `configured` flag) —
  // use the redacted /credentials view, which computes it server-side.
  const { data: credInfo } = useQuery({ queryKey: ['credentials'], queryFn: api.credentials });
  const tokenConfigured = !!credInfo?.notion?.configured;
  const credsDirty = !!(token) || workspaceName !== savedWorkspaceName;

  // Until a token is saved, Credentials is the only usable section.
  const needsCredentials = credInfo ? !credInfo.notion?.configured : false;
  useEffect(() => {
    if (needsCredentials) setActiveSection('credentials');
  }, [needsCredentials]);

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
      setSavedWorkspaceName(workspaceName);
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
              <SectionTabs
                sections={NOTION_SECTIONS}
                active={activeSection}
                onSelect={setActiveSection}
                disabledIds={needsCredentials ? NOTION_SECTIONS.filter((s) => s.id !== 'credentials').map((s) => s.id) : undefined}
                disabledTitle="Save credentials first"
              />

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
                            placeholder={tokenConfigured ? '••••••••••••••••••••••••' : 'secret_...'}
                            hint={tokenConfigured ? 'An integration secret is already stored — paste a new one to replace it' : undefined}
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
                              disabled={saveAndConnect.isPending || !credsDirty}
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
