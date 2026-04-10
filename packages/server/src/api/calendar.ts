/**
 * Calendar API routes.
 * All write actions create outbox items for approval.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { calendarEvents, outbox, permissions } from '../db/schema.js';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import type { CalendarAction } from '../sync/google-calendar.js';

const router = Router();

// GET /api/calendar/status
router.get('/status', optionalAuth, (req, res) => {
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
router.get('/calendars', optionalAuth, async (req, res) => {
  const manager = getConnectionManager();
  const calendar = manager.getCalendar();
  if (!calendar) return res.status(503).json({ error: 'Calendar not connected' });

  try {
    const calendars = await calendar.getCalendars();
    res.json({ calendars });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /api/calendar/events
router.get('/events', optionalAuth, (req, res) => {
  const { from, to, calendarId, limit = '200' } = req.query as Record<string, string>;
  const db = getDb();

  let rows = db.select().from(calendarEvents)
    .orderBy(calendarEvents.startTime)
    .all();

  // Default: today - 7 days to today + 30 days
  const defaultFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const defaultTo   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const filterFrom = from || defaultFrom;
  const filterTo   = to   || defaultTo;

  rows = rows.filter((e) => e.startTime >= filterFrom && e.startTime <= filterTo);
  if (calendarId) rows = rows.filter((e) => e.calendarId === calendarId);

  const lim = Math.min(parseInt(limit) || 200, 500);
  res.json({ events: rows.slice(0, lim), total: rows.length });
});

// GET /api/calendar/events/:id
router.get('/events/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const event = db.select().from(calendarEvents)
    .where(eq(calendarEvents.eventId, req.params['id'] as string))
    .get();
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

// POST /api/calendar/actions
router.post('/actions', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const action = req.body as CalendarAction;

  if (!action?.action) return res.status(400).json({ error: 'action is required' });
  if (!action.calendarId) return res.status(400).json({ error: 'calendarId is required' });

  const db = getDb();
  const perm = db.select().from(permissions).where(eq(permissions.service, 'calendar')).get();
  if (!perm?.sendEnabled) {
    return res.status(403).json({ error: 'Calendar actions are not enabled' });
  }

  const status = perm.requireApproval ? 'pending' : 'approved';

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
router.post('/sync', optionalAuth, async (req, res) => {
  const manager = getConnectionManager();
  manager.triggerSync('calendar').catch(console.error);
  res.json({ success: true, message: 'Calendar sync started' });
});

export default router;
