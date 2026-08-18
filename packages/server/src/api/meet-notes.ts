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
import { eq, desc, gte, like, lte, and, or, sql } from 'drizzle-orm';
import { optionalAuth, uiOnlyAuth, trackAiCall } from '../auth/middleware.js';
import { requireRead } from './permissions-utils.js';
import {
  z, intParam, isoDateTime, paginationSchema,
  bodyOf, paramsOf, queryOf, validateBody, validateParams, validateQuery,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';

const router = Router();
const DRIVE_SEARCH_SETTING = 'meet_notes.drive_search_enabled';

// ── Request schemas ───────────────────────────────────────────────────────────

const ListQuery = z.object({
  q: z.string().optional().openapi({ description: 'Substring match on title and summary.' }),
  account_id: z.string().optional().openapi({ description: 'Restrict to one Google account.' }),
  from: isoDateTime.optional().openapi({ description: 'Only meetings on or after this instant.' }),
  to: isoDateTime.optional().openapi({ description: 'Only meetings on or before this instant.' }),
  ...paginationSchema(50, 200),
});

const NoteIdParam = z.object({ id: intParam('meet note') });

const SettingsBody = z.object({
  driveSearchEnabled: z.boolean({ error: 'must be a boolean' }),
});

documentRoute({ method: 'get', path: '/meet-notes', query: ListQuery });
documentRoute({ method: 'get', path: '/meet-notes/{id}', params: NoteIdParam });
documentRoute({ method: 'post', path: '/meet-notes/{id}/refresh', params: NoteIdParam });
documentRoute({ method: 'put', path: '/meet-notes/settings', body: SettingsBody });

// ─── List notes ───────────────────────────────────────────────────────────────

router.get('/', optionalAuth, requireRead('calendar'), trackAiCall, validateQuery(ListQuery), (req, res) => {
  const { limit: lim, offset: off, q, account_id, from, to } = queryOf(ListQuery, req);
  const db = getDb();

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
  // Date-range filtering (ISO timestamps) — without this, "meetings from the
  // past two weeks" forces agents to page through full transcripts.
  if (from) conditions.push(gte(meetNotes.meetingDate, from));
  if (to)   conditions.push(lte(meetNotes.meetingDate, to));

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const notes = query
    .orderBy(desc(meetNotes.meetingDate))
    .limit(lim)
    .offset(off)
    .all();

  let countQuery = db.select({ count: sql<number>`count(*)` }).from(meetNotes).$dynamic();
  if (conditions.length > 0) countQuery = countQuery.where(and(...conditions));
  const total = countQuery.get()?.count ?? 0;

  res.json({ notes, total, limit: lim, offset: off });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', optionalAuth, requireRead('calendar'), (req, res) => {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, DRIVE_SEARCH_SETTING)).get();
  const driveSearchEnabled = !row || row.value !== 'false';
  res.json({ driveSearchEnabled });
});

router.put('/settings', uiOnlyAuth, validateBody(SettingsBody), (req, res) => {
  const { driveSearchEnabled } = bodyOf(SettingsBody, req);
  const db = getDb();
  const value = driveSearchEnabled ? 'true' : 'false';
  db.insert(settings)
    .values({ key: DRIVE_SEARCH_SETTING, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
  res.json({ success: true, driveSearchEnabled });
});

// ─── Trigger sync ─────────────────────────────────────────────────────────────

router.post('/sync', optionalAuth, requireRead('calendar'), async (_req, res) => {
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

router.get('/:id', optionalAuth, requireRead('calendar'), trackAiCall, validateParams(NoteIdParam), (req, res) => {
  const db  = getDb();
  const { id } = paramsOf(NoteIdParam, req);
  const note = db.select().from(meetNotes).where(eq(meetNotes.id, id)).get();
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json(note);
});

// ─── Refresh content from Drive ───────────────────────────────────────────────

router.post('/:id/refresh', optionalAuth, requireRead('calendar'), validateParams(NoteIdParam), async (req, res) => {
  const db   = getDb();
  const { id } = paramsOf(NoteIdParam, req);
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
