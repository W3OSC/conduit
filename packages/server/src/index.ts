import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from './db/client.js';
import { initWebSocketServer } from './websocket/hub.js';
import { getConnectionManager } from './connections/manager.js';
import apiRouter from './api/router.js';
import uiAuthRouter, { uiAuthMiddleware } from './api/ui-auth.js';
import { csrfMiddleware } from './auth/csrf.js';
import { startUpdatePoller } from './update/checker.js';
import { bootstrapContactsIfEmpty } from './sync/contacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Suppress noisy unhandled rejections from GramJS's internal update loop.
// These are normal Telegram network conditions or known GramJS quirks that
// GramJS retries internally — they don't need to surface as process errors.
// - TIMEOUT / FLOOD_WAIT / CONNECTION_RESET: transient network conditions
// - AUTH_KEY_UNREGISTERED: session expired, handled by reconnect logic
// - builder.resolve / builder.build: GramJS bug dispatching unknown update
//   constructors (UpdatesTooLong etc.) — not fatal and not fixable upstream
const TRANSIENT_PATTERNS = [
  'TIMEOUT', 'FLOOD_WAIT', 'CONNECTION_RESET', 'AUTH_KEY_UNREGISTERED',
  'builder.resolve is not a function',
  'builder.build is not a function',
  '_dispatchUpdate',
];
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error
    ? `${reason.message} ${reason.stack || ''}`
    : String(reason);
  if (TRANSIENT_PATTERNS.some((p) => msg.includes(p))) return; // silently swallow
  console.error('[conduit] Unhandled rejection:', reason);
});

const PORT = parseInt(process.env.PORT || '3101');
// In dev (tsx): __dirname = packages/server/src  → ../../client/dist = packages/client/dist ✓
// In Docker (node dist/): CLIENT_DIST env var is set explicitly to /app/packages/client/dist
const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '../../client/dist');

async function main() {
  console.log('[conduit] Starting Conduit server...');

  // Run database migrations
  await runMigrations();

  const app = express();
  const server = createServer(app);

  // Security headers — applied to every response
  app.use((_req, res, next) => {
    // Prevent MIME-type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Prevent embedding in iframes (clickjacking)
    res.setHeader('X-Frame-Options', 'DENY');
    // Don't send referrer to external origins
    res.setHeader('Referrer-Policy', 'same-origin');
    // Minimal CSP: block plugins/objects and restrict base tag hijacking
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; object-src 'none'; base-uri 'self'; img-src 'self' data: https:; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';",
    );
    next();
  });

  // Middleware
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  // UI auth routes (always accessible — handles login/logout/status)
  app.use('/api/ui-auth', uiAuthRouter);

  // UI auth gate — returns 401 when login is enabled and user is not authenticated
  app.use(uiAuthMiddleware);

  // CSRF protection — double-submit cookie pattern for UI session requests
  app.use(csrfMiddleware);

  // API routes
  app.use('/api', apiRouter);

  // Serve built React app in production
  try {
    const { existsSync } = await import('fs');
    if (existsSync(CLIENT_DIST)) {
      app.use(express.static(CLIENT_DIST));
      app.get('/*path', (req, res) => {
        res.sendFile(path.join(CLIENT_DIST, 'index.html'));
      });
    }
  } catch { /* no client build yet */ }

  // Initialize WebSocket server
  initWebSocketServer(server);

  // Start server
  server.listen(PORT, () => {
    console.log(`[conduit] Server running on http://localhost:${PORT}`);
    console.log(`[conduit] API available at http://localhost:${PORT}/api`);
    console.log(`[conduit] WebSocket available at ws://localhost:${PORT}/ws`);
  });

  const manager = getConnectionManager();

  // Auto-connect all services that have stored credentials.
  // Fire-and-forget: connections run in the background, the HTTP server is
  // already accepting requests so the UI can render immediately.
  manager.connectAll().catch((e) => console.error('[conduit] connectAll error:', e));

  // Bootstrap contacts from existing messages for any source that has messages
  // but no contacts yet (e.g. after a direct DB import or first run).
  try { bootstrapContactsIfEmpty(); } catch (e) { console.error('[contacts] Bootstrap error:', e); }

  // Start the background update poller (checks for new commits every hour)
  startUpdatePoller();

  // Periodic unread re-sync — every 5 minutes, re-fetch unread counts from all
  // connected platforms so that cross-device reads (on phone/desktop apps) are
  // reflected in conduit even if a real-time event was missed.
  const UNREAD_RESYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  setInterval(async () => {
    try {
      const slack = manager.getSlack();
      if (slack?.connected) slack.fetchUnreadCounts().catch((e) => console.error('[unread] Slack resync error:', e));

      const telegram = manager.getTelegram();
      if (telegram?.connected) telegram.fetchUnreadCounts().catch((e) => console.error('[unread] Telegram resync error:', e));

      // Discord: only mute state needs re-syncing (no unread counts)
      const discord = manager.getDiscord();
      if (discord?.connected) discord.fetchUnreadCounts().catch((e) => console.error('[unread] Discord resync error:', e));

      // Gmail: recompute per-thread counts from local DB (no API call needed)
      for (const gmail of manager.getAllGmailInstances()) {
        if (gmail.connected) gmail.fetchUnreadCounts();
      }
    } catch (e) {
      console.error('[unread] Periodic resync error:', e);
    }
  }, UNREAD_RESYNC_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[conduit] Received ${signal}, shutting down...`);
    await manager.disconnectAll();
    server.close(() => {
      console.log('[conduit] Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[conduit] Fatal error:', e);
  process.exit(1);
});
