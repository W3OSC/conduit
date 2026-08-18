/**
 * Canonical per-service palette — the single source of truth for service
 * colours across the app (badges, sidebar, charts, settings, chat accents).
 *
 * Tailwind class groups follow the original ServiceBadge values; `hex` is the
 * chart stroke/fill colour (the 500-shade of the same hue family, matching the
 * Dashboard charts).
 */

export interface ServiceTheme {
  label: string;
  letter: string;
  /** Hex used for chart strokes/fills (recharts can't take tailwind classes) */
  hex: string;
  bg: string;
  text: string;
  border: string;
  dot: string;
}

export const SERVICE_THEME: Record<string, ServiceTheme> = {
  slack:    { label: 'Slack',     letter: 'S', hex: '#8B5CF6', bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/25', dot: 'bg-violet-400' },
  discord:  { label: 'Discord',   letter: 'D', hex: '#6366F1', bg: 'bg-indigo-500/10', text: 'text-indigo-400', border: 'border-indigo-500/25', dot: 'bg-indigo-400' },
  telegram: { label: 'Telegram',  letter: 'T', hex: '#0EA5E9', bg: 'bg-sky-500/10',    text: 'text-sky-400',    border: 'border-sky-500/25',   dot: 'bg-sky-400'    },
  twitter:  { label: 'Twitter',   letter: '𝕏', hex: '#38BDF8', bg: 'bg-sky-400/10',   text: 'text-sky-300',    border: 'border-sky-400/25',   dot: 'bg-sky-300'    },
  gmail:    { label: 'Gmail',     letter: 'G', hex: '#EF4444', bg: 'bg-red-500/10',    text: 'text-red-400',    border: 'border-red-500/25',   dot: 'bg-red-400'    },
  calendar: { label: 'Calendar',  letter: 'C', hex: '#F59E0B', bg: 'bg-amber-500/10',  text: 'text-amber-400',  border: 'border-amber-500/25', dot: 'bg-amber-400'  },
  notion:   { label: 'Notion',    letter: 'N', hex: '#71717A', bg: 'bg-zinc-500/10',   text: 'text-zinc-300',   border: 'border-zinc-500/25',  dot: 'bg-zinc-300'   },
  obsidian: { label: 'Files',     letter: 'F', hex: '#A855F7', bg: 'bg-purple-500/10', text: 'text-purple-300', border: 'border-purple-500/25',dot: 'bg-purple-300'  },
  smb:      { label: 'SMB Share', letter: 'S', hex: '#F59E0B', bg: 'bg-amber-500/10',  text: 'text-amber-400',  border: 'border-amber-500/25', dot: 'bg-amber-400'  },
  ai:       { label: 'AI',        letter: 'A', hex: '#10B981', bg: 'bg-emerald-500/10',text: 'text-emerald-300',border: 'border-emerald-500/25',dot: 'bg-emerald-300' },
};

export const DEFAULT_SERVICE_THEME: ServiceTheme = {
  label: 'Unknown', letter: '?', hex: '#78716C',
  bg: 'bg-warm-700/40', text: 'text-warm-300', border: 'border-warm-600/40', dot: 'bg-warm-400',
};
