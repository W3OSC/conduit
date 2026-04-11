import { create } from 'zustand';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ColorMode = 'dark' | 'light' | 'system';

export type PrimaryColor =
  | 'amber'
  | 'blue'
  | 'violet'
  | 'emerald'
  | 'rose'
  | 'orange'
  | 'sky'
  | 'indigo';

export type FontSize = 'sm' | 'md' | 'lg';
export type BorderRadius = 'sharp' | 'default' | 'round';

export interface ThemeSettings {
  colorMode: ColorMode;
  primaryColor: PrimaryColor;
  fontSize: FontSize;
  borderRadius: BorderRadius;
  reducedMotion: boolean;
  sidebarCompact: boolean;
}

// ── Primary color definitions ─────────────────────────────────────────────────
// Each entry provides the HSL triplet used for --primary and --ring.
// (hue saturation lightness) — no parens, just the raw HSL values.

export const PRIMARY_COLOR_MAP: Record<PrimaryColor, { hsl: string; name: string; hex: string }> = {
  amber:   { hsl: '38 92% 55%',  name: 'Amber',   hex: '#F59E0B' },
  blue:    { hsl: '217 91% 60%', name: 'Blue',     hex: '#3B82F6' },
  violet:  { hsl: '263 70% 58%', name: 'Violet',   hex: '#7C3AED' },
  emerald: { hsl: '160 84% 39%', name: 'Emerald',  hex: '#10B981' },
  rose:    { hsl: '350 89% 60%', name: 'Rose',     hex: '#F43F5E' },
  orange:  { hsl: '25 95% 53%',  name: 'Orange',   hex: '#F97316' },
  sky:     { hsl: '199 89% 48%', name: 'Sky',      hex: '#0EA5E9' },
  indigo:  { hsl: '239 84% 67%', name: 'Indigo',   hex: '#6366F1' },
};

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'conduit-theme';

function loadFromStorage(): Partial<ThemeSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<ThemeSettings>;
  } catch {
    return {};
  }
}

function saveToStorage(settings: ThemeSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS: ThemeSettings = {
  colorMode: 'dark',
  primaryColor: 'amber',
  fontSize: 'md',
  borderRadius: 'default',
  reducedMotion: false,
  sidebarCompact: false,
};

// ── Store ─────────────────────────────────────────────────────────────────────

interface ThemeStore extends ThemeSettings {
  setColorMode: (mode: ColorMode) => void;
  setPrimaryColor: (color: PrimaryColor) => void;
  setFontSize: (size: FontSize) => void;
  setBorderRadius: (radius: BorderRadius) => void;
  setReducedMotion: (v: boolean) => void;
  setSidebarCompact: (v: boolean) => void;
  reset: () => void;
}

const saved = loadFromStorage();
const initial: ThemeSettings = { ...DEFAULTS, ...saved };

function makeUpdater(
  get: () => ThemeStore,
  set: (partial: Partial<ThemeStore>) => void,
) {
  return (partial: Partial<ThemeSettings>) => {
    set(partial);
    saveToStorage({ ...get(), ...partial });
  };
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  const update = (partial: Partial<ThemeSettings>) => {
    set(partial);
    saveToStorage({ ...get(), ...partial });
  };

  return {
    ...initial,

    setColorMode:    (colorMode)    => update({ colorMode }),
    setPrimaryColor: (primaryColor) => update({ primaryColor }),
    setFontSize:     (fontSize)     => update({ fontSize }),
    setBorderRadius: (borderRadius) => update({ borderRadius }),
    setReducedMotion:(reducedMotion)=> update({ reducedMotion }),
    setSidebarCompact:(sidebarCompact) => update({ sidebarCompact }),

    reset: () => {
      set(DEFAULTS);
      saveToStorage(DEFAULTS);
    },
  };
});
