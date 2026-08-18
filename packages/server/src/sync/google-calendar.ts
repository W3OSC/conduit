/**
 * CalendarSync — Google Calendar API integration.
 * Shares the same OAuth credentials as GmailSync (credentials.gmail).
 *
 * Syncs events from the past 30 days to 90 days in the future.
 * Uses syncToken-based incremental sync after initial fetch.
 * All modifications go through the outbox for approval.
 */

import { google, calendar_v3 } from 'googleapis';
import { getDb } from '../db/client.js';
import { calendarEvents, settings, syncRuns } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { broadcast } from '../websocket/hub.js';
import type { GmailCreds } from './gmail.js';

export interface CalendarAction {
  action: 'create' | 'update' | 'delete' | 'rsvp';
  calendarId: string;
  eventId?: string;        // required for update/delete/rsvp
  title?: string;
  description?: string;
  location?: string;
  start?: string;          // ISO string
  end?: string;            // ISO string
  allDay?: boolean;
  attendees?: string[];    // email addresses to add
  rsvpStatus?: 'accepted' | 'declined' | 'tentative';
  colorId?: string;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor?: string;
  accessRole?: string;
  timeZone?: string;
}

export class CalendarSync {
  private calendar: calendar_v3.Calendar | null = null;
  private _cancelRequested = false;
  private _pollInterval: NodeJS.Timeout | null = null;
  private syncInFlight = false;
  public connected = false;
  public accountInfo: { email: string } | null = null;
  private syncTokens = new Map<string, string>(); // calendarId → syncToken

  cancelSync(): void {
    this._cancelRequested = true;
    const db = getDb();
    try {
      db.update(syncRuns)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(and(eq(syncRuns.source, 'calendar'), eq(syncRuns.status, 'running')))
        .run();
      broadcast({ type: 'sync:progress', data: { service: 'calendar', status: 'idle' } });
    } catch { /* ignore */ }
  }

  startPolling(intervalMs = 2 * 60 * 1000): void {
    this.stopPolling();
    this._pollInterval = setInterval(async () => {
      if (!this.connected) return;
      if (this.syncInFlight) return; // previous cycle still running — skip this tick
      this.syncInFlight = true;
      try { await this.incrementalSync(); }
      catch (e) { console.error('[calendar] Poll error:', e); }
      finally { this.syncInFlight = false; }
    }, intervalMs);
    console.log(`[calendar] Polling started (every ${intervalMs / 1000}s) for ${this.accountInfo?.email}`);
  }

  stopPolling(): void {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  }

  private saveSyncTokens(): void {
    if (!this.accountInfo?.email) return;
    const db = getDb();
    for (const [calId, token] of this.syncTokens.entries()) {
      const key = `calendar.syncToken.${this.accountInfo.email}.${calId}`;
      db.insert(settings).values({ key, value: token, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({ target: settings.key, set: { value: token, updatedAt: new Date().toISOString() } })
        .run();
    }
  }

  private loadSyncTokens(): void {
    if (!this.accountInfo?.email) return;
    const db = getDb();
    const prefix = `calendar.syncToken.${this.accountInfo.email}.`;
    const rows = db.select().from(settings).all();
    for (const row of rows) {
      if (row.key.startsWith(prefix)) {
        const calId = row.key.slice(prefix.length);
        this.syncTokens.set(calId, row.value);
      }
    }
  }

  /** Drop a calendar's syncToken from memory AND from the persisted settings row,
   *  so an expired (410) token cannot be restored on the next server restart. */
  private deleteSyncToken(calId: string): void {
    this.syncTokens.delete(calId);
    if (!this.accountInfo?.email) return;
    const db = getDb();
    db.delete(settings)
      .where(eq(settings.key, `calendar.syncToken.${this.accountInfo.email}.${calId}`))
      .run();
  }

  async connect(creds: GmailCreds): Promise<boolean> {
    this._cancelRequested = false;
    try {
      const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
      auth.setCredentials({
        access_token: creds.accessToken,
        refresh_token: creds.refreshToken,
        expiry_date: creds.tokenExpiry ? new Date(creds.tokenExpiry).getTime() : undefined,
      });
      this.calendar = google.calendar({ version: 'v3', auth });
      this.accountInfo = { email: creds.email || '' };
      this.connected = true;
      // Restore persisted sync tokens
      this.loadSyncTokens();
      broadcast({ type: 'connection:status', data: { service: 'calendar', status: 'connected' } });
      return true;
    } catch (e) {
      console.error('[calendar] Connection failed:', e);
      return false;
    }
  }

  disconnect(): void {
    this.stopPolling();
    this.calendar = null;
    this.connected = false;
    broadcast({ type: 'connection:status', data: { service: 'calendar', status: 'disconnected' } });
  }

  async getCalendars(): Promise<CalendarInfo[]> {
    if (!this.calendar) throw new Error('Calendar not connected');
    const res = await this.calendar.calendarList.list();
    return (res.data.items || []).map((c) => ({
      id: c.id || '',
      summary: c.summary || c.id || '',
      primary: c.primary || false,
      backgroundColor: c.backgroundColor || undefined,
      accessRole: c.accessRole || undefined,
      timeZone: c.timeZone || undefined,
    }));
  }

  async initialFullSync(daysBack = 30, daysForward = 90): Promise<void> {
    if (!this.calendar) throw new Error('Calendar not connected');
    const db = getDb();
    this._cancelRequested = false;
    let saved = 0;

    const runId = db.insert(syncRuns).values({
      source: 'calendar',
      syncType: 'full',
      status: 'running',
      startedAt: new Date().toISOString(),
    }).run().lastInsertRowid as number;

    broadcast({ type: 'sync:progress', data: { service: 'calendar', status: 'running', type: 'full', messagesSaved: 0 } });

    try {
      const calendars = await this.getCalendars();

      for (const cal of calendars) {
        if (this._cancelRequested) break;
        saved += await this.fullSyncCalendar(cal.id, daysBack, daysForward);
      }

      db.update(syncRuns).set({ messagesSaved: saved }).where(eq(syncRuns.id, runId)).run();

      if (this._cancelRequested) {
        db.update(syncRuns).set({ status: 'cancelled', finishedAt: new Date().toISOString() }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'calendar', status: 'idle' } });
        console.log('[calendar] Sync cancelled');
      } else {
        db.update(syncRuns).set({ status: 'success', finishedAt: new Date().toISOString(), messagesSaved: saved }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'calendar', status: 'success', messagesSaved: saved } });
        console.log(`[calendar] Full sync complete: ${saved} events`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.update(syncRuns).set({ status: 'error', errorMessage: msg, finishedAt: new Date().toISOString() }).where(eq(syncRuns.id, runId)).run();
      broadcast({ type: 'sync:progress', data: { service: 'calendar', status: 'error', error: msg } });
      throw e;
    }
  }

  /**
   * Full (time-windowed) sync of a single calendar. Pages through events.list
   * until exhausted and stores the fresh nextSyncToken Google returns on the
   * last page. Used by initialFullSync, and by incrementalSync to (re)establish
   * a syncToken for calendars that have none (first sync or after a 410).
   */
  private async fullSyncCalendar(calendarId: string, daysBack = 30, daysForward = 90): Promise<number> {
    if (!this.calendar) throw new Error('Calendar not connected');
    const db = getDb();
    let saved = 0;

    const timeMin = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() + daysForward * 24 * 60 * 60 * 1000).toISOString();

    let pageToken: string | undefined;
    do {
      if (this._cancelRequested) break;
      const res = await this.calendar.events.list({
        calendarId,
        timeMin, timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        pageToken,
      });

      for (const event of res.data.items || []) {
        if (!event.id) continue;
        const startTime = event.start?.dateTime || event.start?.date || '';
        const endTime   = event.end?.dateTime   || event.end?.date   || '';
        const allDay    = !event.start?.dateTime;
        const attendees = (event.attendees || []).map((a) => ({
          email: a.email || '', name: a.displayName || '', responseStatus: a.responseStatus || 'needsAction',
        }));
        const meetLink = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;

        const result = db.insert(calendarEvents).values({
          eventId: event.id, calendarId, accountId: this.accountInfo?.email,
          title: event.summary, description: event.description, location: event.location,
          startTime, endTime, allDay, status: event.status,
          attendees: JSON.stringify(attendees),
          organizerEmail: event.organizer?.email, organizerName: event.organizer?.displayName,
          recurrence: event.recurrence ? JSON.stringify(event.recurrence) : null,
          htmlLink: event.htmlLink, meetLink: meetLink || null, colorId: event.colorId,
          rawJson: JSON.stringify(event), updatedAt: event.updated,
        }).onConflictDoUpdate({
          target: [calendarEvents.eventId, calendarEvents.calendarId],
          set: {
            title: event.summary, description: event.description, startTime, endTime,
            status: event.status, attendees: JSON.stringify(attendees),
            rawJson: JSON.stringify(event), updatedAt: event.updated,
          },
        }).run();

        if (result.changes > 0) saved++;
      }

      if (res.data.nextSyncToken) { this.syncTokens.set(calendarId, res.data.nextSyncToken); this.saveSyncTokens(); }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    return saved;
  }

  async incrementalSync(): Promise<number> {
    if (!this.calendar) throw new Error('Calendar not connected');
    const db = getDb();
    let updated = 0;

    const calendars = await this.getCalendars();

    for (const cal of calendars) {
      const syncToken = this.syncTokens.get(cal.id);
      if (!syncToken) {
        // No token yet (never fully synced, or reset after a 410) — run the
        // full sync path for this calendar so a fresh syncToken is established
        // instead of silently skipping it forever.
        try { updated += await this.fullSyncCalendar(cal.id); }
        catch (e) { console.error(`[calendar] Full sync failed for ${cal.id}:`, e); }
        continue;
      }

      try {
        // Page through all changes. When changes exceed one page Google returns
        // nextPageToken and only sends nextSyncToken on the LAST page — without
        // this loop the token is never updated and the first page replays forever.
        let pageToken: string | undefined;
        let nextSyncToken: string | undefined;
        do {
          const res = await this.calendar.events.list({
            calendarId: cal.id,
            syncToken,
            ...(pageToken ? { pageToken } : {}),
          });

          for (const event of res.data.items || []) {
            if (!event.id) continue;

            if (event.status === 'cancelled') {
              db.delete(calendarEvents)
                .where(and(eq(calendarEvents.eventId, event.id), eq(calendarEvents.calendarId, cal.id)))
                .run();
            } else {
              const startTime = event.start?.dateTime || event.start?.date || '';
              const endTime   = event.end?.dateTime   || event.end?.date   || '';
              const insertResult = db.insert(calendarEvents).values({
                eventId: event.id, calendarId: cal.id,
                accountId: this.accountInfo?.email,
                title: event.summary, description: event.description,
                startTime, endTime, status: event.status,
                rawJson: JSON.stringify(event), updatedAt: event.updated,
                allDay: !event.start?.dateTime,
                attendees: JSON.stringify(event.attendees || []),
                organizerEmail: event.organizer?.email,
                organizerName: event.organizer?.displayName,
                htmlLink: event.htmlLink,
              }).onConflictDoUpdate({
                target: [calendarEvents.eventId, calendarEvents.calendarId],
                set: { title: event.summary, startTime, endTime, status: event.status, rawJson: JSON.stringify(event), updatedAt: event.updated },
              }).run();

              if (insertResult.changes > 0) {
                updated++;
                // Broadcast real-time calendar update to open Calendar views
                broadcast({
                  type: 'calendar:updated',
                  data: {
                    eventId: event.id,
                    calendarId: cal.id,
                    title: event.summary,
                    startTime,
                    endTime,
                    status: event.status,
                  },
                });
              }
            }
          }

          nextSyncToken = res.data.nextSyncToken || undefined;
          pageToken = res.data.nextPageToken || undefined;
        } while (pageToken);

        // Store the new token only after all pages were processed
        if (nextSyncToken) { this.syncTokens.set(cal.id, nextSyncToken); this.saveSyncTokens(); }
      } catch (e: unknown) {
        const status = (e as { code?: number; status?: number });
        // 410 Gone — sync token expired. Delete it (memory + persisted) and
        // immediately run the full sync path so a fresh token is established;
        // previously the calendar simply went dark after a 410.
        if (status.code === 410 || status.status === 410) {
          this.deleteSyncToken(cal.id);
          try { updated += await this.fullSyncCalendar(cal.id); }
          catch (e2) { console.error(`[calendar] Full re-sync after 410 failed for ${cal.id}:`, e2); }
        } else {
          console.error(`[calendar] Incremental sync error for ${cal.id}:`, e);
        }
      }
    }

    return updated;
  }

  // ── Calendar actions (executed on outbox approval) ─────────────────────────

  async createEvent(action: CalendarAction): Promise<string> {
    if (!this.calendar) throw new Error('Not connected');
    const res = await this.calendar.events.insert({
      calendarId: action.calendarId,
      requestBody: {
        summary: action.title,
        description: action.description,
        location: action.location,
        start: action.allDay ? { date: action.start?.slice(0, 10) } : { dateTime: action.start },
        end:   action.allDay ? { date: action.end?.slice(0, 10)   } : { dateTime: action.end   },
        attendees: action.attendees?.map((email) => ({ email })),
        colorId: action.colorId,
      },
    });
    return res.data.id || '';
  }

  async updateEvent(action: CalendarAction): Promise<void> {
    if (!this.calendar || !action.eventId) throw new Error('Not connected or missing eventId');
    await this.calendar.events.patch({
      calendarId: action.calendarId,
      eventId: action.eventId,
      requestBody: {
        summary: action.title,
        description: action.description,
        location: action.location,
        start: action.start ? (action.allDay ? { date: action.start.slice(0, 10) } : { dateTime: action.start }) : undefined,
        end:   action.end   ? (action.allDay ? { date: action.end.slice(0, 10)   } : { dateTime: action.end   }) : undefined,
        colorId: action.colorId,
      },
    });
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    if (!this.calendar) throw new Error('Not connected');
    await this.calendar.events.delete({ calendarId, eventId });
    const db = getDb();
    db.delete(calendarEvents)
      .where(and(eq(calendarEvents.eventId, eventId), eq(calendarEvents.calendarId, calendarId)))
      .run();
  }

  async rsvp(calendarId: string, eventId: string, status: 'accepted' | 'declined' | 'tentative'): Promise<void> {
    if (!this.calendar) throw new Error('Not connected');

    // Get the current event to find our attendee entry
    const res = await this.calendar.events.get({ calendarId, eventId });
    const myEmail = this.accountInfo?.email || '';
    const attendees = (res.data.attendees || []).map((a) => ({
      ...a,
      responseStatus: a.email === myEmail ? status : a.responseStatus,
    }));

    await this.calendar.events.patch({ calendarId, eventId, requestBody: { attendees } });

    // Update local cache
    const db = getDb();
    db.update(calendarEvents).set({ attendees: JSON.stringify(attendees) })
      .where(and(eq(calendarEvents.eventId, eventId), eq(calendarEvents.calendarId, calendarId)))
      .run();
  }

  async executeAction(action: CalendarAction): Promise<void> {
    switch (action.action) {
      case 'create': await this.createEvent(action); break;
      case 'update': await this.updateEvent(action); break;
      case 'delete': await this.deleteEvent(action.calendarId, action.eventId!); break;
      case 'rsvp':   await this.rsvp(action.calendarId, action.eventId!, action.rsvpStatus!); break;
      default: throw new Error(`Unknown calendar action: ${action.action}`);
    }
  }
}
