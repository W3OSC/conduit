import { cn } from '@/lib/utils';

interface ServiceBadgeProps {
  service: string;
  className?: string;
  size?: 'xs' | 'sm' | 'md';
}

const SERVICE_CONFIG: Record<string, {
  label: string; letter: string;
  bg: string; text: string; border: string; dot: string;
}> = {
  slack:    { label: 'Slack',    letter: 'S', bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/25', dot: 'bg-violet-400' },
  discord:  { label: 'Discord',  letter: 'D', bg: 'bg-indigo-500/10', text: 'text-indigo-400', border: 'border-indigo-500/25', dot: 'bg-indigo-400' },
  telegram: { label: 'Telegram', letter: 'T', bg: 'bg-sky-500/10',    text: 'text-sky-400',    border: 'border-sky-500/25',   dot: 'bg-sky-400'    },
  twitter:  { label: 'Twitter',  letter: '𝕏', bg: 'bg-sky-400/10',   text: 'text-sky-300',    border: 'border-sky-400/25',   dot: 'bg-sky-300'    },
  gmail:    { label: 'Gmail',    letter: 'G', bg: 'bg-red-500/10',    text: 'text-red-400',    border: 'border-red-500/25',   dot: 'bg-red-400'    },
  calendar: { label: 'Calendar', letter: 'C', bg: 'bg-amber-500/10',  text: 'text-amber-400',  border: 'border-amber-500/25', dot: 'bg-amber-400'  },
  notion:   { label: 'Notion',   letter: 'N', bg: 'bg-zinc-500/10',   text: 'text-zinc-300',   border: 'border-zinc-500/25',  dot: 'bg-zinc-300'   },
  obsidian: { label: 'Vault',    letter: 'V', bg: 'bg-purple-500/10', text: 'text-purple-300', border: 'border-purple-500/25',dot: 'bg-purple-300'  },
};

const DEFAULT_CONFIG = {
  label: 'Unknown', letter: '?',
  bg: 'bg-warm-700/40', text: 'text-warm-300', border: 'border-warm-600/40', dot: 'bg-warm-400',
};

// Inline SVG logo paths for each service — monochrome, fills with currentColor
export function ServiceLogo({ service, className }: { service: string; className?: string }) {
  const cls = cn('flex-shrink-0', className);
  switch (service) {
    case 'slack':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
          <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
        </svg>
      );
    case 'discord':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
          <path d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.036c-.21.369-.444.85-.608 1.23a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.23A.077.077 0 0 0 8.562 3c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026c.462-.62.874-1.275 1.226-1.963a.074.074 0 0 0-.041-.104 13.2 13.2 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028zM8.02 15.278c-1.182 0-2.157-1.069-2.157-2.38 0-1.312.956-2.38 2.157-2.38 1.21 0 2.176 1.077 2.157 2.38 0 1.312-.956 2.38-2.157 2.38zm7.975 0c-1.183 0-2.157-1.069-2.157-2.38 0-1.312.955-2.38 2.157-2.38 1.21 0 2.176 1.077 2.157 2.38 0 1.312-.946 2.38-2.157 2.38z"/>
        </svg>
      );
    case 'telegram':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
          <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
        </svg>
      );
    case 'twitter':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
      );
    case 'gmail':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
          <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.907 1.528-1.148C21.69 2.28 24 3.434 24 5.457z"/>
        </svg>
      );
    case 'calendar':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
      );
    case 'notion':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
          <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/>
        </svg>
      );
    case 'obsidian':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
      );
    default:
      return <span className={cls} aria-hidden>?</span>;
  }
}

// Compact icon-only chip for filter bars (no label)
export function ServiceFilterChip({
  service, active, onClick,
}: { service: string; active: boolean; onClick: () => void }) {
  const cfg = SERVICE_CONFIG[service] ?? DEFAULT_CONFIG;
  return (
    <button
      onClick={onClick}
      title={cfg.label}
      className={cn(
        'flex items-center justify-center w-8 h-8 rounded-xl border transition-all duration-150 flex-shrink-0',
        active
          ? `${cfg.bg} ${cfg.text} ${cfg.border} ring-1 ring-current/30`
          : 'bg-secondary/30 text-muted-foreground/50 border-border/40 hover:text-muted-foreground hover:bg-secondary/60',
      )}
    >
      <ServiceLogo service={service} className="w-3.5 h-3.5" />
    </button>
  );
}

// "All" chip companion for filter bars
export function AllFilterChip({
  active, onClick,
}: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="All services"
      className={cn(
        'flex items-center justify-center h-8 px-2.5 rounded-xl border text-xs font-semibold transition-all duration-150 flex-shrink-0',
        active
          ? 'bg-primary/15 text-primary border-primary/30 ring-1 ring-primary/20'
          : 'bg-secondary/30 text-muted-foreground/50 border-border/40 hover:text-muted-foreground hover:bg-secondary/60',
      )}
    >
      All
    </button>
  );
}

export function ServiceBadge({ service, className, size = 'sm' }: ServiceBadgeProps) {
  const cfg = SERVICE_CONFIG[service] ?? DEFAULT_CONFIG;
  const sizeClasses = {
    xs: 'px-1.5 py-px text-[10px] gap-1',
    sm: 'px-2 py-0.5 text-xs gap-1.5',
    md: 'px-2.5 py-1 text-sm gap-2',
  }[size];
  const iconSize = { xs: 'w-2.5 h-2.5', sm: 'w-3 h-3', md: 'w-3.5 h-3.5' }[size];

  return (
    <span className={cn(
      'inline-flex items-center rounded-full border font-medium',
      cfg.bg, cfg.text, cfg.border,
      sizeClasses,
      className,
    )}>
      <ServiceLogo service={service} className={iconSize} />
      <span>{cfg.label}</span>
    </span>
  );
}

export function ServiceIcon({ service, size = 'md', className }: {
  service: string; size?: 'sm' | 'md' | 'lg'; className?: string;
}) {
  const cfg = SERVICE_CONFIG[service] ?? DEFAULT_CONFIG;
  const sz = { sm: 'w-6 h-6', md: 'w-8 h-8', lg: 'w-10 h-10' }[size];
  const iconSz = { sm: 'w-3 h-3', md: 'w-4 h-4', lg: 'w-5 h-5' }[size];
  return (
    <div className={cn(
      'rounded-xl flex items-center justify-center border flex-shrink-0',
      cfg.bg, cfg.text, cfg.border, sz, className,
    )}>
      <ServiceLogo service={service} className={iconSz} />
    </div>
  );
}

export { SERVICE_CONFIG };
