/**
 * MeetNotesSync — syncs Google Meet Smart Notes (Gemini AI-generated summaries)
 * for a connected Google account.
 *
 * Required OAuth scopes (in addition to Gmail/Calendar scopes):
 *   - https://www.googleapis.com/auth/meetings.space.readonly
 *   - https://www.googleapis.com/auth/drive.readonly
 *
 * Discovery strategy:
 *   1. Meet REST API — list conferenceRecords, then smartNotes per record.
 *      This covers meetings the user ORGANIZED.
 *   2. Google Drive search (optional, toggleable) — search for "Meet notes"
 *      documents shared with the user. This covers meetings organized by others.
 *
 * Content is fetched from the Google Docs API and stored as plaintext in the DB.
 * Calendar event matching is attempted by time proximity (±2 hours) and meetLink.
 */

import { google } from 'googleapis';
import { getDb } from '../db/client.js';
import { meetNotes, calendarEvents, settings } from '../db/schema.js';
import { eq, and, gte, desc } from 'drizzle-orm';
import type { GmailCreds } from './gmail.js';

const DRIVE_SEARCH_SETTING = 'meet_notes.drive_search_enabled';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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

/** Try to match a note's meeting date to a calendar event (±2h window + meetLink). */
function matchCalendarEvent(meetingDateISO: string | null, accountId: string | null): string | null {
  if (!meetingDateISO) return null;
  const db = getDb();
  const meetingMs = new Date(meetingDateISO).getTime();
  const windowMs  = 2 * 60 * 60 * 1000; // ±2 hours
  const from = new Date(meetingMs - windowMs).toISOString();
  const to   = new Date(meetingMs + windowMs).toISOString();

  const event = db.select({ eventId: calendarEvents.eventId, startTime: calendarEvents.startTime, meetLink: calendarEvents.meetLink })
    .from(calendarEvents)
    .where(and(gte(calendarEvents.startTime, from)))
    .all()
    .find((e) => {
      const start = new Date(e.startTime ?? '').getTime();
      return Math.abs(start - meetingMs) <= windowMs && !!e.meetLink;
    });

  return event?.eventId ?? null;
}

// ─── Sync class ───────────────────────────────────────────────────────────────

export class MeetNotesSync {
  private auth: InstanceType<typeof google.auth.OAuth2> | null = null;
  private _pollInterval: NodeJS.Timeout | null = null;
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

      // Verify the token has the necessary scopes by doing a lightweight probe.
      // We use the Drive API (files.list with pageSize=1) as it's lightweight.
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
      this.incrementalSync().catch((e) => console.error('[meet-notes] Poll error:', e));
    }, intervalMs);
  }

  stopPolling(): void {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  }

  private isDriveSearchEnabled(): boolean {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, DRIVE_SEARCH_SETTING)).get();
    if (!row) return true; // default on
    return row.value !== 'false';
  }

  // ── Full sync (last N days) ────────────────────────────────────────────────

  async initialFullSync(daysBack = 90): Promise<void> {
    if (!this.auth) return;
    console.log(`[meet-notes] Starting full sync for ${this.accountInfo?.email} (${daysBack}d)`);
    const since = daysAgoISO(daysBack);
    let saved = 0;

    // 1. Meet API — conferences I organized
    saved += await this.syncFromMeetApi(since);

    // 2. Drive search — notes shared with me (optional)
    if (this.isDriveSearchEnabled()) {
      saved += await this.syncFromDrive(since);
    }

    console.log(`[meet-notes] Full sync complete for ${this.accountInfo?.email}: ${saved} notes`);
  }

  // ── Incremental sync (last 7 days) ────────────────────────────────────────

  async incrementalSync(): Promise<number> {
    if (!this.auth) return 0;
    let saved = 0;
    const since = daysAgoISO(7);
    saved += await this.syncFromMeetApi(since);
    if (this.isDriveSearchEnabled()) {
      saved += await this.syncFromDrive(since);
    }
    return saved;
  }

  // ── Meet REST API sync ────────────────────────────────────────────────────

  private async syncFromMeetApi(since: string): Promise<number> {
    if (!this.auth) return 0;
    const db = getDb();
    const meet = google.meet({ version: 'v2', auth: this.auth });
    let saved = 0;

    try {
      // List conference records (meetings I organized)
      let pageToken: string | undefined;
      do {
        const recordsRes = await (meet.conferenceRecords.list as (params: Record<string, unknown>) => Promise<{ data: { nextPageToken?: string; conferenceRecords?: Array<{ name?: string | null; startTime?: { seconds?: string | null } | null }> } }>)({
          filter: `start_time>="${since}"`,
          pageSize: 25,
          ...(pageToken ? { pageToken } : {}),
        });

        pageToken = recordsRes.data.nextPageToken ?? undefined;
        const records = recordsRes.data.conferenceRecords ?? [];

        for (const record of records) {
          if (!record.name) continue;
          saved += await this.syncSmartNotesForRecord(record, meet);
        }
      } while (pageToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Scope not granted → skip silently with a clear warning
      if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('insufficient')) {
        console.warn(`[meet-notes] Meet API scope not granted for ${this.accountInfo?.email}. Re-authorize with updated scopes.`);
      } else {
        console.error(`[meet-notes] Meet API sync error:`, e);
      }
    }

    return saved;
  }

  private async syncSmartNotesForRecord(
    record: { name?: string | null; startTime?: { seconds?: string | null } | null },
    meet: ReturnType<typeof google.meet>,
  ): Promise<number> {
    if (!record.name || !this.auth) return 0;
    const db = getDb();
    let saved = 0;

    // Type helper to call arbitrary Meet subresources not yet in googleapis typings
    type AnyMeetCall = (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;

    try {
      // smartNotes may not be typed in all versions of googleapis — call via cast
      const smartNotesResource = (meet.conferenceRecords as unknown as Record<string, { list: AnyMeetCall }>)['smartNotes'];
      if (!smartNotesResource) {
        // smartNotes not available in this version of the API client — skip silently
        return 0;
      }
      const notesRes = await smartNotesResource.list({ parent: record.name });
      const notes = (notesRes.data.smartNotes as Array<Record<string, unknown>> | undefined) ?? [];

      // Fetch participant list for attendee data
      let participants: Array<{ displayName?: string; email?: string }> = [];
      try {
        const pRes = await meet.conferenceRecords.participants.list({ parent: record.name, pageSize: 50 });
        participants = (pRes.data.participants ?? []).map((p) => {
          const signedIn = p.signedinUser as { displayName?: string; user?: string } | undefined;
          const anon = p.anonymousUser as { displayName?: string } | undefined;
          const user = signedIn ?? anon;
          return {
            displayName: user?.displayName ?? undefined,
            email: signedIn?.user ?? undefined,
          };
        });
      } catch { /* participants are best-effort */ }

      for (const noteRaw of notes) {
        const noteName = noteRaw['name'] as string | undefined;
        if (!noteName) continue;
        const noteId = noteName;
        const state = (noteRaw['state'] as string | undefined) ?? 'STATE_UNSPECIFIED';

        // Only fetch content for completed notes
        if (state !== 'ACTIVE' && state !== 'ENDED') continue;

        // Get Drive file ID from the DocsDestination
        const docsDestination = noteRaw['docsDestination'] as { document?: string; exportUri?: string } | undefined;
        const driveFileId = docsDestination?.document ?? null;
        const docsUrl = docsDestination?.exportUri ?? null;

        // Fetch note content from Google Docs
        let summary: string | null = null;
        let title: string | null = null;
        if (driveFileId) {
          try {
            const docs = google.docs({ version: 'v1', auth: this.auth });
            const docRes = await docs.documents.get({ documentId: driveFileId });
            summary = extractDocText(docRes.data as Parameters<typeof extractDocText>[0]);
            title = docRes.data.title ?? null;
          } catch { /* content fetch is best-effort */ }
        }

        // Determine meeting date from record startTime
        const startSec = record.startTime?.seconds;
        const meetingDate = startSec ? new Date(parseInt(String(startSec)) * 1000).toISOString() : null;

        // Match to calendar event
        const calendarEventId = matchCalendarEvent(meetingDate, this.accountInfo?.email ?? null);

        const attendeesJson = JSON.stringify(participants);

        db.insert(meetNotes).values({
          noteId,
          source: 'meet',
          accountId: this.accountInfo?.email ?? null,
          conferenceId: record.name,
          title: title ?? `Meeting notes — ${meetingDate ? new Date(meetingDate).toLocaleDateString() : 'Unknown date'}`,
          summary,
          docsUrl,
          driveFileId,
          meetingDate,
          calendarEventId,
          attendees: attendeesJson,
          state,
          rawJson: JSON.stringify(noteRaw),
          updatedAt: new Date().toISOString(),
        }).onConflictDoUpdate({
          target: meetNotes.noteId,
          set: {
            state,
            summary: summary ?? undefined,
            title: title ?? undefined,
            calendarEventId: calendarEventId ?? undefined,
            updatedAt: new Date().toISOString(),
          },
        }).run();

        saved++;
      }
    } catch (e) {
      console.error(`[meet-notes] Error syncing record ${record.name}:`, e);
    }

    return saved;
  }

  // ── Drive search sync ─────────────────────────────────────────────────────

  private async syncFromDrive(since: string): Promise<number> {
    if (!this.auth) return 0;
    const db = getDb();
    const drive = google.drive({ version: 'v3', auth: this.auth });
    let saved = 0;

    try {
      // Search for "Meet notes" docs that were either created by the user or shared with them
      const sinceForDrive = since.replace('T', ' ').replace(/\.\d+Z$/, '');
      const queries = [
        // Created by user
        `name contains 'Meet notes' and mimeType='application/vnd.google-apps.document' and createdTime > '${sinceForDrive}'`,
        // Shared with user (covers notes from meetings organized by others)
        `name contains 'Meet notes' and mimeType='application/vnd.google-apps.document' and sharedWithMe=true and createdTime > '${sinceForDrive}'`,
      ];

      const seen = new Set<string>();
      for (const q of queries) {
        try {
          const res = await drive.files.list({
            q,
            fields: 'files(id, name, createdTime, webViewLink, owners)',
            orderBy: 'createdTime desc',
            pageSize: 50,
          });

          for (const file of res.data.files ?? []) {
            if (!file.id || seen.has(file.id)) continue;
            seen.add(file.id);

            // Skip if already synced from the Meet API
            const existing = db.select({ id: meetNotes.id })
              .from(meetNotes)
              .where(eq(meetNotes.driveFileId, file.id))
              .get();
            if (existing) continue;

            // Fetch content from Docs API
            let summary: string | null = null;
            let title: string | null = file.name ?? null;
            try {
              const docs = google.docs({ version: 'v1', auth: this.auth! });
              const docRes = await docs.documents.get({ documentId: file.id });
              summary = extractDocText(docRes.data as Parameters<typeof extractDocText>[0]);
              title = docRes.data.title ?? title;
            } catch { /* best-effort */ }

            const meetingDate = file.createdTime ?? null;
            const calendarEventId = matchCalendarEvent(meetingDate, this.accountInfo?.email ?? null);

            db.insert(meetNotes).values({
              noteId: `drive:${file.id}`,
              source: 'drive',
              accountId: this.accountInfo?.email ?? null,
              conferenceId: null,
              title: title ?? 'Meeting notes',
              summary,
              docsUrl: file.webViewLink ?? null,
              driveFileId: file.id,
              meetingDate,
              calendarEventId,
              attendees: null,
              state: 'ENDED',
              rawJson: JSON.stringify(file),
              updatedAt: new Date().toISOString(),
            }).onConflictDoNothing().run();

            saved++;
          }
        } catch { /* per-query errors are non-fatal */ }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
        console.warn(`[meet-notes] Drive scope not granted for ${this.accountInfo?.email}.`);
      } else {
        console.error('[meet-notes] Drive search error:', e);
      }
    }

    return saved;
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
