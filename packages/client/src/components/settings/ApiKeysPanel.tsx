import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, Loader2, Key, Plus, Copy, Check, Trash2, X, Send, PlugZap, SlidersHorizontal,
  Search, Filter,
} from 'lucide-react';
import {
  api, type ApiKeyItem, type KeyServicePerm, type ConnectionStatus, type ServiceFineGrained,
  type SlackFineGrained, type DiscordFineGrained, type TelegramFineGrained, type GmailFineGrained,
  type CalendarFineGrained, type TwitterFineGrained, type NotionFineGrained,
  type ObsidianFineGrained, type SmbFineGrained, type VaultFileEntry,
} from '@/lib/api';
import { useConnectionStore } from '@/store';
import { ServiceLogo } from '@/components/shared/ServiceBadge';
import { cn, timeAgo, formatDate, copyToClipboard } from '@/lib/utils';
import { toast } from '@/store';
import { MiniToggle, SVC_LABEL, SVC_COLOR } from './shared';
import { type Service } from './ChatServiceAccordions';

// ─────────────────────────────────────────────────────────────────────────────
// Global: API Keys
// ─────────────────────────────────────────────────────────────────────────────

export function ApiKeysPanel() {
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

  const copy = (v: string) => { copyToClipboard(v).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); };

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

// ── ResourceMultiSelect ───────────────────────────────────────────────────────
// A tag-input style multi-select for choosing allowed resource IDs.

function ResourceMultiSelect({
  items,
  selected,
  onChange,
  placeholder,
  loading,
  label,
  emptyLabel,
}: {
  items: Array<{ id: string; name: string; meta?: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
  loading?: boolean;
  label: string;
  emptyLabel: string;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = items.filter((item) =>
    !selected.includes(item.id) &&
    (item.name.toLowerCase().includes(search.toLowerCase()) || item.id.toLowerCase().includes(search.toLowerCase()))
  );

  const selectedItems = selected.map((id) => items.find((i) => i.id === id) ?? { id, name: id });

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
      setSearch('');
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      {selected.length === 0 ? (
        <div className="text-xs text-muted-foreground/50 italic">{emptyLabel}</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selectedItems.map((item) => (
            <span key={item.id} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary">
              <span className="max-w-[140px] truncate">{item.name}</span>
              <button
                type="button"
                onClick={() => toggle(item.id)}
                className="opacity-60 hover:opacity-100 flex-shrink-0"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <div className="flex items-center gap-2 border border-border rounded-lg bg-secondary/20 px-2.5 py-1.5">
          <Search className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground/50"
          />
          {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground flex-shrink-0" />}
        </div>
        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {search ? 'No matches' : 'All items selected or none available'}
              </div>
            ) : (
              filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); toggle(item.id); }}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-left hover:bg-secondary/40 transition-colors"
                >
                  <span className="font-medium truncate">{item.name}</span>
                  {item.meta && <span className="text-muted-foreground/50 text-[10px] ml-2 flex-shrink-0">{item.meta}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── FineGrainedPanel ──────────────────────────────────────────────────────────
// Per-service fine-grained controls inside an expanded API key service row.

type FineGrainedPanelProps = {
  service: string;
  config: ServiceFineGrained | null;
  onChange: (config: ServiceFineGrained | null) => void;
  isConnected: boolean;
};

function FineGrainedPanel({ service, config, onChange, isConnected }: FineGrainedPanelProps) {
  const navigate = useNavigate();

  // Fetch resource lists lazily
  const { data: slackData, isLoading: loadingSlack } = useQuery({
    queryKey: ['slack-channels'],
    queryFn: api.slackChannels,
    enabled: service === 'slack' && isConnected,
  });
  const { data: telegramData, isLoading: loadingTelegram } = useQuery({
    queryKey: ['telegram-chats'],
    queryFn: api.telegramChats,
    enabled: service === 'telegram' && isConnected,
  });
  const { data: discordData, isLoading: loadingDiscord } = useQuery({
    queryKey: ['discord-guilds'],
    queryFn: api.discordGuilds,
    enabled: service === 'discord' && isConnected,
  });
  const { data: gmailData, isLoading: loadingGmail } = useQuery({
    queryKey: ['gmail-labels'],
    queryFn: api.gmailLabels,
    enabled: service === 'gmail' && isConnected,
  });
  const { data: calendarData, isLoading: loadingCalendar } = useQuery({
    queryKey: ['calendar-list'],
    queryFn: api.calendarList,
    enabled: service === 'calendar' && isConnected,
  });
  const { data: notionData, isLoading: loadingNotion } = useQuery({
    queryKey: ['notion-databases-list'],
    queryFn: api.notionDatabasesList,
    enabled: service === 'notion' && isConnected,
  });
  // Obsidian: vault files require a vault ID — show placeholder with empty list
  const obsidianData: { files: VaultFileEntry[] } | undefined = service === 'obsidian' ? { files: [] } : undefined;
  const loadingObsidian = false;

  if (!isConnected) {
    return (
      <div className="flex items-center gap-2.5 p-3 rounded-lg bg-secondary/10 border border-border/50">
        <PlugZap className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <p className="text-xs text-muted-foreground flex-1">
          Connect {SVC_LABEL[service] || service} to configure resource-level access.
        </p>
        <button
          onClick={() => navigate('/settings/connections')}
          className="text-xs text-primary hover:underline flex-shrink-0"
        >
          Connect →
        </button>
      </div>
    );
  }

  const upd = (patch: Partial<ServiceFineGrained>) => onChange({ ...(config ?? {}), ...patch } as ServiceFineGrained);

  if (service === 'slack') {
    const fg = config as SlackFineGrained | null;
    const channels = (slackData?.channels ?? []).map((c) => ({ id: c.id, name: c.name, meta: c.type }));
    return (
      <div className="space-y-4">
        <ResourceMultiSelect
          items={channels} loading={loadingSlack}
          selected={fg?.readChannelIds ?? []}
          onChange={(ids) => upd({ readChannelIds: ids.length ? ids : undefined })}
          label="Read — allowed channels / DMs" emptyLabel="All channels (unrestricted)"
          placeholder="Search channels…"
        />
        <ResourceMultiSelect
          items={channels} loading={loadingSlack}
          selected={fg?.writeChannelIds ?? []}
          onChange={(ids) => upd({ writeChannelIds: ids.length ? ids : undefined })}
          label="Write — allowed channels / DMs" emptyLabel="All channels (unrestricted)"
          placeholder="Search channels…"
        />
      </div>
    );
  }

  if (service === 'discord') {
    const fg = config as DiscordFineGrained | null;
    const guilds = (discordData ?? []).map((g) => ({ id: g.id, name: g.name }));
    const channels = (discordData ?? []).flatMap((g) => g.channels.map((c) => ({ id: c.id, name: c.name, meta: g.name })));
    return (
      <div className="space-y-4">
        <ResourceMultiSelect
          items={guilds} loading={loadingDiscord}
          selected={fg?.readGuildIds ?? []}
          onChange={(ids) => upd({ readGuildIds: ids.length ? ids : undefined })}
          label="Read — allowed servers" emptyLabel="All servers (unrestricted)"
          placeholder="Search servers…"
        />
        <ResourceMultiSelect
          items={channels} loading={loadingDiscord}
          selected={fg?.readChannelIds ?? []}
          onChange={(ids) => upd({ readChannelIds: ids.length ? ids : undefined })}
          label="Read — allowed channels" emptyLabel="All channels (unrestricted)"
          placeholder="Search channels…"
        />
        <ResourceMultiSelect
          items={guilds} loading={loadingDiscord}
          selected={fg?.writeGuildIds ?? []}
          onChange={(ids) => upd({ writeGuildIds: ids.length ? ids : undefined })}
          label="Write — allowed servers" emptyLabel="All servers (unrestricted)"
          placeholder="Search servers…"
        />
        <ResourceMultiSelect
          items={channels} loading={loadingDiscord}
          selected={fg?.writeChannelIds ?? []}
          onChange={(ids) => upd({ writeChannelIds: ids.length ? ids : undefined })}
          label="Write — allowed channels" emptyLabel="All channels (unrestricted)"
          placeholder="Search channels…"
        />
      </div>
    );
  }

  if (service === 'telegram') {
    const fg = config as TelegramFineGrained | null;
    const chats = (telegramData?.chats ?? []).map((c) => ({ id: c.id, name: c.name, meta: c.type }));
    return (
      <div className="space-y-4">
        <ResourceMultiSelect
          items={chats} loading={loadingTelegram}
          selected={fg?.readChatIds ?? []}
          onChange={(ids) => upd({ readChatIds: ids.length ? ids : undefined })}
          label="Read — allowed chats / groups / channels" emptyLabel="All chats (unrestricted)"
          placeholder="Search chats…"
        />
        <ResourceMultiSelect
          items={chats} loading={loadingTelegram}
          selected={fg?.writeChatIds ?? []}
          onChange={(ids) => upd({ writeChatIds: ids.length ? ids : undefined })}
          label="Write — allowed chats / groups" emptyLabel="All chats (unrestricted)"
          placeholder="Search chats…"
        />
      </div>
    );
  }

  if (service === 'gmail') {
    const fg = config as GmailFineGrained | null;
    const labels = (gmailData?.labels ?? []).map((l) => ({ id: l.id, name: l.name, meta: l.type }));
    return (
      <div className="space-y-4">
        <ResourceMultiSelect
          items={labels} loading={loadingGmail}
          selected={fg?.readLabelIds ?? []}
          onChange={(ids) => upd({ readLabelIds: ids.length ? ids : undefined })}
          label="Read — allowed labels" emptyLabel="All labels (unrestricted)"
          placeholder="Search labels…"
        />
        <ResourceMultiSelect
          items={labels} loading={loadingGmail}
          selected={fg?.writeLabelIds ?? []}
          onChange={(ids) => upd({ writeLabelIds: ids.length ? ids : undefined })}
          label="Write — allowed labels (send to these threads)" emptyLabel="All labels (unrestricted)"
          placeholder="Search labels…"
        />
      </div>
    );
  }

  if (service === 'calendar') {
    const fg = config as CalendarFineGrained | null;
    const calendars = (calendarData?.calendars ?? []).map((c) => ({ id: c.id, name: c.summary, meta: c.primary ? 'Primary' : undefined }));
    return (
      <div className="space-y-4">
        <ResourceMultiSelect
          items={calendars} loading={loadingCalendar}
          selected={fg?.readCalendarIds ?? []}
          onChange={(ids) => upd({ readCalendarIds: ids.length ? ids : undefined })}
          label="Read — allowed calendars" emptyLabel="All calendars (unrestricted)"
          placeholder="Search calendars…"
        />
        <ResourceMultiSelect
          items={calendars} loading={loadingCalendar}
          selected={fg?.writeCalendarIds ?? []}
          onChange={(ids) => upd({ writeCalendarIds: ids.length ? ids : undefined })}
          label="Write — allowed calendars (create/edit events)" emptyLabel="All calendars (unrestricted)"
          placeholder="Search calendars…"
        />
      </div>
    );
  }

  if (service === 'twitter') {
    const fg = config as TwitterFineGrained | null;
    const readDms     = fg?.readDms      !== false;
    const readTl      = fg?.readTimeline !== false;
    const allowTweets = fg?.allowTweets  !== false;
    const allowDms    = fg?.allowDmReplies !== false;
    return (
      <div className="space-y-3">
        <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Read access</div>
        <div className="space-y-2">
          {([
            { key: 'readDms',      label: 'Read DMs',       desc: 'Access direct message conversations', val: readDms },
            { key: 'readTimeline', label: 'Read timeline',  desc: 'Access home feed and search results',  val: readTl },
          ] as const).map(({ key, label, desc, val }) => (
            <div key={key} className="flex items-center justify-between gap-3 py-1.5">
              <div>
                <div className="text-xs font-medium text-foreground">{label}</div>
                <div className="text-[11px] text-muted-foreground">{desc}</div>
              </div>
              <MiniToggle
                checked={val}
                onChange={(v) => upd({ [key]: v } as Partial<TwitterFineGrained>)}
              />
            </div>
          ))}
        </div>
        <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground mt-3 mb-1">Write access</div>
        <div className="space-y-2">
          {([
            { key: 'allowTweets',    label: 'Post tweets',    desc: 'Create new tweets and replies',    val: allowTweets },
            { key: 'allowDmReplies', label: 'Send DM replies', desc: 'Send direct messages to existing conversations', val: allowDms },
          ] as const).map(({ key, label, desc, val }) => (
            <div key={key} className="flex items-center justify-between gap-3 py-1.5">
              <div>
                <div className="text-xs font-medium text-foreground">{label}</div>
                <div className="text-[11px] text-muted-foreground">{desc}</div>
              </div>
              <MiniToggle
                checked={val}
                onChange={(v) => upd({ [key]: v } as Partial<TwitterFineGrained>)}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (service === 'notion') {
    const fg = config as NotionFineGrained | null;
    const dbs = (notionData?.results ?? [])
      .filter((r) => r.object === 'database')
      .map((d) => ({
        id: d.id,
        name: Array.isArray((d as { title?: Array<{ plain_text?: string }> }).title)
          ? ((d as { title?: Array<{ plain_text?: string }> }).title ?? []).map((t) => t.plain_text || '').join('')
          : d.id,
      }));
    return (
      <div className="space-y-4">
        <ResourceMultiSelect
          items={dbs} loading={loadingNotion}
          selected={fg?.readDatabaseIds ?? []}
          onChange={(ids) => upd({ readDatabaseIds: ids.length ? ids : undefined })}
          label="Read — allowed databases" emptyLabel="All databases (unrestricted)"
          placeholder="Search databases…"
        />
        <ResourceMultiSelect
          items={dbs} loading={loadingNotion}
          selected={fg?.writeDatabaseIds ?? []}
          onChange={(ids) => upd({ writeDatabaseIds: ids.length ? ids : undefined })}
          label="Write — allowed databases" emptyLabel="All databases (unrestricted)"
          placeholder="Search databases…"
        />
      </div>
    );
  }

  if (service === 'obsidian') {
    const fg = config as ObsidianFineGrained | null;
    // Flatten obsidian files to a flat list of paths
    function flattenFiles(files: VaultFileEntry[], prefix = ''): Array<{ id: string; name: string }> {
      return files.flatMap((f) => {
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.type === 'directory' && f.children) {
          return [{ id: path + '/', name: path + '/' }, ...flattenFiles(f.children, path)];
        }
        return [{ id: path, name: path }];
      });
    }
    const paths = flattenFiles(obsidianData?.files ?? []);
    return (
      <div className="space-y-4">
        <ResourceMultiSelect
          items={paths} loading={loadingObsidian}
          selected={fg?.readPaths ?? []}
          onChange={(ids) => upd({ readPaths: ids.length ? ids : undefined })}
          label="Read — allowed path prefixes" emptyLabel="All paths (unrestricted)"
          placeholder="Search paths…"
        />
        <ResourceMultiSelect
          items={paths} loading={loadingObsidian}
          selected={fg?.writePaths ?? []}
          onChange={(ids) => upd({ writePaths: ids.length ? ids : undefined })}
          label="Write — allowed path prefixes" emptyLabel="All paths (unrestricted)"
          placeholder="Search paths…"
        />
      </div>
    );
  }

  if (service === 'smb') {
    const fg = config as SmbFineGrained | null;
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <MiniToggle
            checked={fg?.readEnabled ?? true}
            onChange={(v) => upd({ readEnabled: v })}
          />
          <span className="text-xs text-foreground">Read access enabled</span>
        </div>
        <div className="flex items-center gap-3">
          <MiniToggle
            checked={fg?.writeEnabled ?? false}
            onChange={(v) => upd({ writeEnabled: v })}
          />
          <span className="text-xs text-foreground">Write access enabled</span>
        </div>
        <ResourceMultiSelect
          items={[]}
          selected={fg?.readPaths ?? []}
          onChange={(ids) => upd({ readPaths: ids.length ? ids : undefined })}
          label="Read — allowed path prefixes" emptyLabel="All paths (unrestricted)"
          placeholder="e.g. documents/reports"
        />
        <ResourceMultiSelect
          items={[]}
          selected={fg?.writePaths ?? []}
          onChange={(ids) => upd({ writePaths: ids.length ? ids : undefined })}
          label="Write — allowed path prefixes" emptyLabel="All paths (unrestricted)"
          placeholder="e.g. documents/uploads"
        />
      </div>
    );
  }

  return <div className="text-xs text-muted-foreground">No fine-grained options for this service.</div>;
}

// ── ApiKeyServiceRow ──────────────────────────────────────────────────────────
// Second-level expandable row: one service within an expanded API key.

function ApiKeyServiceRow({
  perm,
  connections,
  onUpdate,
  onUpdateFg,
}: {
  perm: KeyServicePerm;
  connections: Record<string, ConnectionStatus>;
  onUpdate: (service: string, field: string, value: boolean | null) => void;
  onUpdateFg: (service: string, config: ServiceFineGrained | null) => void;
}) {
  const [fgOpen, setFgOpen] = useState(false);

  const COLS: Array<{ key: 'readEnabled' | 'sendEnabled' | 'requireApproval'; label: string }> = [
    { key: 'readEnabled',     label: 'Read'     },
    { key: 'sendEnabled',     label: 'Send'     },
    { key: 'requireApproval', label: 'Approval' },
  ];

  const hasFgConfig = perm.fineGrainedConfig !== null &&
    Object.values(perm.fineGrainedConfig as Record<string, unknown>).some((v) =>
      Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null
    );

  const isConnected = connections[perm.service]?.status === 'connected';

  return (
    <div className="border-t border-border first:border-t-0">
      {/* Service row with basic toggles */}
      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/5 transition-colors">
        {/* Service name */}
        <div className="flex items-center gap-2 w-28 flex-shrink-0">
          <ServiceLogo service={perm.service} className="w-3.5 h-3.5 flex-shrink-0" />
          <span className={cn('text-xs font-medium truncate', SVC_COLOR[perm.service] || 'text-foreground')}>
            {SVC_LABEL[perm.service] || perm.service}
          </span>
        </div>

        {/* Basic toggles */}
        <div className="flex items-center gap-4 flex-1">
          {COLS.map((c) => {
            const isOverridden = perm.overrides[c.key] !== null;
            return (
              <div key={c.key} className="flex flex-col items-center gap-0.5">
                <MiniToggle
                  checked={perm[c.key]}
                  onChange={(v) => onUpdate(perm.service, c.key, v)}
                />
                {isOverridden ? (
                  <button
                    onClick={() => onUpdate(perm.service, c.key, null)}
                    className="text-[9px] text-primary hover:underline leading-tight cursor-pointer"
                  >
                    reset
                  </button>
                ) : (
                  <span className="text-[9px] text-muted-foreground/35 leading-tight select-none cursor-default">
                    inherit
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Fine-grained expand button */}
        <button
          onClick={() => setFgOpen(!fgOpen)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] transition-all flex-shrink-0',
            fgOpen
              ? 'bg-primary/10 text-primary border border-primary/20'
              : hasFgConfig
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent',
          )}
          title="Fine-grained resource access"
        >
          <SlidersHorizontal className="w-2.5 h-2.5" />
          <span>{hasFgConfig ? 'restricted' : 'fine-grained'}</span>
          <ChevronDown className={cn('w-2.5 h-2.5 transition-transform', fgOpen && 'rotate-180')} />
        </button>
      </div>

      {/* Fine-grained expansion */}
      <AnimatePresence initial={false}>
        {fgOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="mx-4 mb-3 mt-0.5 rounded-xl border border-border/60 bg-secondary/10 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <Filter className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs font-semibold text-foreground">Resource filters</span>
                  {perm.overrides.fineGrainedConfig !== null && (
                    <span className="chip chip-amber text-[9px]">overridden</span>
                  )}
                </div>
                {perm.overrides.fineGrainedConfig !== null && (
                  <button
                    onClick={() => onUpdateFg(perm.service, null)}
                    className="text-[10px] text-primary hover:underline"
                  >
                    reset to global
                  </button>
                )}
              </div>
              <FineGrainedPanel
                service={perm.service}
                config={perm.fineGrainedConfig}
                onChange={(cfg) => onUpdateFg(perm.service, cfg)}
                isConnected={isConnected}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── ApiKeyRow ─────────────────────────────────────────────────────────────────
// Top-level expandable row for an API key. Expanded view shows all services
// as ApiKeyServiceRow entries (each independently expandable for fine-grained).

export function ApiKeyRow({ apiKey }: { apiKey: ApiKeyItem }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const connections = useConnectionStore((s) => s.statuses);

  const { data, isLoading } = useQuery({
    queryKey: ['key-permissions', apiKey.id],
    queryFn: () => api.keyPermissions(apiKey.id),
    enabled: expanded,
  });

  const update = useMutation({
    mutationFn: ({ service, field, value }: { service: string; field: string; value: boolean | null }) =>
      api.updateKeyPermission(apiKey.id, service, { [field]: value } as Parameters<typeof api.updateKeyPermission>[2]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['key-permissions', apiKey.id] }),
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const updateFg = useMutation({
    mutationFn: ({ service, config }: { service: string; config: ServiceFineGrained | null }) =>
      api.updateKeyPermission(apiKey.id, service, { fineGrainedConfig: config }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['key-permissions', apiKey.id] }),
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const revoke = useMutation({
    mutationFn: () => api.revokeApiKey(apiKey.id),
    onSuccess: () => { toast({ title: 'API key revoked' }); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
  });

  // Count services with any active overrides (basic or fine-grained)
  const overrideCount = data?.permissions.filter((p) =>
    p.overrides.readEnabled !== null || p.overrides.sendEnabled !== null ||
    p.overrides.requireApproval !== null || p.overrides.fineGrainedConfig !== null
  ).length ?? 0;

  const fgCount = data?.permissions.filter((p) => p.fineGrainedConfig !== null).length ?? 0;

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      {/* Key header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-secondary/20">
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2.5 flex-1 text-left min-w-0">
          <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150', expanded && 'rotate-180')} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium truncate">{apiKey.name}</span>
              <code className="chip chip-emerald font-mono text-[10px]">{apiKey.keyPrefix}…</code>
              {!expanded && overrideCount > 0 && (
                <span className="chip chip-amber text-[9px]">{overrideCount} override{overrideCount !== 1 ? 's' : ''}</span>
              )}
              {!expanded && fgCount > 0 && (
                <span className="flex items-center gap-1 chip bg-violet-500/10 text-violet-400 border-violet-500/20 text-[9px]">
                  <SlidersHorizontal className="w-2.5 h-2.5" />{fgCount} filter{fgCount !== 1 ? 's' : ''}
                </span>
              )}
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

      {/* Expanded service list */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden border-t border-border"
          >
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            ) : data ? (
              <div>
                {/* Column header row */}
                <div className="flex items-center gap-3 px-4 py-1.5 bg-secondary/10 border-b border-border">
                  <div className="w-28 flex-shrink-0" />
                  <div className="flex items-center gap-4 flex-1">
                    {(['Read', 'Send', 'Approval'] as const).map((label) => (
                      <span key={label} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 w-9 text-center flex-shrink-0">{label}</span>
                    ))}
                  </div>
                  <div className="w-24 flex-shrink-0" />
                </div>
                {/* Service rows */}
                {data.permissions.map((perm) => (
                  <ApiKeyServiceRow
                    key={perm.service}
                    perm={perm}
                    connections={connections}
                    onUpdate={(service, field, value) => update.mutate({ service, field, value })}
                    onUpdateFg={(service, config) => updateFg.mutate({ service, config })}
                  />
                ))}
              </div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
