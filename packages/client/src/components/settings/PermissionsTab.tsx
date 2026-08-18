import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Loader2, Key, Plus, Copy, Check, Send,
} from 'lucide-react';
import {
  api, type Permission,
} from '@/lib/api';
import { ServiceLogo } from '@/components/shared/ServiceBadge';
import { cn, copyToClipboard } from '@/lib/utils';
import { toast } from '@/store';
import { MiniToggle, SVC_LABEL, SVC_COLOR } from './shared';
import { type Service } from './ChatServiceAccordions';
import { ApiKeyRow } from './ApiKeysPanel';

// ─────────────────────────────────────────────────────────────────────────────
// Permissions tab + Install tab + Security tab
// ─────────────────────────────────────────────────────────────────────────────

const ALL_SERVICES = ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter', 'notion', 'obsidian', 'smb'] as const;

const PERM_COLS: Array<{ key: 'readEnabled' | 'sendEnabled' | 'requireApproval'; label: string; description: string }> = [
  { key: 'readEnabled',     label: 'Read',     description: 'Can read messages and data' },
  { key: 'sendEnabled',     label: 'Send',     description: 'Can create outbox items / send messages' },
  { key: 'requireApproval', label: 'Approval', description: 'All sends require manual approval' },
];

function MiniCheckbox({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative w-5 h-5 rounded-md transition-all duration-200 flex-shrink-0 flex items-center justify-center',
        checked ? 'bg-primary shadow-amber' : 'bg-muted-foreground/30',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      {checked && (
        <svg viewBox="0 0 10 8" fill="none" className="w-2.5 h-2.5">
          <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

// ── Permissions tab ───────────────────────────────────────────────────────────

// ── UiPermissionsCards ────────────────────────────────────────────────────────
// Simplified UI user permissions — outbox/direct-send toggle per service.
// UI user is unrestricted on read/send.

function UiPermissionsCards({
  perms,
  onUpdate,
}: {
  perms: Permission[];
  onUpdate: (service: string, field: keyof Permission, value: boolean) => void;
}) {
  return (
    <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
      {perms.map((perm) => {
        const directSend = !perm.requireApproval;
        return (
          <div key={perm.service} className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/10 transition-colors">
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <ServiceLogo service={perm.service} className="w-4 h-4 flex-shrink-0" />
              <span className={cn('text-sm font-medium', SVC_COLOR[perm.service] || 'text-foreground')}>
                {SVC_LABEL[perm.service] || perm.service}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
              <MiniToggle
                checked={directSend}
                onChange={(v) => {
                  onUpdate(perm.service, 'requireApproval', !v);
                  onUpdate(perm.service, 'directSendFromUi', v);
                }}
              />
              <span className="text-[9px] text-muted-foreground/50 leading-tight">
                {directSend ? 'direct send' : 'via outbox'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Compact table of all service permissions for the UI user (legacy - kept as reference)
function UiPermissionsTable({ perms, onUpdate }: { perms: Permission[]; onUpdate: (service: string, field: keyof Permission, value: boolean) => void }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-secondary/10">
            <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground" rowSpan={2}>
              Service
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
                  <div className="flex items-center gap-2">
                    <ServiceLogo service={perm.service} className="w-3.5 h-3.5 flex-shrink-0" />
                    {SVC_LABEL[perm.service] || perm.service}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-center">
                  <MiniToggle checked={!!perm.readEnabled} onChange={(v) => onUpdate(perm.service, 'readEnabled', v)} />
                </td>
                <td className="px-3 py-2.5 text-center border-l border-border">
                  <MiniToggle checked={!!perm.sendEnabled} onChange={(v) => onUpdate(perm.service, 'sendEnabled', v)} />
                </td>
                <td className={cn('px-3 py-2.5 text-center transition-opacity', sendOff && 'opacity-30')}>
                  <div className="flex justify-center">
                    <MiniCheckbox checked={!!perm.requireApproval} onChange={(v) => onUpdate(perm.service, 'requireApproval', v)} disabled={sendOff} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PermissionsTab() {
  const qc = useQueryClient();
  const { data: perms } = useQuery({ queryKey: ['permissions'], queryFn: api.permissions });
  const [local, setLocal] = useState<Permission[]>([]);
  useEffect(() => { if (perms) setLocal([...perms]); }, [perms]);

  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const updatePerm = useMutation({
    mutationFn: ({ service, updates }: { service: string; updates: Partial<Permission> }) =>
      api.updatePermission(service, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions'] }),
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const handleUiPerm = (service: string, field: keyof Permission, value: boolean) => {
    // If toggling outbox/direct-send, update both fields together
    if (field === 'requireApproval') {
      setLocal((p) => p.map((r) => r.service === service ? { ...r, requireApproval: value, directSendFromUi: !value } : r));
      updatePerm.mutate({ service, updates: { requireApproval: value, directSendFromUi: !value } });
    } else {
      setLocal((p) => p.map((r) => r.service === service ? { ...r, [field]: value } : r));
      updatePerm.mutate({ service, updates: { [field]: value } });
    }
  };

  const createKey = useMutation({
    mutationFn: () => api.createApiKey(newKeyName),
    onSuccess: (d) => { setNewKey(d.key || null); setNewKeyName(''); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const { data: keys = [] } = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const activeKeys = keys.filter((k) => !k.revokedAt);

  const copyKey = (v: string) => { copyToClipboard(v).then(() => { setCopiedKey(true); setTimeout(() => setCopiedKey(false), 2000); }).catch(() => {}); };

  const orderedPerms = ALL_SERVICES.map((svc) => local.find((p) => p.service === svc)).filter(Boolean) as Permission[];

  return (
    <div className="space-y-10">

      {/* ── UI User ─────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">You (UI)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Browser controls. The UI has full read and send access — configure whether writes go through the outbox for approval or are sent directly.
          </p>
        </div>
        <UiPermissionsCards perms={orderedPerms} onUpdate={handleUiPerm} />
      </div>

      {/* ── API Keys ─────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">API Keys</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each key inherits UI defaults. Expand a key to override per-service access, then expand a service for fine-grained channel, label, or resource filters.
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
                  placeholder="Name — e.g. my-assistant, automation"
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
