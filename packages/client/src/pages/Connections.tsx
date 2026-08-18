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

import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, Shield, PlugZap, MessageSquare as MessageSquareIcon, Mail as MailIcon, Lock, Zap,
  FileText, Bot, Bell, Palette, HardDrive,
} from 'lucide-react';
import { AppearanceTab } from '@/components/settings/AppearanceTab';
import { api } from '@/lib/api';
import { useConnectionStore, useSyncStore } from '@/store';
import { cn } from '@/lib/utils';
import { SERVICES, ServiceAccordion } from '@/components/settings/ChatServiceAccordions';
import { PermissionsTab } from '@/components/settings/PermissionsTab';
import { InstallTab } from '@/components/settings/InstallTab';
import { SecurityTab } from '@/components/settings/SecurityTab';
import { NotificationsTab } from '@/components/settings/NotificationsTab';
import { AgentAccessTab } from '@/components/settings/AgentAccessTab';
import { GoogleServicesAccordion } from '@/components/settings/GoogleServices';
import { TwitterAccordion } from '@/components/settings/TwitterSection';
import { NotionAccordion } from '@/components/settings/NotionSection';
import { ObsidianVaultTab } from '@/components/settings/ObsidianTab';
import { GoogleDriveTab } from '@/components/settings/GoogleDriveTab';
import { SmbSharesTab } from '@/components/settings/SmbTab';

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

// Legacy connection tab IDs that now live under the 'connections' tab — kept in
// VALID_TABS so old /settings/<id> URLs redirect gracefully instead of 404-ing.
type ConnectionSubTabId = 'messaging' | 'email-calendar' | 'ai' | 'files' | 'install';
type TopTabId = 'connections' | 'permissions' | 'notifications' | 'security' | 'appearance';
type TabId = TopTabId | 'settings' | ConnectionSubTabId | 'vault'; // 'settings'/'vault' kept for backward-compat

const VALID_TABS = new Set<TabId>([
  'connections', 'permissions', 'notifications', 'security', 'appearance',
  // legacy / backward-compat aliases that map → 'connections'
  'messaging', 'email-calendar', 'ai', 'files', 'vault', 'install', 'settings',
]);

// Sub-tabs shown inside the Connections section
const CONNECTION_SUB_TABS: { id: ConnectionSubTabId; label: string; icon: React.ElementType }[] = [
  { id: 'messaging',      label: 'Messaging', icon: MessageSquareIcon },
  { id: 'email-calendar', label: 'Google',    icon: MailIcon },
  { id: 'ai',             label: 'Agents',    icon: Bot },
  { id: 'files',          label: 'Files',     icon: FileText },
  { id: 'install',        label: 'Install',   icon: Zap },
];

// Map legacy connection tab ids to the top-level 'connections' tab so that old
// bookmarks / redirects still land on the right top-level section.
const LEGACY_TO_TOP: Partial<Record<TabId, TopTabId>> = {
  messaging: 'connections',
  'email-calendar': 'connections',
  ai: 'connections',
  files: 'connections',
  vault: 'connections',  // backward-compat alias
  install: 'connections',
  settings: 'permissions',
};

// Map legacy connection tab ids to their connection sub-tab equivalent.
const LEGACY_TO_SUB: Partial<Record<TabId, ConnectionSubTabId>> = {
  messaging: 'messaging',
  'email-calendar': 'email-calendar',
  ai: 'ai',
  files: 'files',
  vault: 'files',  // backward-compat alias
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
  React.useEffect(() => { setActiveTabState(resolvedTopTab); }, [resolvedTopTab]);
  const setActiveTab = (id: TopTabId) => {
    setActiveTabState(id);
    navigate(`/settings/${id}`, { replace: true });
  };

  // Connection sub-tab state — initialise from legacy URL param if present.
  const initialSubTab: ConnectionSubTabId = LEGACY_TO_SUB[tab as TabId] ?? 'messaging';
  const [activeConnTab, setActiveConnTab] = React.useState<ConnectionSubTabId>(initialSubTab);

  // Collapsible state for multi-section tabs
  const [smbOpen, setSmbOpen] = React.useState(true);
  const [obsidianOpen, setObsidianOpen] = React.useState(true);
  const [gdriveOpen, setGdriveOpen] = React.useState(true);

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
                    </>
                  )}
                  {activeConnTab === 'email-calendar' && (
                    <GoogleServicesAccordion />
                  )}
                  {activeConnTab === 'ai' && (
                    <div className="card-warm overflow-hidden">
                      <div className="px-4 py-3 border-b border-border bg-secondary/20">
                        <h2 className="text-sm font-semibold">Agent Access</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">Connect any AI agent to Conduit via the REST API</p>
                      </div>
                      <div className="p-4"><AgentAccessTab /></div>
                    </div>
                  )}
                  {activeConnTab === 'files' && (
                    <div className="space-y-3">
                      {/* Google Drive */}
                      <div className="card-warm overflow-hidden">
                        <button
                          onClick={() => setGdriveOpen(!gdriveOpen)}
                          className={cn('w-full flex items-center gap-3 px-4 py-3 text-left transition-colors', gdriveOpen ? 'bg-card' : 'bg-card/50 hover:bg-card/80')}
                        >
                          <HardDrive className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <h2 className="text-sm font-semibold">Google Drive</h2>
                            <p className="text-xs text-muted-foreground mt-0.5">Browse, read, and edit Google Drive files and folders using your connected Google account</p>
                          </div>
                          <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform duration-200', gdriveOpen && 'rotate-180')} />
                        </button>
                        <AnimatePresence initial={false}>
                          {gdriveOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                              className="overflow-hidden"
                            >
                              <div className="border-t border-border">
                                <div className="p-4"><GoogleDriveTab /></div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      {/* SMB */}
                      <div className="card-warm overflow-hidden">
                        <button
                          onClick={() => setSmbOpen(!smbOpen)}
                          className={cn('w-full flex items-center gap-3 px-4 py-3 text-left transition-colors', smbOpen ? 'bg-card' : 'bg-card/50 hover:bg-card/80')}
                        >
                          <div className="flex-1 min-w-0">
                            <h2 className="text-sm font-semibold">SMB / Network Shares</h2>
                            <p className="text-xs text-muted-foreground mt-0.5">Connect Windows/Samba file shares for AI-assisted file reading and writing</p>
                          </div>
                          <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform duration-200', smbOpen && 'rotate-180')} />
                        </button>
                        <AnimatePresence initial={false}>
                          {smbOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                              className="overflow-hidden"
                            >
                              <div className="border-t border-border">
                                <div className="p-4"><SmbSharesTab /></div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      {/* Obsidian */}
                      <div className="card-warm overflow-hidden">
                        <button
                          onClick={() => setObsidianOpen(!obsidianOpen)}
                          className={cn('w-full flex items-center gap-3 px-4 py-3 text-left transition-colors', obsidianOpen ? 'bg-card' : 'bg-card/50 hover:bg-card/80')}
                        >
                          <div className="flex-1 min-w-0">
                            <h2 className="text-sm font-semibold">Obsidian Vault</h2>
                            <p className="text-xs text-muted-foreground mt-0.5">Connect a git-synced Obsidian vault for AI-assisted note reading and editing</p>
                          </div>
                          <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform duration-200', obsidianOpen && 'rotate-180')} />
                        </button>
                        <AnimatePresence initial={false}>
                          {obsidianOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                              className="overflow-hidden"
                            >
                              <div className="border-t border-border">
                                <div className="p-4"><ObsidianVaultTab /></div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      <NotionAccordion />
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
