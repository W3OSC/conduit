/**
 * Conduit app icon — a human-in-the-loop gateway/hub mark.
 *
 * Concept: multiple data streams (left arcs) converge through a secure
 * central gateway (shield + lock node), with a single controlled output
 * path on the right. Captures: unified hub, security, human oversight.
 */

import { cn } from '@/lib/utils';

interface AppIconProps {
  className?: string;
  /** Size of the outer container */
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const SIZE_CLASSES = {
  sm: 'w-7 h-7',
  md: 'w-9 h-9',
  lg: 'w-12 h-12',
  xl: 'w-16 h-16',
};

const ICON_CLASSES = {
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-7 h-7',
  xl: 'w-9 h-9',
};

export function AppIcon({ className, size = 'sm' }: AppIconProps) {
  return (
    <div className={cn(
      'rounded-xl bg-amber-gradient flex items-center justify-center flex-shrink-0 shadow-amber',
      SIZE_CLASSES[size],
      className,
    )}>
      <AppIconSvg className={ICON_CLASSES[size]} />
    </div>
  );
}

export function AppIconSvg({ className }: { className?: string }) {
  const fg = 'hsl(20 6% 7%)';

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Conduit"
    >
      {/* ── Shield / gateway outer shape ── */}
      {/* A flat-topped hexagonal shield — wide at top, pointed base */}
      <path
        d="M12 2L20 5.5V13C20 17 16.5 20.5 12 22C7.5 20.5 4 17 4 13V5.5L12 2Z"
        fill={fg}
        fillOpacity="0.85"
      />

      {/* ── Inner gateway opening — lighter negative space ── */}
      {/* The "chamber" the data passes through */}
      <path
        d="M12 4.5L18 7.25V13C18 15.8 15.5 18.4 12 19.8C8.5 18.4 6 15.8 6 13V7.25L12 4.5Z"
        fill={fg}
        fillOpacity="0.12"
      />

      {/* ── Three input streams — left side arcs converging inward ── */}
      {/* Top stream */}
      <path
        d="M6 7.5C7.5 8 8.5 9 9 10.5"
        stroke={fg}
        strokeOpacity="0.7"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Middle stream */}
      <path
        d="M6 10C7.2 10 8.2 10.5 9 11.5"
        stroke={fg}
        strokeOpacity="0.7"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Bottom stream */}
      <path
        d="M6 12.5C7.5 12 8.5 11.5 9 12.5"
        stroke={fg}
        strokeOpacity="0.7"
        strokeWidth="1.2"
        strokeLinecap="round"
      />

      {/* ── Central node — the conduit / control point ── */}
      <circle
        cx="12"
        cy="12"
        r="2.8"
        fill={fg}
        fillOpacity="0.9"
      />

      {/* ── Lock keyhole — human oversight symbol ── */}
      {/* Arc (top of keyhole) */}
      <path
        d="M10.8 11.5A1.2 1.2 0 0 1 13.2 11.5"
        stroke="hsl(38 92% 55%)"
        strokeWidth="0.9"
        strokeLinecap="round"
        fill="none"
      />
      {/* Body of keyhole */}
      <path
        d="M11.3 12H12.7V13.2H11.3V12Z"
        fill="hsl(38 92% 55%)"
        fillOpacity="0.95"
      />

      {/* ── Single controlled output — right side ── */}
      {/* One clean path out — approved, controlled */}
      <path
        d="M15 12C16 11.8 17 11.5 18 11.8"
        stroke={fg}
        strokeOpacity="0.7"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Arrow tip on output */}
      <path
        d="M17 11L18 11.8L17 12.6"
        stroke={fg}
        strokeOpacity="0.7"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
