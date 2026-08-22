import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Eye, EyeOff, Loader2, Plus, Check, Trash2, Server, PlugZap, Unplug, Play,
} from 'lucide-react';
import {
  api, type SmbShareRow,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/store';

// ─────────────────────────────────────────────────────────────────────────────
// SMB Shares Tab — multi-share list + detail panel
// ─────────────────────────────────────────────────────────────────────────────

// ── Per-share detail panel ────────────────────────────────────────────────────

function SmbShareDetailPanel({ share, onDeleted }: { share: SmbShareRow; onDeleted: () => void }) {
  const qc = useQueryClient();
  const shareId = share.id;

  const connStatus = share.connectionStatus;
  const isConnected = connStatus?.status === 'connected';
  const isConnecting = connStatus?.status === 'connecting';

  const [name, setName] = useState(share.name);
  const [host, setHost] = useState(share.host);
  const [sharePath, setSharePath] = useState(share.share);
  const [domain, setDomain] = useState(share.domain ?? '');
  const [username, setUsername] = useState(share.username);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const seededRef = useRef<number | null>(null);

  useEffect(() => {
    if (share.id !== seededRef.current) {
      seededRef.current = share.id;
      setName(share.name);
      setHost(share.host);
      setSharePath(share.share);
      setDomain(share.domain ?? '');
      setUsername(share.username);
      setPassword('');
    }
  }, [share]);

  const hasUnsavedChanges =
    name !== share.name ||
    host !== share.host ||
    sharePath !== share.share ||
    domain !== (share.domain ?? '') ||
    username !== share.username ||
    password !== '';

  const saveShare = useMutation({
    mutationFn: () => api.updateSmbShare(shareId, {
      name, host, share: sharePath,
      domain: domain || null,
      username,
      ...(password ? { password } : {}),
    }),
    onSuccess: () => {
      toast({ title: 'Share saved' });
      setPassword('');
      qc.invalidateQueries({ queryKey: ['smb-shares'] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const testShare = useMutation({
    mutationFn: () => api.testSmbShare(shareId),
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: 'Connection successful', description: `Reached \\\\${share.host}\\${share.share}` });
      } else {
        toast({ title: 'Connection failed', description: data.error ?? 'Unknown error', variant: 'destructive' });
      }
    },
    onError: (e: Error) => toast({ title: 'Test failed', description: e.message, variant: 'destructive' }),
  });

  const connectShare = useMutation({
    mutationFn: () => api.connectSmbShare(shareId),
    onSuccess: () => {
      toast({ title: 'Connected' });
      qc.invalidateQueries({ queryKey: ['smb-shares'] });
    },
    onError: (e: Error) => toast({ title: 'Connect failed', description: e.message, variant: 'destructive' }),
  });

  const disconnectShare = useMutation({
    mutationFn: () => api.disconnectSmbShare(shareId),
    onSuccess: () => {
      toast({ title: 'Disconnected' });
      qc.invalidateQueries({ queryKey: ['smb-shares'] });
    },
  });

  const deleteShare = useMutation({
    mutationFn: () => api.deleteSmbShare(shareId),
    onSuccess: () => {
      toast({ title: 'Share removed' });
      qc.invalidateQueries({ queryKey: ['smb-shares'] });
      onDeleted();
    },
    onError: (e: Error) => toast({ title: 'Delete failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-5 p-4">
      {/* Connection status row */}
      <div className="flex items-center gap-3">
        <span className={cn('w-2 h-2 rounded-full flex-shrink-0',
          isConnected ? 'bg-emerald-500' : isConnecting ? 'bg-amber-500 animate-pulse' : connStatus?.status === 'error' ? 'bg-red-500' : 'bg-muted-foreground/30',
        )} />
        <span className="text-xs text-muted-foreground capitalize">
          {connStatus?.status ?? 'disconnected'}
          {connStatus?.error && ` — ${connStatus.error}`}
        </span>
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => testShare.mutate()}
            disabled={testShare.isPending || hasUnsavedChanges}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {testShare.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Test
          </button>
          {isConnected ? (
            <button
              onClick={() => disconnectShare.mutate()}
              disabled={disconnectShare.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              {disconnectShare.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unplug className="w-3 h-3" />}
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => connectShare.mutate()}
              disabled={connectShare.isPending || isConnecting || hasUnsavedChanges}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {connectShare.isPending || isConnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlugZap className="w-3 h-3" />}
              Connect
            </button>
          )}
        </div>
      </div>

      {/* Fields */}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Display Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="NAS Documents" className="input-warm" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Host / IP</label>
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" className="input-warm font-mono" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Share Name</label>
          <input type="text" value={sharePath} onChange={(e) => setSharePath(e.target.value)} placeholder="documents" className="input-warm font-mono" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Domain <span className="text-muted-foreground/50">(optional)</span></label>
          <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="WORKGROUP" className="input-warm font-mono" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Username</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="user" className="input-warm font-mono" />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Password {share.hasPassword && <span className="text-muted-foreground/50">(enter to replace)</span>}</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={share.hasPassword ? '••••••••••••••••' : 'password'}
              className="input-warm pr-10 font-mono"
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Actions row */}
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={() => deleteShare.mutate()}
          disabled={deleteShare.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
        >
          {deleteShare.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          Remove
        </button>
        <button
          onClick={() => saveShare.mutate()}
          disabled={saveShare.isPending || !hasUnsavedChanges}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saveShare.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save
        </button>
      </div>
    </div>
  );
}

// ── New share form ────────────────────────────────────────────────────────────

function NewSmbShareForm({ onCreated }: { onCreated: (share: SmbShareRow) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [sharePath, setSharePath] = useState('');
  const [domain, setDomain] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const createShare = useMutation({
    mutationFn: () => api.createSmbShare({ name, host, share: sharePath, domain: domain || null, username, password }),
    onSuccess: (data) => {
      toast({ title: `Share "${data.name}" added` });
      qc.invalidateQueries({ queryKey: ['smb-shares'] });
      onCreated(data);
    },
    onError: (e: Error) => toast({ title: 'Failed to add share', description: e.message, variant: 'destructive' }),
  });

  const canSubmit = name && host && sharePath && username && password;

  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">Configure a new SMB / Windows file share connection.</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Display Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="NAS Documents" className="input-warm" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Host / IP</label>
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" className="input-warm font-mono" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Share Name</label>
          <input type="text" value={sharePath} onChange={(e) => setSharePath(e.target.value)} placeholder="documents" className="input-warm font-mono" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Domain <span className="text-muted-foreground/50">(optional)</span></label>
          <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="WORKGROUP" className="input-warm font-mono" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Username</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="user" className="input-warm font-mono" />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Password</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              className="input-warm pr-10 font-mono"
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
      <button
        onClick={() => createShare.mutate()}
        disabled={createShare.isPending || !canSubmit}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {createShare.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
        Add Share
      </button>
    </div>
  );
}

// ── Main SmbSharesTab ─────────────────────────────────────────────────────────

export function SmbSharesTab() {
  const { data: sharesData, isLoading } = useQuery({
    queryKey: ['smb-shares'],
    queryFn: () => api.listSmbShares(),
    staleTime: 10000,
  });

  const shares = sharesData?.shares ?? [];
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);

  useEffect(() => {
    if (!isLoading && selectedId === null) {
      setSelectedId(shares.length > 0 ? shares[0].id : 'new');
    }
  }, [isLoading, shares, selectedId]);

  const selectedShare = selectedId !== null && selectedId !== 'new'
    ? shares.find((s) => s.id === selectedId) ?? null
    : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex gap-0 min-h-[320px]">
      {/* Left: share list */}
      <div className="w-48 flex-shrink-0 border-r border-border flex flex-col">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Shares</span>
          <button
            onClick={() => setSelectedId('new')}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            title="Add share"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {shares.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground italic">No shares yet</p>
          )}
          {shares.map((s) => {
            const connSt = s.connectionStatus?.status ?? 'disconnected';
            const isSelected = selectedId === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                  isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary/60',
                )}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0',
                  connSt === 'connected' ? 'bg-emerald-500' : connSt === 'error' ? 'bg-red-500' : connSt === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-muted-foreground/30',
                )} />
                <span className="truncate font-medium">{s.name}</span>
              </button>
            );
          })}
        </div>
        <div className="border-t border-border p-2">
          <button
            onClick={() => setSelectedId('new')}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors',
              selectedId === 'new' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <Plus className="w-3.5 h-3.5 flex-shrink-0" />
            Add Share
          </button>
        </div>
      </div>

      {/* Right: detail / new form */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedId === 'new' && (
          <NewSmbShareForm onCreated={(s) => setSelectedId(s.id)} />
        )}
        {selectedShare && (
          <SmbShareDetailPanel
            key={selectedShare.id}
            share={selectedShare}
            onDeleted={() => setSelectedId(shares.length > 1 ? shares.find((s) => s.id !== selectedShare.id)?.id ?? 'new' : 'new')}
          />
        )}
        {selectedId !== 'new' && !selectedShare && shares.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
            <Server className="w-8 h-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No shares configured. Click Add Share to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
