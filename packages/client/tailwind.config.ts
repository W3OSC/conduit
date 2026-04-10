import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border:     'hsl(var(--border))',
        input:      'hsl(var(--input))',
        ring:       'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        sidebar: { DEFAULT: 'hsl(var(--sidebar))', foreground: 'hsl(var(--sidebar-foreground))', border: 'hsl(var(--sidebar-border))' },
        slack: '#7C3AED', discord: '#5865F2', telegram: '#0EA5E9',
        warm: {
          50: 'hsl(30 20% 96%)', 100: 'hsl(28 15% 88%)', 200: 'hsl(26 12% 72%)',
          300: 'hsl(24 10% 58%)', 400: 'hsl(22 9% 44%)', 500: 'hsl(20 8% 32%)',
          600: 'hsl(20 8% 22%)', 700: 'hsl(20 7% 16%)', 800: 'hsl(20 7% 12%)',
          900: 'hsl(20 6% 8%)', 950: 'hsl(20 6% 5%)',
        },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)', xl: 'calc(var(--radius) + 4px)', '2xl': 'calc(var(--radius) + 8px)' },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'] },
      fontSize: { '2xs': ['0.6875rem', { lineHeight: '1rem' }] },
      boxShadow: {
        'warm-sm': '0 1px 3px hsl(20 6% 4% / 0.4)',
        'warm-md': '0 4px 16px hsl(20 6% 4% / 0.5)',
        'warm-lg': '0 8px 32px hsl(20 6% 4% / 0.6)',
        'amber': '0 0 24px hsl(38 92% 55% / 0.18)',
        'inner-warm': 'inset 0 1px 2px hsl(20 6% 4% / 0.35)',
        'inner-light': 'inset 0 1px 0 hsl(0 0% 100% / 0.05)',
      },
      backgroundImage: {
        'amber-gradient': 'linear-gradient(135deg, hsl(38 92% 58%) 0%, hsl(34 88% 48%) 100%)',
        'warm-surface': 'linear-gradient(180deg, hsl(20 6% 12%) 0%, hsl(20 6% 10%) 100%)',
      },
      animation: {
        'fade-in': 'fadeIn 0.22s ease-out both',
        'slide-up': 'slideUp 0.24s ease-out both',
        'pulse-soft': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 1.4s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
      },
    },
  },
  plugins: [],
} satisfies Config;
