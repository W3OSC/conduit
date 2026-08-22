import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { PlugZap, ArrowRight } from 'lucide-react';
import Login from '@/pages/Login';
import { api, uiAuth } from '@/lib/api';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { Toaster } from '@/components/shared/Toaster';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useThemeStore, PRIMARY_COLOR_MAP } from '@/store/theme';

// Critical routes — loaded eagerly
import Inbox from '@/pages/Inbox';
import Dashboard from '@/pages/Dashboard';
import Chat from '@/pages/Chat';

// Non-critical routes — lazy-loaded for performance
const Outbox         = lazy(() => import('@/pages/Outbox'));
const Connections    = lazy(() => import('@/pages/Connections'));
const Contacts       = lazy(() => import('@/pages/Contacts'));
const Email          = lazy(() => import('@/pages/Email'));
const Calendar       = lazy(() => import('@/pages/Calendar'));
const TwitterPage    = lazy(() => import('@/pages/Twitter'));
const AuditLog       = lazy(() => import('@/pages/AuditLog'));
const ObsidianVault  = lazy(() => import('@/pages/ObsidianVault'));

// ── Theme Provider ────────────────────────────────────────────────────────────
// Reads the Zustand theme store and reflects it onto the <html> element via
// CSS classes and custom properties. No context needed — the store is global.

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { colorMode, primaryColor, fontSize, borderRadius, reducedMotion } = useThemeStore();

  useEffect(() => {
    const html = document.documentElement;

    // ── Color mode ──
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = colorMode === 'dark' || (colorMode === 'system' && prefersDark);
    html.classList.toggle('dark', isDark);
    html.classList.toggle('light', !isDark);

    // ── Primary color CSS vars ──
    const { hsl } = PRIMARY_COLOR_MAP[primaryColor];
    const [h, s, l] = hsl.split(' ');
    html.style.setProperty('--primary-h', h);
    html.style.setProperty('--primary-s', s);
    html.style.setProperty('--primary-l', l);

    // Light colors (high luminance) look better with dark text on primary bg
    const lVal = parseFloat(l);
    const fgDark = isDark ? '20 6% 7%' : '20 10% 12%';
    const fgLight = '0 0% 100%';
    html.style.setProperty('--primary-fg-dark', fgDark);
    html.style.setProperty('--primary-fg-light', fgLight);
    // Use dark foreground for light primaries (emerald, amber, sky at high L)
    html.style.setProperty(
      '--primary-foreground',
      lVal >= 55 && !isDark ? fgDark : fgLight,
    );

    // ── Font size ──
    html.setAttribute('data-font-size', fontSize);

    // ── Border radius ──
    html.setAttribute('data-radius', borderRadius);

    // ── Reduced motion ──
    html.setAttribute('data-reduced-motion', String(reducedMotion));
  }, [colorMode, primaryColor, fontSize, borderRadius, reducedMotion]);

  // Also react to system preference changes when mode === 'system'
  useEffect(() => {
    if (colorMode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      document.documentElement.classList.toggle('dark', e.matches);
      document.documentElement.classList.toggle('light', !e.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [colorMode]);

  return <>{children}</>;
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-48">
      <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 2,
      // Keep showing the previous page while a filter/search change refetches —
      // no more blank-to-skeleton flicker on every keystroke or tab switch.
      placeholderData: (previousData: unknown) => previousData,
    },
  },
});

// Route-specific copy for the "nothing connected" banner — mirrors each page's
// own in-page empty-state CTA so the two links agree on wording and destination.
const CONNECT_BANNERS: Record<string, { title: string; body: string; to: string }> = {
  '/email':    { title: 'Gmail not connected.',       body: 'Add your Google credentials in Settings → Connections → Google.',         to: '/settings/email-calendar' },
  '/calendar': { title: 'Calendar not connected.',    body: 'Add your Google credentials in Settings → Connections → Google.',         to: '/settings/email-calendar' },
  '/twitter':  { title: 'Twitter / X not connected.', body: 'Add your credentials in Settings → Connections → Messaging.',             to: '/settings/messaging' },
  '/chat':     { title: 'No services connected.',     body: 'Add your credentials in Settings → Connections → Messaging.',             to: '/settings/messaging' },
  '/contacts': { title: 'No services connected.',     body: 'Connect a service in Settings → Connections to start syncing contacts.',  to: '/settings/connections' },
  '/files':    { title: 'No file sources connected.', body: 'Add a vault, drive, or share in Settings → Connections → Files.',         to: '/settings/files' },
};
const DEFAULT_CONNECT_BANNER = {
  title: 'No services connected.',
  body: 'Head to Settings to connect Slack, Discord, Telegram, Google, and more.',
  to: '/settings/connections',
};

function AppInner() {
  useWebSocket();
  const location = useLocation();
  const navigate = useNavigate();

  // Onboarding: with no services connected yet there is nothing to see anywhere
  // else, so land the initial "/" view on the Connections settings and show a
  // persistent CTA banner on every other page.
  const { data: connections } = useQuery({
    queryKey: ['connections'],
    queryFn: api.connections,
    refetchInterval: 30000,
  });
  const nothingConnected = connections
    ? Object.values(connections).every((c) => c.status === 'disconnected')
    : false;

  // Decide the redirect once, when connection statuses first arrive — after
  // that the user is free to navigate anywhere, including back to "/".
  const onboardingDecided = useRef(false);
  useEffect(() => {
    if (!connections || onboardingDecided.current) return;
    onboardingDecided.current = true;
    if (nothingConnected && location.pathname === '/') {
      navigate('/settings/connections', { replace: true });
    }
  }, [connections, nothingConnected, location.pathname, navigate]);

  const showConnectBanner = nothingConnected && !location.pathname.startsWith('/settings');
  const connectBanner = Object.entries(CONNECT_BANNERS).find(([path]) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`),
  )?.[1] ?? DEFAULT_CONNECT_BANNER;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        {showConnectBanner && (
          <Link
            to={connectBanner.to}
            className="flex items-center gap-2.5 px-4 py-2.5 bg-primary/10 border-b border-primary/20 text-sm text-primary hover:bg-primary/15 transition-colors"
          >
            <PlugZap className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="font-medium">{connectBanner.title}</span>{' '}
              <span className="text-primary/80">{connectBanner.body}</span>
            </span>
            <ArrowRight className="w-4 h-4 flex-shrink-0" />
          </Link>
        )}
        <main className="flex-1 overflow-hidden min-h-0 h-full">
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Inbox />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/chat/:service/:chatId" element={<Chat />} />
              <Route path="/outbox" element={<Outbox />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/email" element={<Email />} />
              <Route path="/calendar" element={<Calendar />} />
              <Route path="/twitter" element={<TwitterPage />} />
              <Route path="/connections" element={<Navigate to="/settings/connections" replace />} />
              <Route path="/settings" element={<Navigate to="/settings/connections" replace />} />
              <Route path="/settings/:tab" element={<Connections />} />
              <Route path="/files" element={<ObsidianVault />} />
              <Route path="/audit-log" element={<AuditLog />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      <Toaster />
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<'loading' | 'authenticated' | 'login-required'>('loading');

  const checkAuth = async () => {
    try {
      const status = await uiAuth.status();
      // If no login method is enabled, always authenticated
      if (!status.anyEnabled) {
        setAuthState('authenticated');
        return;
      }
      setAuthState(status.authenticated ? 'authenticated' : 'login-required');
    } catch {
      // On any error (network, server starting up, etc.) default to authenticated.
      // If login is enabled the server will 401 individual API calls and the UI
      // will re-check — but we never want to lock the user out on a transient error.
      setAuthState('authenticated');
    }
  };

  useEffect(() => { checkAuth(); }, []);

  if (authState === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (authState === 'login-required') {
    return <Login onAuthenticated={() => setAuthState('authenticated')} />;
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthGate>
          <AppInner />
        </AuthGate>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
