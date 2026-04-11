import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useSyncStore } from '@/store';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { NotificationCenter } from '@/components/shared/NotificationCenter';
import { useNotificationSound, type NotificationSoundSettings, DEFAULT_SOUND_SETTINGS } from '@/hooks/useNotificationSound';
import { api } from '@/lib/api';

const ROUTE_LABELS: Record<string, { title: string; subtitle: string }> = {
  '/':            { title: 'Inbox',       subtitle: 'Everything new across all your platforms' },
  '/dashboard':   { title: 'Dashboard',   subtitle: 'Overview of your messaging ecosystem' },
  '/chat':        { title: 'Chat',        subtitle: 'Your conversations across all services' },
  '/outbox':      { title: 'Outbox',      subtitle: 'Pending and sent message requests' },
  '/contacts':    { title: 'Contacts',    subtitle: 'People you interact with across all services' },
  '/twitter':     { title: 'Twitter / X', subtitle: 'DMs, feed, and AI-powered exploration' },
  '/email':       { title: 'Email',       subtitle: 'Gmail inbox and message management' },
  '/calendar':    { title: 'Calendar',    subtitle: 'Google Calendar events and scheduling' },
  '/connections': { title: 'Settings',    subtitle: 'Connections, credentials, and settings' },
  '/metrics':     { title: 'Metrics',     subtitle: 'Sync and usage analytics' },
  '/audit-log':   { title: 'Audit Log',   subtitle: 'Full activity history' },
  '/settings':    { title: 'Settings',    subtitle: 'Connections, credentials, and settings' },
};

export function TopBar() {
  const location = useLocation();
  const qc = useQueryClient();
  const basePath = '/' + location.pathname.split('/')[1];
  const route = ROUTE_LABELS[basePath] ?? ROUTE_LABELS['/'];
  const syncProgress = useSyncStore((s) => s.progress);
  const anyRunning = Object.values(syncProgress).some((p) => p.status === 'running');
  const isInbox = location.pathname === '/';

  const [refreshing, setRefreshing] = useState(false);

  // Load notification sound settings from server settings
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 });
  const soundSettings = (settings?.notifications as { sounds?: NotificationSoundSettings } | undefined)?.sounds ?? DEFAULT_SOUND_SETTINGS;
  useNotificationSound(soundSettings);

  const refreshInbox = async () => {
    setRefreshing(true);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['inbox-gmail'] }),
      qc.invalidateQueries({ queryKey: ['inbox-calendar'] }),
      qc.invalidateQueries({ queryKey: ['inbox-twitter-mentions'] }),
      qc.invalidateQueries({ queryKey: ['inbox-twitter-feed'] }),
      qc.invalidateQueries({ queryKey: ['chats'] }),
    ]);
    setTimeout(() => setRefreshing(false), 600);
  };

  return (
    <header className={cn(
      'flex items-center h-12 px-5 flex-shrink-0 gap-3',
      'border-b border-border glass sticky top-0 z-20',
    )}>
      {/* Page title */}
      <div className="flex-1 min-w-0">
        <h1 className="text-sm font-semibold text-foreground leading-tight">{route.title}</h1>
        {isInbox ? (
          <p className="text-[11px] text-muted-foreground leading-tight hidden sm:block">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground leading-tight hidden sm:block">{route.subtitle}</p>
        )}
      </div>

      {/* Right-side controls */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className={cn(
          'flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-2.5 py-1',
          !anyRunning && 'invisible',
        )}>
          <RefreshCw className="w-3 h-3 animate-spin text-primary" />
          <span className="text-xs text-primary font-medium">Syncing</span>
        </div>
        {isInbox && (
          <button
            onClick={refreshInbox}
            disabled={refreshing}
            className="btn-ghost text-xs gap-1.5 text-muted-foreground"
            title="Refresh Inbox"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        )}
        <NotificationCenter />
      </div>
    </header>
  );
}
