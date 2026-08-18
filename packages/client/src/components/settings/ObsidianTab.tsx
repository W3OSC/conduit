import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Eye, EyeOff, RefreshCw, Loader2, CheckCircle2, XCircle, Key, Plus, Copy, Check, Trash2,
  ExternalLink, BookOpen, GitBranch, Play, RotateCcw, Fingerprint,
} from 'lucide-react';
import {
  api, type ObsidianVaultConfigRow,
} from '@/lib/api';
import { useConnectionStore } from '@/store';
import { cn, timeAgo, copyToClipboard } from '@/lib/utils';
import { toast } from '@/store';

// ─────────────────────────────────────────────────────────────────────────────
// Obsidian Files Tab — multi-vault list + detail panel
// ─────────────────────────────────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferDeployKeyUrl(remoteUrl: string): { platform: 'github' | 'gitlab' | null; url: string | null } {
  try {
    const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) {
      const host = sshMatch[1];
      const repoPath = sshMatch[2];
      if (host.includes('github')) return { platform: 'github', url: `https://github.com/${repoPath}/settings/keys` };
      if (host.includes('gitlab')) return { platform: 'gitlab', url: `https://gitlab.com/${repoPath}/-/settings/repository#js-deploy-keys-settings` };
      return { platform: null, url: null };
    }
    const url = new URL(remoteUrl);
    const repoPath = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (url.hostname.includes('github')) return { platform: 'github', url: `https://github.com/${repoPath}/settings/keys` };
    if (url.hostname.includes('gitlab')) return { platform: 'gitlab', url: `https://gitlab.com/${repoPath}/-/settings/repository#js-deploy-keys-settings` };
    return { platform: null, url: null };
  } catch {
    return { platform: null, url: null };
  }
}

const CLONE_PHASES = [
  { key: 'connecting', label: 'Connecting' },
  { key: 'cloning', label: 'Cloning' },
  { key: 'resolving', label: 'Resolving objects' },
  { key: 'finalizing', label: 'Finalizing' },
];

// ── Per-vault detail panel ────────────────────────────────────────────────────

function VaultDetailPanel({ vault, onDeleted }: { vault: ObsidianVaultConfigRow; onDeleted: () => void }) {
  const qc = useQueryClient();
  const vaultId = vault.id;

  // Live connection status for this specific vault from the WS store
  const allStatuses = useConnectionStore((s) => s.statuses);
  const vaultStatusKey = `obsidian:${vaultId}` as keyof typeof allStatuses;
  const connStatus = (allStatuses[vaultStatusKey] as { status: string; mode?: string; error?: string; phase?: string } | undefined)
    ?? vault.connectionStatus;
  const status = (connStatus?.status ?? 'disconnected') as string;
  const clonePhase = (connStatus as { phase?: string } | undefined)?.phase ?? null;

  const [cloneInitiated, setCloneInitiated] = useState(false);
  useEffect(() => {
    if (status === 'connected' || status === 'error') setCloneInitiated(false);
  }, [status]);

  const seededVaultIdRef = useRef<number | null>(null);
  const [name, setName] = useState(vault.name);
  const [remoteUrl, setRemoteUrl] = useState(vault.remoteUrl);
  const [authType, setAuthType] = useState<'https' | 'ssh'>(vault.authType);
  const [httpsToken, setHttpsToken] = useState('');
  const [branch, setBranch] = useState(vault.branch);
  const [showToken, setShowToken] = useState(false);
  const [sshPublicKey, setSshPublicKey] = useState(vault.sshPublicKey ?? '');
  const [sshFingerprint, setSshFingerprint] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Re-seed when switching to a different vault
  useEffect(() => {
    if (vault.id !== seededVaultIdRef.current) {
      seededVaultIdRef.current = vault.id;
      setName(vault.name);
      setRemoteUrl(vault.remoteUrl);
      setAuthType(vault.authType);
      setBranch(vault.branch);
      setSshPublicKey(vault.sshPublicKey ?? '');
      setHttpsToken('');
      setTestResult(null);
      setSshFingerprint(null);
    }
  }, [vault]);

  useEffect(() => {
    if (vault.hasSshPrivateKey && !sshFingerprint) {
      api.getObsidianSshFingerprint(vaultId).then((r) => setSshFingerprint(r.fingerprint)).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.hasSshPrivateKey, vaultId]);

  const { data: syncData, refetch: refetchSync } = useQuery({
    queryKey: ['obsidian-sync-status', vaultId],
    queryFn: () => api.obsidianSyncStatus(vaultId),
    staleTime: 10000,
    refetchInterval: 15000,
  });

  const saveConfig = useMutation({
    mutationFn: () => api.updateObsidianVault(vaultId, {
      name,
      remote_url: remoteUrl,
      auth_type: authType,
      https_token: httpsToken || undefined,
      branch,
    }),
    onSuccess: () => {
      toast({ title: 'Configuration saved' });
      setTestResult(null);
      setHttpsToken('');
      qc.invalidateQueries({ queryKey: ['obsidian-vaults'] });
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const testConnection = useMutation({
    mutationFn: () => api.testObsidianConnection(vaultId),
    onSuccess: (data) => setTestResult(data),
    onError: (e: Error) => setTestResult({ success: false, error: e.message }),
  });

  const cloneVault = useMutation({
    mutationFn: () => api.cloneObsidianVault(vaultId),
    onSuccess: () => {
      setCloneInitiated(true);
      setTimeout(() => qc.invalidateQueries({ queryKey: ['obsidian-vaults'] }), 3000);
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const syncVault = useMutation({
    mutationFn: () => api.syncObsidianVault(vaultId),
    onSuccess: () => {
      toast({ title: 'Sync started' });
      setTimeout(() => { refetchSync(); qc.invalidateQueries({ queryKey: ['obsidian-vaults'] }); }, 3000);
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const generateSshKey = useMutation({
    mutationFn: () => api.generateObsidianSshKey(vaultId),
    onSuccess: (data) => {
      setSshPublicKey(data.publicKey);
      setSshFingerprint(data.fingerprint ?? null);
      setTestResult(null);
      toast({ title: 'SSH key generated' });
      qc.invalidateQueries({ queryKey: ['obsidian-vaults'] });
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const deleteVault = useMutation({
    mutationFn: () => api.deleteObsidianVault(vaultId, false),
    onSuccess: () => {
      toast({ title: 'Vault removed' });
      qc.invalidateQueries({ queryKey: ['obsidian-vaults'] });
      onDeleted();
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  const copyPublicKey = () => {
    copyToClipboard(sshPublicKey).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  };

  const deployKeyInfo = inferDeployKeyUrl(remoteUrl);

  const hasUnsavedChanges = (
    name !== vault.name ||
    remoteUrl !== vault.remoteUrl ||
    authType !== vault.authType ||
    branch !== vault.branch ||
    httpsToken !== ''
  );

  const isCloning = cloneInitiated || (status === 'connecting' && clonePhase != null);
  const currentPhaseIndex = clonePhase
    ? CLONE_PHASES.findIndex((p) => p.key === clonePhase)
    : (isCloning ? 0 : -1);

  return (
    <div className="space-y-0">
      {/* Section 1: Repository */}
      <div className="space-y-4 pb-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex-shrink-0">1</span>
          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Repository</h4>
        </div>
        <div className="space-y-3 pl-7">
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted-foreground">Vault Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-vault" className="input-warm" />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted-foreground">Branch</label>
              <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="input-warm w-28" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">Remote URL</label>
            <input
              type="text"
              value={remoteUrl}
              onChange={(e) => { setRemoteUrl(e.target.value); setTestResult(null); }}
              placeholder="https://github.com/user/vault.git or git@github.com:user/vault.git"
              className="input-warm font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground/60">The git remote your obsidian-git plugin syncs to.</p>
          </div>
        </div>
      </div>

      <div className="border-t border-white/5 mb-5" />

      {/* Section 2: Authentication */}
      <div className="space-y-4 pb-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex-shrink-0">2</span>
          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Authentication</h4>
        </div>
        <div className="space-y-3 pl-7">
          <div className="flex gap-2">
            <button
              onClick={() => {
                setAuthType('https');
                setTestResult(null);
                const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
                if (sshMatch) setRemoteUrl(`https://${sshMatch[1]}/${sshMatch[2]}.git`);
              }}
              className={cn('flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all',
                authType === 'https' ? 'bg-primary/10 border-primary/30 text-primary' : 'border-white/10 text-muted-foreground hover:border-white/20')}
            >HTTPS / Token</button>
            <button
              onClick={() => {
                setAuthType('ssh');
                setTestResult(null);
                try {
                  if (remoteUrl.startsWith('http')) {
                    const u = new URL(remoteUrl);
                    setRemoteUrl(`git@${u.hostname}:${u.pathname.replace(/^\//, '').replace(/\.git$/, '')}.git`);
                  }
                } catch { /* leave as-is */ }
              }}
              className={cn('flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all',
                authType === 'ssh' ? 'bg-primary/10 border-primary/30 text-primary' : 'border-white/10 text-muted-foreground hover:border-white/20')}
            >SSH Key</button>
          </div>

          {authType === 'https' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted-foreground">Personal Access Token</label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={httpsToken}
                  onChange={(e) => { setHttpsToken(e.target.value); setTestResult(null); }}
                  placeholder={vault.hasHttpsToken ? '••••••••••••••••' : 'ghp_...'}
                  className="input-warm pr-10 font-mono"
                />
                <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground/60">
                {vault.hasHttpsToken ? 'A token is already saved. Enter a new one to replace it.' : 'Create a GitHub/GitLab PAT with repo read/write scope.'}
              </p>
            </div>
          )}

          {authType === 'ssh' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-muted-foreground">SSH Public Key</label>
                  <button onClick={() => generateSshKey.mutate()} disabled={generateSshKey.isPending}
                    className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 transition-colors">
                    {generateSshKey.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    {sshPublicKey ? 'Regenerate key' : 'Generate key'}
                  </button>
                </div>
                {sshPublicKey ? (
                  <div className="space-y-1.5">
                    <div className="relative group">
                      <textarea readOnly value={sshPublicKey} rows={2}
                        className="w-full bg-black/20 border border-white/10 rounded-xl p-3 pr-10 text-[11px] font-mono text-foreground/60 resize-none focus:outline-none" />
                      <button onClick={copyPublicKey} className="absolute right-2.5 top-2.5 p-1 rounded-lg bg-white/5 hover:bg-white/10 transition-colors" title="Copy public key">
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
                      </button>
                    </div>
                    {sshFingerprint && <p className="text-[11px] font-mono text-muted-foreground/60 px-1 select-all">Fingerprint: {sshFingerprint}</p>}
                  </div>
                ) : (
                  <div className="bg-black/20 border border-dashed border-white/10 rounded-xl p-4 text-xs text-muted-foreground text-center">No SSH key generated yet.</div>
                )}
              </div>
              {sshPublicKey && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
                  <p className="text-xs font-medium text-amber-400/90">Add this key to your git host</p>
                  <ol className="text-[11px] text-muted-foreground space-y-1 list-decimal list-inside">
                    <li>Copy the public key above</li>
                    <li>
                      {deployKeyInfo.url ? (
                        <a href={deployKeyInfo.url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 underline underline-offset-2 transition-colors">
                          Open {deployKeyInfo.platform === 'github' ? 'GitHub' : 'GitLab'} deploy keys
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      ) : (
                        <a href="https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys"
                          target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                          Open your repository&apos;s deploy keys settings<ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </li>
                    <li>Add the key with <span className="font-medium text-foreground/80">read &amp; write</span> access</li>
                    <li>Come back and test the connection below</li>
                  </ol>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => saveConfig.mutate()}
              disabled={saveConfig.isPending || !name || !remoteUrl || !hasUnsavedChanges}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saveConfig.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {hasUnsavedChanges ? 'Save Changes' : 'Saved'}
            </button>
            {!hasUnsavedChanges && (
              <button onClick={() => testConnection.mutate()} disabled={testConnection.isPending}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors disabled:opacity-50">
                {testConnection.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : testResult?.success ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  : testResult?.success === false ? <XCircle className="w-3.5 h-3.5 text-red-400" />
                  : <Play className="w-3.5 h-3.5" />}
                Test Connection
              </button>
            )}
          </div>

          {testResult && (
            <div className={cn('flex items-start gap-2 p-3 rounded-xl text-xs',
              testResult.success ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/20 text-red-400')}>
              {testResult.success ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
              <span>{testResult.success ? 'Repository is accessible. Ready to clone.' : testResult.error ?? 'Connection failed.'}</span>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-white/5 mb-5" />

      {/* Section 3: Connect */}
      <div className="space-y-4 pb-5">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold flex-shrink-0',
            status === 'connected' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-primary/15 text-primary')}>3</span>
          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Connect</h4>
          {status === 'connected' && (
            <span className="text-[10px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full ml-1">Connected</span>
          )}
        </div>
        <div className="pl-7">
          {isCloning ? (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary flex-shrink-0" />
                <span className="text-sm font-medium text-foreground">Cloning vault...</span>
              </div>
              <div className="space-y-2">
                {CLONE_PHASES.map((phase, index) => {
                  const isDone = currentPhaseIndex > index;
                  const isCurrent = currentPhaseIndex === index;
                  return (
                    <div key={phase.key} className={cn('flex items-center gap-2.5 text-xs transition-colors',
                      isDone ? 'text-emerald-400' : isCurrent ? 'text-foreground' : 'text-muted-foreground/40')}>
                      {isDone ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                        : isCurrent ? <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin text-primary" />
                        : <div className="w-3.5 h-3.5 flex-shrink-0 rounded-full border border-white/15" />}
                      <span className={isCurrent ? 'font-medium' : ''}>{phase.label}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground/60">This may take a minute for large vaults.</p>
            </div>
          ) : status === 'connected' ? (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    <span className="text-sm font-medium text-foreground">{vault.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground pl-6">
                    {syncData?.lastSyncedAt && (
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                        Synced {timeAgo(syncData.lastSyncedAt)}
                      </span>
                    )}
                    {syncData?.lastCommitHash && (
                      <span className="flex items-center gap-1 font-mono">
                        <GitBranch className="w-2.5 h-2.5" />
                        {syncData.lastCommitHash.slice(0, 8)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => syncVault.mutate()} disabled={syncVault.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors disabled:opacity-50">
                    <RefreshCw className={cn('w-3 h-3', syncVault.isPending && 'animate-spin')} />
                    Sync Now
                  </button>
                  <a href="/files" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20 text-xs font-medium text-primary hover:bg-primary/15 transition-colors">
                    <BookOpen className="w-3 h-3" />
                    Open Files
                  </a>
                </div>
              </div>
              {vault.syncError && (
                <div className="flex items-start gap-1.5 text-[11px] text-red-400 pt-1 border-t border-white/5">
                  <XCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                  <span>Last sync error: {vault.syncError}</span>
                </div>
              )}
            </div>
          ) : status === 'error' ? (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
              <div className="flex items-start gap-2">
                <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1 flex-1">
                  <p className="text-sm font-medium text-foreground">Connection failed</p>
                  {(connStatus as { error?: string } | undefined)?.error && (
                    <p className="text-[11px] text-red-400/80 font-mono">{(connStatus as { error?: string }).error}</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setCloneInitiated(true); cloneVault.mutate(); }} disabled={cloneVault.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
                  <RotateCcw className="w-3 h-3" />
                  Retry Clone
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-white/8 bg-white/3 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <GitBranch className="w-4 h-4 text-primary" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">Ready to clone</p>
                  <p className="text-[11px] text-muted-foreground">Conduit will clone your repository locally and keep it in sync every 5 minutes.</p>
                </div>
              </div>
              <button
                onClick={() => { setCloneInitiated(true); cloneVault.mutate(); }}
                disabled={cloneVault.isPending || hasUnsavedChanges}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                title={hasUnsavedChanges ? 'Save your configuration changes first' : undefined}
              >
                <GitBranch className="w-4 h-4" />
                Clone Vault
              </button>
              {hasUnsavedChanges && <p className="text-[11px] text-amber-400/80">Save your configuration changes before cloning.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Danger zone */}
      <div className="border-t border-white/5 mb-5" />
      <div className="border border-red-500/20 rounded-xl p-4 space-y-3">
        <h4 className="text-xs font-semibold text-red-400">Danger Zone</h4>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-foreground">Remove this vault</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Removes config from Conduit. The local clone is kept on disk.</p>
          </div>
          <button onClick={() => deleteVault.mutate()} disabled={deleteVault.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-xs text-red-400 hover:bg-red-500/10 transition-colors">
            {deleteVault.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// ── New vault form ─────────────────────────────────────────────────────────────

function NewVaultForm({ onCreated }: { onCreated: (vault: ObsidianVaultConfigRow) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [authType, setAuthType] = useState<'https' | 'ssh'>('https');
  const [httpsToken, setHttpsToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  const createVault = useMutation({
    mutationFn: () => api.createObsidianVault({
      name,
      remote_url: remoteUrl,
      auth_type: authType,
      https_token: httpsToken || undefined,
      branch,
    }),
    onSuccess: (data) => {
      toast({ title: `Vault "${data.vault.name}" created` });
      qc.invalidateQueries({ queryKey: ['obsidian-vaults'] });
      onCreated(data.vault);
    },
    onError: (e: Error) => toast({ title: e.message }),
  });

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">Vault Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-vault" className="input-warm" />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">Branch</label>
            <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="input-warm w-28" />
          </div>
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
        </div>
        <div className="flex gap-2">
          <button onClick={() => setAuthType('https')}
            className={cn('flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all',
              authType === 'https' ? 'bg-primary/10 border-primary/30 text-primary' : 'border-white/10 text-muted-foreground hover:border-white/20')}>
            HTTPS / Token
          </button>
          <button onClick={() => setAuthType('ssh')}
            className={cn('flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all',
              authType === 'ssh' ? 'bg-primary/10 border-primary/30 text-primary' : 'border-white/10 text-muted-foreground hover:border-white/20')}>
            SSH Key
          </button>
        </div>
        {authType === 'https' && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">Personal Access Token</label>
            <div className="relative">
              <input type={showToken ? 'text' : 'password'} value={httpsToken} onChange={(e) => setHttpsToken(e.target.value)}
                placeholder="ghp_..." className="input-warm pr-10 font-mono" />
              <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        )}
        {authType === 'ssh' && (
          <p className="text-[11px] text-muted-foreground/60 px-1">Save the vault first, then generate an SSH key in the vault&apos;s detail panel.</p>
        )}
      </div>
      <button
        onClick={() => createVault.mutate()}
        disabled={createVault.isPending || !name || !remoteUrl}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {createVault.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
        Add Vault
      </button>
    </div>
  );
}

// ── Main ObsidianFilesTab ─────────────────────────────────────────────────────

export function ObsidianVaultTab() {
  const { data: vaultsData, isLoading } = useQuery({
    queryKey: ['obsidian-vaults'],
    queryFn: () => api.listObsidianVaults(),
    staleTime: 10000,
  });

  const vaults = vaultsData?.vaults ?? [];
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);

  // Auto-select first vault or 'new' when data loads
  useEffect(() => {
    if (!isLoading && selectedId === null) {
      setSelectedId(vaults.length > 0 ? vaults[0].id : 'new');
    }
  }, [isLoading, vaults, selectedId]);

  const selectedVault = selectedId !== null && selectedId !== 'new'
    ? vaults.find((v) => v.id === selectedId) ?? null
    : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex gap-0 min-h-[420px]">
      {/* Left: vault list */}
      <div className="w-48 flex-shrink-0 border-r border-white/8 flex flex-col">
        <div className="px-3 py-2 border-b border-white/8 flex items-center justify-between">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Vaults</span>
          <button
            onClick={() => setSelectedId('new')}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
            title="Add vault"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {vaults.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground italic">No vaults yet</p>
          )}
          {vaults.map((vault) => {
            const connSt = vault.connectionStatus?.status ?? 'disconnected';
            const isSelected = selectedId === vault.id;
            return (
              <button
                key={vault.id}
                onClick={() => setSelectedId(vault.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                  isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-white/5',
                )}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0',
                  connSt === 'connected' ? 'bg-emerald-500' : connSt === 'error' ? 'bg-red-500' : connSt === 'connecting' ? 'bg-amber-500' : 'bg-muted-foreground/30'
                )} />
                <span className="truncate font-medium">{vault.name}</span>
              </button>
            );
          })}
        </div>
        <div className="border-t border-white/8 p-2">
          <button
            onClick={() => setSelectedId('new')}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors',
              selectedId === 'new' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
            )}
          >
            <Plus className="w-3.5 h-3.5 flex-shrink-0" />
            Add Vault
          </button>
        </div>
      </div>

      {/* Right: detail / new form */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedId === 'new' && (
          <NewVaultForm
            onCreated={(vault) => setSelectedId(vault.id)}
          />
        )}
        {selectedVault && (
          <div className="p-4">
            <VaultDetailPanel
              key={selectedVault.id}
              vault={selectedVault}
              onDeleted={() => setSelectedId(vaults.length > 1 ? vaults.find((v) => v.id !== selectedVault.id)?.id ?? 'new' : 'new')}
            />
          </div>
        )}
        {selectedId !== 'new' && !selectedVault && vaults.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
            <BookOpen className="w-8 h-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No vaults configured. Click Add Vault to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
