import { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Login from '@/pages/Login';
import { uiAuth } from '@/lib/api';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { Toaster } from '@/components/shared/Toaster';
import { useWebSocket } from '@/hooks/useWebSocket';

// Critical routes — loaded eagerly
import Inbox from '@/pages/Inbox';
import Dashboard from '@/pages/Dashboard';
import Chat from '@/pages/Chat';
import AiChat from '@/pages/AiChat';

// Non-critical routes — lazy-loaded for performance
const Outbox         = lazy(() => import('@/pages/Outbox'));
const Connections    = lazy(() => import('@/pages/Connections'));
const Contacts       = lazy(() => import('@/pages/Contacts'));
const Email          = lazy(() => import('@/pages/Email'));
const Calendar       = lazy(() => import('@/pages/Calendar'));
const TwitterPage    = lazy(() => import('@/pages/Twitter'));
const AuditLog       = lazy(() => import('@/pages/AuditLog'));
const ObsidianVault  = lazy(() => import('@/pages/ObsidianVault'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-48">
      <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30000, retry: 2 },
  },
});

function AppInner() {
  useWebSocket();

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-hidden h-full">
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Inbox />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/chat/:service/:chatId" element={<Chat />} />
              <Route path="/ai" element={<AiChat />} />
              <Route path="/outbox" element={<Outbox />} />
              <Route path="/connections" element={<Navigate to="/settings/messaging" replace />} />
              <Route path="/settings" element={<Navigate to="/settings/messaging" replace />} />
              <Route path="/settings/:tab" element={<Connections />} />
              <Route path="/vault" element={<ObsidianVault />} />
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
      // If login is not enabled, always authenticated regardless of session state
      if (!status.enabled) {
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
      <AuthGate>
        <AppInner />
      </AuthGate>
    </QueryClientProvider>
  );
}
