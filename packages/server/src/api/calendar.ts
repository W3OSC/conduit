/**
 * Calendar API routes.
 * All write actions create outbox items for approval.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { calendarEvents, outbox, type CalendarFineGrained } from '../db/schema.js';
import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, trackAiCall, type AuthedRequest } from '../auth/middleware.js';
import {
  requireRead,
  isSendEnabled,
  isApprovalRequired,
  resolveEffectiveFineGrained,
} from './permissions-utils.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import type { CalendarAction } from '../sync/google-calendar.js';

const router = Router();

/** Per-key calendar allowlist; null = unrestricted. */
function calendarAllowlist(apiKeyId: number | null | undefined): string[] | null {
  if (!apiKeyId) return null;
  const fg = resolveEffectiveFineGrained('calendar', apiKeyId) as CalendarFineGrained | null;
  const ids = fg?.readCalendarIds;
  return ids && ids.length > 0 ? ids : null;
}

// GET /api/calendar/status
router.get('/status', optionalAuth, requireRead('calendar'), (req, res) => {
  const manager = getConnectionManager();
  const status = manager.getStatus('calendar');
  const db = getDb();
  const count = db.select({ count: sql<number>`count(*)` }).from(calendarEvents).get();
  res.json({
    connected: status.status === 'connected',
    status: status.status,
    eventCount: count?.count || 0,
  });
});

// GET /api/calendar/calendars
router.get('/calendars', optionalAuth, requireRead('calendar'), trackAiCall, async (req, res) => {
  const manager = getConnectionManager();
  const calendar = manager.getCalendar();
  if (!calendar) return res.status(503).json({ error: 'Calendar not connected' });

  try {
    let calendars = await calendar.getCalendars();
    const allowlist = calendarAllowlist((req as AuthedRequest).apiKey?.id);
    if (allowlist) {
      calendars = calendars.filter((c: { id?: string | null }) => c.id && allowlist.includes(c.id));
    }
    res.json({ calendars });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /api/calendar/events
router.get('/events', optionalAuth, requireRead('calendar'), trackAiCall, (req, res) => {
  const { from, to, calendarId, limit = '200' } = req.query as Record<string, string>;
  const db = getDb();
  const apiKeyId = (req as AuthedRequest).apiKey?.id ?? null;

  // Default window: today - 7 days to today + 30 days
  const defaultFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const defaultTo   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const conds: SQL[] = [
    gte(calendarEvents.startTime, from || defaultFrom),
    lte(calendarEvents.startTime, to || defaultTo),
  ];

  const allowlist = calendarAllowlist(apiKeyId);
  if (calendarId) {
    if (allowlist && !allowlist.includes(calendarId)) {
      return res.status(403).json({ error: `Reading calendar "${calendarId}" is not permitted for this API key` });
    }
    conds.push(eq(calendarEvents.calendarId, calendarId));
  } else if (allowlist) {
    conds.push(inArray(calendarEvents.calendarId, allowlist));
  }

  const where = and(...conds);
  const lim = Math.min(parseInt(limit) || 200, 500);

  const events = db.select().from(calendarEvents)
    .where(where)
    .orderBy(calendarEvents.startTime)
    .limit(lim)
    .all();
  const totalRow = db.select({ count: sql<number>`count(*)` }).from(calendarEvents).where(where).get();

  res.json({ events, total: totalRow?.count ?? 0 });
});

// GET /api/calendar/events/:id
router.get('/events/:id', optionalAuth, requireRead('calendar'), trackAiCall, (req, res) => {
  const db = getDb();
  const event = db.select().from(calendarEvents)
    .where(eq(calendarEvents.eventId, req.params['id'] as string))
    .get();
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const allowlist = calendarAllowlist((req as AuthedRequest).apiKey?.id);
  if (allowlist && !allowlist.includes(event.calendarId)) {
    return res.status(403).json({ error: 'Reading this event is not permitted for this API key' });
  }
  res.json(event);
});

// POST /api/calendar/actions
router.post('/actions', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const action = req.body as CalendarAction;

  if (!action?.action) return res.status(400).json({ error: 'action is required' });
  if (!action.calendarId) return res.status(400).json({ error: 'calendarId is required' });

  const db = getDb();
  const apiKeyId = authedReq.apiKey?.id ?? null;
  if (!isSendEnabled('calendar', apiKeyId)) {
    return res.status(403).json({ error: 'Calendar actions are not enabled' });
  }

  const status = isApprovalRequired('calendar', apiKeyId) ? 'pending' : 'approved';

  const insertResult = db.insert(outbox).values({
    source: 'calendar',
    recipientId: action.eventId || action.calendarId,
    recipientName: action.title || action.action,
    content: JSON.stringify(action),
    status,
    requester: authedReq.actor,
    apiKeyId: authedReq.apiKey?.id || null,
  }).run();

  const outboxId = insertResult.lastInsertRowid as number;

  writeAuditLog('send_request', authedReq.actor, {
    service: 'calendar',
    targetId: String(outboxId),
    detail: { action: action.action, eventId: action.eventId },
  });

  broadcast({ type: 'outbox:new', data: { id: outboxId, source: 'calendar', status } });

  if (status === 'approved') {
    const manager = getConnectionManager();
    manager.executeCalendarAction(action).then(() => {
      db.update(outbox).set({ status: 'sent', sentAt: new Date().toISOString() })
        .where(eq(outbox.id, outboxId)).run();
      broadcast({ type: 'outbox:updated', data: { id: outboxId, status: 'sent' } });
    }).catch((e: Error) => {
      db.update(outbox).set({ status: 'failed', errorMessage: e.message })
        .where(eq(outbox.id, outboxId)).run();
    });
  }

  res.json({ success: true, outboxItemId: outboxId, status });
});

// POST /api/calendar/sync
router.post('/sync', optionalAuth, requireRead('calendar'), async (req, res) => {
  const manager = getConnectionManager();
  manager.triggerSync('calendar').catch(console.error);
  res.json({ success: true, message: 'Calendar sync started' });
});

export default router;
