/**
 * MeetNotesSync — syncs Google Meet Gemini notes ("Notes by Gemini", formerly
 * "Meet notes") for a connected Google account.
 *
 * Required OAuth scopes (in addition to Gmail/Calendar scopes):
 *   - https://www.googleapis.com/auth/drive.readonly     (required — discovery)
 *   - https://www.googleapis.com/auth/meetings.space.readonly (optional — attendees)
 *
 * Discovery is Drive-based, because the Meet v2 REST API exposes recordings and
 * transcripts but has no resource for Gemini notes. Three complementary Drive
 * queries are run and merged:
 *   1. Everything in the account's "Meet Recordings" folder(s) — where Meet
 *      files land for meetings the user recorded.
 *   2. A full-text search for "Notes by Gemini" — catches notes docs shared by
 *      other organizers, which never touch the user's own Meet folder.
 *   3. A legacy `name contains 'Meet notes'` prefix query for older docs.
 * Candidates are then filtered by filename so transcripts and recordings from
 * the same folder are ignored.
 *
 * The Meet API is still used, best-effort, to attach the real participant list
 * to each note by matching conference start time. Content is fetched from the
 * Google Docs API and stored as plaintext. Calendar events are matched by time
 * proximity (nearest Meet event within ±2 hours).
 */

import { google } from 'googleapis';
import { getDb } from '../db/client.js';
import { meetNotes, calendarEvents, settings } from '../db/schema.js';
import { eq, and, gte, lte } from 'drizzle-orm';
import type { GmailCreds } from './gmail.js';

/** Setting key predates the rename; it now gates notes the user does not own. */
const SHARED_NOTES_SETTING = 'meet_notes.drive_search_enabled';
const MEET_FOLDER_NAME = 'Meet Recordings';
const DOC_MIME = 'application/vnd.google-apps.document';
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2h for calendar / conference matching

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Drive query timestamps are RFC 3339 — trim sub-second precision. */
function driveTime(iso: string): string {
  return iso.replace(/\.\d+Z$/, 'Z');
}

/** Minutes east of UTC for the zone abbreviations Google puts in Meet filenames. */
const TZ_OFFSET_MIN: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120,
  EET: 120, EEST: 180, MSK: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360,
  PST: -480, PDT: -420, AKST: -540, AKDT: -480, HST: -600,
  AST: -240, ADT: -180, NST: -210, BRT: -180,
  IST: 330, PKT: 300, GST: 240, ICT: 420, SGT: 480, HKT: 480, CSTC: 480,
  JST: 540, KST: 540, AWST: 480, ACST: 570, AEST: 600, ACDT: 630, AEDT: 660,
  NZST: 720, NZDT: 780,
};

/**
 * Meet names its output files "<title> - YYYY/MM/DD HH:MM TZ - Notes by Gemini",
 * where the timestamp is the meeting start. That beats the Drive createdTime,
 * which is stamped when the meeting *ends* and can miss the calendar match by
 * hours on a long call. Returns null when the zone is one we can't resolve.
 */
export function parseMeetingDateFromName(name: string): string | null {
  const m = name.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s+(GMT[+-]\d{1,2}(?::\d{2})?|[A-Z]{2,5})/);
  if (!m) return null;
  const [, y, mo, d, h, min, zone] = m;

  let offsetMin: number | undefined;
  const gmt = zone.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (gmt) {
    offsetMin = (gmt[1] === '-' ? -1 : 1) * (parseInt(gmt[2], 10) * 60 + parseInt(gmt[3] ?? '0', 10));
  } else {
    offsetMin = TZ_OFFSET_MIN[zone];
  }
  if (offsetMin === undefined) return null;

  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +min) - offsetMin * 60_000;
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

/**
 * Meet drops notes, transcripts and recordings into the same folder. Only the
 * notes docs belong here — the rest are separate artefacts with their own size.
 */
export function isNotesDocName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('transcript') || n.includes('recording')) return false;
  return n.includes('notes by gemini') || n.includes('meet notes');
}

/** Extract plain text from a Google Docs API document body. */
function extractDocText(doc: { body?: { content?: Array<{ paragraph?: { elements?: Array<{ textRun?: { content?: string } }> } }> } }): string {
  const parts: string[] = [];
  for (const block of doc.body?.content ?? []) {
    for (const el of block.paragraph?.elements ?? []) {
      const text = el.textRun?.content;
      if (text) parts.push(text);
    }
  }
  return parts.join('').trim();
}

interface MatchedEvent { eventId: string; attendees: string | null }

/**
 * Nearest Meet-linked calendar event within ±2h of the meeting start.
 *
 * calendar_events.start_time is stored with the event's own UTC offset
 * ("2026-08-31T09:00:00-05:00"), so it cannot be compared against a UTC instant
 * as a string. The SQL bounds are therefore a deliberately loose ±1 day window
 * on the date prefix — cheap to index-scan, offset-agnostic — and the real ±2h
 * comparison happens in JS on parsed Dates.
 */
function matchCalendarEvent(meetingDateISO: string | null, accountId: string | null): MatchedEvent | null {
  if (!meetingDateISO) return null;
  const meetingMs = new Date(meetingDateISO).getTime();
  if (!Number.isFinite(meetingMs)) return null;

  const db = getDb();
  const day = 24 * 60 * 60 * 1000;
  const loDate = new Date(meetingMs - MATCH_WINDOW_MS - day).toISOString().slice(0, 10);
  // 'T99' sorts above any real clock time, so this includes all of hiDate.
  const hiDate = new Date(meetingMs + MATCH_WINDOW_MS + day).toISOString().slice(0, 10) + 'T99';

  const where = [gte(calendarEvents.startTime, loDate), lte(calendarEvents.startTime, hiDate)];
  if (accountId) where.push(eq(calendarEvents.accountId, accountId));

  const candidates = db.select({
    eventId: calendarEvents.eventId,
    startTime: calendarEvents.startTime,
    meetLink: calendarEvents.meetLink,
    attendees: calendarEvents.attendees,
  })
    .from(calendarEvents)
    .where(and(...where))
    .all()
    .filter((e) => !!e.meetLink
      && Number.isFinite(new Date(e.startTime ?? '').getTime())
      && Math.abs(new Date(e.startTime!).getTime() - meetingMs) <= MATCH_WINDOW_MS)
    .sort((a, b) =>
      Math.abs(new Date(a.startTime!).getTime() - meetingMs) -
      Math.abs(new Date(b.startTime!).getTime() - meetingMs));

  const best = candidates[0];
  return best ? { eventId: best.eventId, attendees: best.attendees ?? null } : null;
}

interface ConferenceInfo {
  name: string;
  startMs: number;
  participants: Array<{ displayName?: string; id?: string }>;
}

interface DriveCandidate {
  id: string;
  name: string;
  createdTime: string | null;
  webViewLink: string | null;
  ownedByMe: boolean;
}

// ─── Sync class ───────────────────────────────────────────────────────────────

export class MeetNotesSync {
  private auth: InstanceType<typeof google.auth.OAuth2> | null = null;
  private _pollInterval: NodeJS.Timeout | null = null;
  private syncInFlight = false;
  public accountInfo: { email: string } | null = null;
  public connected = false;

  async connect(creds: GmailCreds): Promise<boolean> {
    try {
      const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
      auth.setCredentials({
        access_token:  creds.accessToken,
        refresh_token: creds.refreshToken,
        expiry_date:   creds.tokenExpiry ? new Date(creds.tokenExpiry).getTime() : undefined,
      });

      // Drive is the discovery path, so a Drive probe is the meaningful check.
      const drive = google.drive({ version: 'v3', auth });
      await drive.files.list({ pageSize: 1, fields: 'files(id)' });

      this.auth = auth;
      this.accountInfo = { email: creds.email || 'unknown' };
      this.connected = true;
      console.log(`[meet-notes] Connected for ${creds.email}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[meet-notes] Connect failed for ${creds.email}: ${msg}`);
      this.connected = false;
      return false;
    }
  }

  disconnect(): void {
    this.stopPolling();
    this.auth = null;
    this.connected = false;
  }

  startPolling(intervalMs = 30 * 60 * 1000): void {
    this.stopPolling();
    this._pollInterval = setInterval(() => {
      if (this.syncInFlight) return; // previous cycle still running — skip this tick
      this.syncInFlight = true;
      this.incrementalSync()
        .catch((e) => console.error('[meet-notes] Poll error:', e))
        .finally(() => { this.syncInFlight = false; });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  }

  /** Whether to keep notes docs the account doesn't own (i.e. shared by others). */
  private includeSharedNotes(): boolean {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, SHARED_NOTES_SETTING)).get();
    if (!row) return true; // default on
    return row.value !== 'false';
  }

  // ── Full sync (last N days) ────────────────────────────────────────────────

  async initialFullSync(daysBack = 90): Promise<number> {
    if (!this.auth) return 0;
    console.log(`[meet-notes] Starting full sync for ${this.accountInfo?.email} (${daysBack}d)`);
    const saved = await this.sync(daysAgoISO(daysBack));
    console.log(`[meet-notes] Full sync complete for ${this.accountInfo?.email}: ${saved} notes`);
    return saved;
  }

  // ── Incremental sync (last 7 days) ────────────────────────────────────────

  async incrementalSync(): Promise<number> {
    if (!this.auth) return 0;
    return this.sync(daysAgoISO(7));
  }

  private async sync(since: string): Promise<number> {
    const conferences = await this.loadConferenceIndex(since);
    return this.syncFromDrive(since, conferences);
  }

  // ── Meet REST API — participant enrichment ────────────────────────────────

  /**
   * Conference records for the window, with participants. Best-effort: the Meet
   * scope is optional, and a note is still worth storing without its attendees.
   */
  private async loadConferenceIndex(since: string): Promise<ConferenceInfo[]> {
    if (!this.auth) return [];
    const meet = google.meet({ version: 'v2', auth: this.auth });
    const out: ConferenceInfo[] = [];

    try {
      let pageToken: string | undefined;
      do {
        const res = await meet.conferenceRecords.list({
          filter: `start_time>="${since}"`,
          pageSize: 50,
          ...(pageToken ? { pageToken } : {}),
        });
        pageToken = res.data.nextPageToken ?? undefined;

        for (const record of res.data.conferenceRecords ?? []) {
          if (!record.name || !record.startTime) continue;
          const startMs = new Date(record.startTime).getTime();
          if (!Number.isFinite(startMs)) continue;

          let participants: ConferenceInfo['participants'] = [];
          try {
            const pRes = await meet.conferenceRecords.participants.list({ parent: record.name, pageSize: 50 });
            participants = (pRes.data.participants ?? []).map((p) => {
              const signedIn = p.signedinUser as { displayName?: string | null; user?: string | null } | undefined;
              const anon = (p.anonymousUser ?? p.phoneUser) as { displayName?: string | null } | undefined;
              return {
                displayName: signedIn?.displayName ?? anon?.displayName ?? undefined,
                // `user` is a People API resource id, not an email address.
                id: signedIn?.user ?? undefined,
              };
            });
          } catch { /* participants are best-effort */ }

          out.push({ name: record.name, startMs, participants });
        }
      } while (pageToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('insufficient')) {
        console.warn(`[meet-notes] Meet scope not granted for ${this.accountInfo?.email} — notes will sync without attendee lists.`);
      } else {
        console.warn(`[meet-notes] Conference index unavailable: ${msg}`);
      }
    }

    return out;
  }

  // ── Drive discovery ───────────────────────────────────────────────────────

  /** Folder IDs of every "Meet Recordings" folder visible to the account. */
  private async findMeetFolderIds(): Promise<string[]> {
    if (!this.auth) return [];
    const drive = google.drive({ version: 'v3', auth: this.auth });
    try {
      const res = await drive.files.list({
        q: `name = '${MEET_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        pageSize: 20,
      });
      return (res.data.files ?? []).map((f) => f.id).filter((id): id is string => !!id);
    } catch {
      return [];
    }
  }

  private async runDriveQuery(q: string): Promise<DriveCandidate[]> {
    if (!this.auth) return [];
    const drive = google.drive({ version: 'v3', auth: this.auth });
    const out: DriveCandidate[] = [];
    try {
      let pageToken: string | undefined;
      do {
        const res = await drive.files.list({
          q,
          fields: 'nextPageToken, files(id, name, createdTime, webViewLink, owners(me))',
          // Drive rejects orderBy on fullText queries ("Sorting is not supported
          // for queries with fullText terms"); order is irrelevant here anyway
          // since every page is consumed and candidates are deduped by id.
          ...(q.includes('fullText') ? {} : { orderBy: 'createdTime desc' }),
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        });
        pageToken = res.data.nextPageToken ?? undefined;
        for (const f of res.data.files ?? []) {
          if (!f.id || !f.name) continue;
          out.push({
            id: f.id,
            name: f.name,
            createdTime: f.createdTime ?? null,
            webViewLink: f.webViewLink ?? null,
            ownedByMe: (f.owners ?? []).some((o) => o.me === true),
          });
        }
      } while (pageToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[meet-notes] Drive query failed (${q}): ${msg}`);
    }
    return out;
  }

  private async syncFromDrive(since: string, conferences: ConferenceInfo[]): Promise<number> {
    if (!this.auth) return 0;
    const db = getDb();
    const sinceDrive = driveTime(since);
    const base = `mimeType = '${DOC_MIME}' and trashed = false and createdTime > '${sinceDrive}'`;

    const queries: string[] = [];
    for (const folderId of await this.findMeetFolderIds()) {
      queries.push(`${base} and '${folderId}' in parents`);
    }
    // Notes shared by other organizers never land in this account's Meet folder;
    // fullText covers the document title as well as its body.
    queries.push(`${base} and fullText contains 'Notes by Gemini'`);
    // Legacy naming — Drive only prefix-matches `name`, so this is exact-prefix.
    queries.push(`${base} and name contains 'Meet notes'`);

    const includeShared = this.includeSharedNotes();
    const candidates = new Map<string, DriveCandidate>();
    for (const q of queries) {
      for (const file of await this.runDriveQuery(q)) {
        if (!isNotesDocName(file.name)) continue;
        if (!includeShared && !file.ownedByMe) continue;
        if (!candidates.has(file.id)) candidates.set(file.id, file);
      }
    }

    if (candidates.size === 0) {
      console.log(`[meet-notes] No notes docs found for ${this.accountInfo?.email} since ${sinceDrive}`);
      return 0;
    }

    let saved = 0;
    for (const file of candidates.values()) {
      const noteId = `drive:${file.id}`;
      const meetingDate = parseMeetingDateFromName(file.name) ?? file.createdTime;

      // Skip the Docs fetch when we already have the content for this file.
      const existing = db.select({ id: meetNotes.id, summary: meetNotes.summary })
        .from(meetNotes).where(eq(meetNotes.noteId, noteId)).get();

      let summary: string | null = existing?.summary ?? null;
      let title: string = file.name;
      if (!summary) {
        try {
          const docs = google.docs({ version: 'v1', auth: this.auth });
          const docRes = await docs.documents.get({ documentId: file.id });
          summary = extractDocText(docRes.data as Parameters<typeof extractDocText>[0]);
          title = docRes.data.title ?? title;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[meet-notes] Content fetch failed for ${file.name}: ${msg}`);
        }
      }

      const conference = this.matchConference(meetingDate, conferences);
      const event = matchCalendarEvent(meetingDate, this.accountInfo?.email ?? null);
      const attendees = conference?.participants.length
        ? JSON.stringify(conference.participants)
        : event?.attendees ?? null;

      const now = new Date().toISOString();
      db.insert(meetNotes).values({
        noteId,
        source: 'drive',
        accountId: this.accountInfo?.email ?? null,
        conferenceId: conference?.name ?? null,
        title,
        summary,
        docsUrl: file.webViewLink ?? null,
        driveFileId: file.id,
        meetingDate,
        calendarEventId: event?.eventId ?? null,
        attendees,
        state: 'ENDED',
        rawJson: JSON.stringify(file),
        updatedAt: now,
      }).onConflictDoUpdate({
        target: meetNotes.noteId,
        set: {
          title,
          summary: summary ?? undefined,
          meetingDate: meetingDate ?? undefined,
          conferenceId: conference?.name ?? undefined,
          calendarEventId: event?.eventId ?? undefined,
          attendees: attendees ?? undefined,
          updatedAt: now,
        },
      }).run();

      if (!existing) saved++;
    }

    console.log(`[meet-notes] ${this.accountInfo?.email}: ${candidates.size} notes doc(s) seen, ${saved} new`);
    return saved;
  }

  /** Nearest conference record within ±2h of the meeting start. */
  private matchConference(meetingDateISO: string | null, conferences: ConferenceInfo[]): ConferenceInfo | null {
    if (!meetingDateISO || conferences.length === 0) return null;
    const ms = new Date(meetingDateISO).getTime();
    if (!Number.isFinite(ms)) return null;
    let best: ConferenceInfo | null = null;
    let bestDelta = MATCH_WINDOW_MS;
    for (const c of conferences) {
      const delta = Math.abs(c.startMs - ms);
      if (delta <= bestDelta) { best = c; bestDelta = delta; }
    }
    return best;
  }

  // ── On-demand content refresh ──────────────────────────────────────────────

  async refreshContent(driveFileId: string): Promise<string | null> {
    if (!this.auth || !driveFileId) return null;
    try {
      const docs = google.docs({ version: 'v1', auth: this.auth });
      const docRes = await docs.documents.get({ documentId: driveFileId });
      const content = extractDocText(docRes.data as Parameters<typeof extractDocText>[0]);
      const db = getDb();
      db.update(meetNotes)
        .set({ summary: content, updatedAt: new Date().toISOString() })
        .where(eq(meetNotes.driveFileId, driveFileId))
        .run();
      return content;
    } catch {
      return null;
    }
  }
}
