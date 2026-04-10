/**
 * Meet Notes API routes — CRUD + settings for Google Meet Smart Notes.
 *
 * GET  /api/meet-notes              — list notes (paginated, searchable)
 * GET  /api/meet-notes/settings     — get Drive search toggle setting
 * PUT  /api/meet-notes/settings     — toggle Drive search on/off
 * POST /api/meet-notes/sync         — trigger incremental sync
 * GET  /api/meet-notes/:id          — get single note
 * POST /api/meet-notes/:id/refresh  — re-fetch content from Drive
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { meetNotes, settings } from '../db/schema.js';
import { eq, desc, like, and, or } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();
const DRIVE_SEARCH_SETTING = 'meet_notes.drive_search_enabled';

// ─── List notes ───────────────────────────────────────────────────────────────

router.get('/', optionalAuth, (req, res) => {
  const { limit = '50', offset = '0', q, account_id } = req.query as Record<string, string>;
  const db = getDb();
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;

  let query = db.select().from(meetNotes).$dynamic();

  const conditions = [];
  if (q) {
    conditions.push(or(
      like(meetNotes.title,   `%${q}%`),
      like(meetNotes.summary, `%${q}%`),
    ));
  }
  if (account_id) {
    conditions.push(eq(meetNotes.accountId, account_id));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const notes = query
    .orderBy(desc(meetNotes.meetingDate))
    .limit(lim)
    .offset(off)
    .all();

  // Count total
  const countQuery = db.select().from(meetNotes).$dynamic();
  const total = (conditions.length > 0
    ? countQuery.where(and(...conditions)).all()
    : countQuery.all()
  ).length;

  res.json({ notes, total, limit: lim, offset: off });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', optionalAuth, (req, res) => {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, DRIVE_SEARCH_SETTING)).get();
  const driveSearchEnabled = !row || row.value !== 'false';
  res.json({ driveSearchEnabled });
});

router.put('/settings', optionalAuth, (req, res) => {
  const { driveSearchEnabled } = req.body as { driveSearchEnabled?: boolean };
  if (typeof driveSearchEnabled !== 'boolean') {
    return res.status(400).json({ error: 'driveSearchEnabled must be a boolean' });
  }
  const db = getDb();
  const value = driveSearchEnabled ? 'true' : 'false';
  db.insert(settings)
    .values({ key: DRIVE_SEARCH_SETTING, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
  res.json({ success: true, driveSearchEnabled });
});

// ─── Trigger sync ─────────────────────────────────────────────────────────────

router.post('/sync', optionalAuth, async (_req, res) => {
  try {
    const { getConnectionManager } = await import('../connections/manager.js');
    const manager = getConnectionManager();
    const instances = manager.getAllMeetNotesInstances();
    if (instances.length === 0) {
      return res.status(503).json({ error: 'No Google accounts connected for Meet Notes' });
    }
    let total = 0;
    await Promise.all(instances.map(async (inst) => {
      const n = await inst.incrementalSync();
      total += n;
    }));
    res.json({ success: true, message: `Synced ${total} new note(s)` });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── Single note ──────────────────────────────────────────────────────────────

router.get('/:id', optionalAuth, (req, res) => {
  const db  = getDb();
  const id  = parseInt(req.params['id'] as string);
  const note = db.select().from(meetNotes).where(eq(meetNotes.id, id)).get();
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json(note);
});

// ─── Refresh content from Drive ───────────────────────────────────────────────

router.post('/:id/refresh', optionalAuth, async (req, res) => {
  const db   = getDb();
  const id   = parseInt(req.params['id'] as string);
  const note = db.select().from(meetNotes).where(eq(meetNotes.id, id)).get();
  if (!note) return res.status(404).json({ error: 'Note not found' });
  if (!note.driveFileId) return res.status(400).json({ error: 'No Drive file associated with this note' });

  try {
    const { getConnectionManager } = await import('../connections/manager.js');
    const manager = getConnectionManager();
    const instances = manager.getAllMeetNotesInstances();
    const inst = instances.find((i) => i.accountInfo?.email === note.accountId) ?? instances[0];
    if (!inst) return res.status(503).json({ error: 'No connected instance available' });

    const content = await inst.refreshContent(note.driveFileId);
    res.json({ success: true, content });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
