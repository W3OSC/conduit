import { Monitor, Moon, Sun, RotateCcw, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useThemeStore,
  PRIMARY_COLOR_MAP,
  type ColorMode,
  type PrimaryColor,
  type FontSize,
  type BorderRadius,
} from '@/store/theme';

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Color Mode ────────────────────────────────────────────────────────────────

const COLOR_MODE_OPTIONS: { id: ColorMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'light',  label: 'Light',  icon: Sun     },
  { id: 'dark',   label: 'Dark',   icon: Moon    },
  { id: 'system', label: 'System', icon: Monitor },
];

function ColorModeSelector() {
  const { colorMode, setColorMode } = useThemeStore();

  return (
    <div className="grid grid-cols-3 gap-2">
      {COLOR_MODE_OPTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => setColorMode(id)}
          className={cn(
            'flex flex-col items-center gap-2 p-3 rounded-xl border transition-all duration-150',
            colorMode === id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary hover:border-border/80',
          )}
        >
          <Icon className="w-5 h-5" />
          <span className="text-xs font-medium">{label}</span>
          {colorMode === id && (
            <span className="sr-only">Selected</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Primary Color ─────────────────────────────────────────────────────────────

function PrimaryColorSelector() {
  const { primaryColor, setPrimaryColor } = useThemeStore();

  return (
    <div className="flex flex-wrap gap-2.5">
      {(Object.entries(PRIMARY_COLOR_MAP) as [PrimaryColor, typeof PRIMARY_COLOR_MAP[PrimaryColor]][]).map(
        ([id, { name, hex }]) => (
          <button
            key={id}
            onClick={() => setPrimaryColor(id)}
            title={name}
            className={cn(
              'relative w-8 h-8 rounded-full transition-all duration-150',
              'ring-offset-2 ring-offset-background',
              primaryColor === id
                ? 'ring-2 scale-110'
                : 'hover:scale-105 hover:ring-1 ring-white/30',
            )}
            style={{
              backgroundColor: hex,
              ...(primaryColor === id ? { ringColor: hex } : {}),
            }}
          >
            {primaryColor === id && (
              <Check
                className="absolute inset-0 m-auto w-4 h-4"
                style={{ color: isLightColor(hex) ? '#111' : '#fff' }}
                strokeWidth={3}
              />
            )}
            <span className="sr-only">{name}</span>
          </button>
        )
      )}
    </div>
  );
}

/** Very rough luminance check — used to pick contrasting checkmark color. */
function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160;
}

// ── Font Size ─────────────────────────────────────────────────────────────────

const FONT_SIZE_OPTIONS: { id: FontSize; label: string; preview: string }[] = [
  { id: 'sm', label: 'Small',   preview: 'Aa' },
  { id: 'md', label: 'Default', preview: 'Aa' },
  { id: 'lg', label: 'Large',   preview: 'Aa' },
];

function FontSizeSelector() {
  const { fontSize, setFontSize } = useThemeStore();

  return (
    <div className="grid grid-cols-3 gap-2">
      {FONT_SIZE_OPTIONS.map(({ id, label, preview }) => (
        <button
          key={id}
          onClick={() => setFontSize(id)}
          className={cn(
            'flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border transition-all duration-150',
            fontSize === id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary',
          )}
        >
          <span
            className="font-semibold leading-none"
            style={{
              fontSize: id === 'sm' ? '0.875rem' : id === 'md' ? '1rem' : '1.25rem',
            }}
          >
            {preview}
          </span>
          <span className="text-[11px] font-medium">{label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Border Radius ─────────────────────────────────────────────────────────────

const RADIUS_OPTIONS: { id: BorderRadius; label: string; radius: string }[] = [
  { id: 'sharp',   label: 'Sharp',   radius: '4px'  },
  { id: 'default', label: 'Default', radius: '12px' },
  { id: 'round',   label: 'Round',   radius: '20px' },
];

function BorderRadiusSelector() {
  const { borderRadius, setBorderRadius } = useThemeStore();

  return (
    <div className="grid grid-cols-3 gap-2">
      {RADIUS_OPTIONS.map(({ id, label, radius }) => (
        <button
          key={id}
          onClick={() => setBorderRadius(id)}
          className={cn(
            'flex flex-col items-center gap-2 py-3 px-2 border transition-all duration-150',
            borderRadius === id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary',
          )}
          style={{ borderRadius: radius }}
        >
          {/* Preview square */}
          <div
            className={cn(
              'w-7 h-7 border-2 transition-colors',
              borderRadius === id ? 'border-primary' : 'border-current opacity-50',
            )}
            style={{ borderRadius: radius }}
          />
          <span className="text-[11px] font-medium">{label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Toggle row ────────────────────────────────────────────────────────────────

function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent',
          'transition-colors duration-200 focus:outline-none',
          checked ? 'bg-primary' : 'bg-secondary',
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow',
            'transition-transform duration-200',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AppearanceTab() {
  const {
    reducedMotion, setReducedMotion,
    sidebarCompact, setSidebarCompact,
    reset,
  } = useThemeStore();

  return (
    <div className="space-y-8">

      {/* Color mode */}
      <Section
        title="Color mode"
        description="Choose between light, dark, or follow the system preference."
      >
        <ColorModeSelector />
      </Section>

      {/* Primary color */}
      <Section
        title="Accent color"
        description="The primary accent color used throughout the interface."
      >
        <PrimaryColorSelector />
        <ColorPreviewBar />
      </Section>

      {/* Font size */}
      <Section
        title="Text size"
        description="Base font size for the entire interface."
      >
        <FontSizeSelector />
      </Section>

      {/* Border radius */}
      <Section
        title="Corner style"
        description="Controls how rounded UI elements appear."
      >
        <BorderRadiusSelector />
      </Section>

      {/* Toggles */}
      <Section title="Accessibility &amp; layout">
        <div className="rounded-xl border border-border divide-y divide-border">
          <div className="px-4">
            <ToggleRow
              label="Reduce motion"
              description="Minimizes animations and transitions across the UI."
              checked={reducedMotion}
              onChange={setReducedMotion}
            />
          </div>
          <div className="px-4">
            <ToggleRow
              label="Compact sidebar"
              description="Hides labels in the sidebar, showing only icons."
              checked={sidebarCompact}
              onChange={setSidebarCompact}
            />
          </div>
        </div>
      </Section>

      {/* Reset */}
      <div className="pt-2 border-t border-border">
        <button
          onClick={reset}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

// ── Color preview bar ─────────────────────────────────────────────────────────

function ColorPreviewBar() {
  const { primaryColor } = useThemeStore();
  const { hex, name } = PRIMARY_COLOR_MAP[primaryColor];

  return (
    <div className="flex items-center gap-3 mt-3 px-3 py-2.5 rounded-xl border border-border bg-secondary/30">
      <div
        className="w-4 h-4 rounded-full flex-shrink-0 ring-1 ring-black/10"
        style={{ backgroundColor: hex }}
      />
      <p className="text-xs text-muted-foreground">
        Active accent: <span className="text-foreground font-medium">{name}</span>
      </p>
      {/* Mini preview of primary-colored elements */}
      <div className="ml-auto flex items-center gap-2">
        <div
          className="px-2 py-0.5 rounded text-[10px] font-semibold text-white"
          style={{ backgroundColor: hex }}
        >
          Button
        </div>
        <div
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: hex, boxShadow: `0 0 0 3px ${hex}33` }}
        />
      </div>
    </div>
  );
}
