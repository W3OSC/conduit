import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Volume2, VolumeX, Play, RotateCcw,
} from 'lucide-react';
import {
  api,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import type { NotificationSoundSettings, SoundStyle } from '@/hooks/useNotificationSound';
import { DEFAULT_SOUND_SETTINGS, playSound } from '@/hooks/useNotificationSound';

// ─────────────────────────────────────────────────────────────────────────────
// Notifications Tab
// ─────────────────────────────────────────────────────────────────────────────

const SOUND_OPTIONS: Array<{ value: SoundStyle; label: string }> = [
  { value: 'default', label: 'Ding' },
  { value: 'chime',   label: 'Chime' },
  { value: 'pop',     label: 'Pop' },
  { value: 'ping',    label: 'Ping' },
  { value: 'buzz',    label: 'Buzz' },
  { value: 'chord',   label: 'Chord' },
  { value: 'whoosh',  label: 'Whoosh' },
  { value: 'swoosh',  label: 'Swoosh' },
  { value: 'thud',    label: 'Thud' },
  { value: 'none',    label: 'None (silent)' },
];

function SoundSelect({ value, onChange, disabled }: { value: SoundStyle; onChange: (v: SoundStyle) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SoundStyle)}
        disabled={disabled}
        className="text-xs bg-secondary border border-border rounded-lg px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {SOUND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <button
        onClick={() => playSound(value)}
        disabled={disabled || value === 'none'}
        title={value === 'none' ? 'No sound to preview' : 'Preview sound'}
        className="flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Play className="w-3 h-3" />
      </button>
    </div>
  );
}

export function NotificationsTab() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 30_000 });

  const raw = (settings?.notifications as { sounds?: NotificationSoundSettings } | undefined)?.sounds;
  const sounds: NotificationSoundSettings = raw ?? DEFAULT_SOUND_SETTINGS;

  const save = async (patch: Partial<NotificationSoundSettings>) => {
    const next = { ...sounds, ...patch };
    await api.updateSettings({ notifications: { sounds: next } });
    qc.invalidateQueries({ queryKey: ['settings'] });
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
      <div className="space-y-1">
        {rows.map(({ key, label, desc }) => (
          <div key={key} className={cn('flex items-center gap-3 py-3 px-4 rounded-xl transition-colors', sounds.enabled ? 'hover:bg-secondary/40' : 'opacity-50')}>
            <Bell className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </div>
            <SoundSelect
              value={sounds[key]}
              onChange={(v) => save({ [key]: v })}
              disabled={!sounds.enabled}
            />
          </div>
        ))}
      </div>

      {/* Reset to defaults */}
      <div className="flex justify-end">
        <button
          onClick={() => save(DEFAULT_SOUND_SETTINGS)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
