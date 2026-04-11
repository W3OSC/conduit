/**
 * Conduit app icon — a flow-through gateway mark.
 *
 * Concept: three data streams (parallel lines) enter from the left,
 * converge through a central gateway node (diamond), and exit as a
 * single controlled output on the right. The amber accent on the node
 * marks the human-in-the-loop control point.
 *
 * The overall silhouette reads as a stylised "C" rotated — open on
 * the right — which ties back to the Conduit name.
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
      'rounded-lg bg-amber-gradient flex items-center justify-center flex-shrink-0 shadow-amber',
      SIZE_CLASSES[size],
      className,
    )}>
      <AppIconSvg className={ICON_CLASSES[size]} />
    </div>
  );
}

export function AppIconSvg({ className }: { className?: string }) {
  // Dark foreground that sits on the primary gradient background
  const ink = 'hsl(20 8% 8%)';
  // Inner diamond: bright accent on the gradient background
  const amber = 'rgba(255,255,255,0.85)';

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Conduit"
    >
      {/* ── Three input streams entering from the left ── */}
      {/* Top stream — curves down toward the central node */}
      <path
        d="M2 7 C5 7 7 9.5 9.5 11.5"
        stroke={ink}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeOpacity="0.8"
        fill="none"
      />
      {/* Middle stream — straight through the center */}
      <path
        d="M2 12 L9.5 12"
        stroke={ink}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeOpacity="0.8"
        fill="none"
      />
      {/* Bottom stream — curves up toward the central node */}
      <path
        d="M2 17 C5 17 7 14.5 9.5 12.5"
        stroke={ink}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeOpacity="0.8"
        fill="none"
      />

      {/* ── Central gateway node (diamond) ── */}
      {/* Outer dark diamond */}
      <path
        d="M12 8.5 L15.5 12 L12 15.5 L8.5 12 Z"
        fill={ink}
        fillOpacity="0.85"
      />
      {/* Inner amber diamond — the human-control accent */}
      <path
        d="M12 10.2 L13.8 12 L12 13.8 L10.2 12 Z"
        fill={amber}
      />

      {/* ── Single controlled output exiting right ── */}
      <path
        d="M15.5 12 L22 12"
        stroke={ink}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeOpacity="0.8"
        fill="none"
      />
      {/* Arrow head on the output */}
      <path
        d="M19.5 10 L22 12 L19.5 14"
        stroke={ink}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity="0.8"
        fill="none"
      />
    </svg>
  );
}
