/**
 * GmailSync — Gmail API integration using googleapis.
 *
 * Auth: OAuth 2.0 with refresh token. The access token is auto-refreshed
 * when it is within 5 minutes of expiry. Credentials stored in settings table
 * under `credentials.gmail`.
 *
 * Storage model: hybrid — metadata + snippet in SQLite, full body fetched
 * on demand from the Gmail API (never stored locally).
 */

import { google, gmail_v1 } from 'googleapis';
import { getDb } from '../db/client.js';
import { gmailMessages, settings, syncRuns } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { broadcast, broadcastUnread } from '../websocket/hub.js';

export interface GmailCreds {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry?: string;   // ISO string
  email?: string;
}

export interface EmailBody {
  html: string;
  text: string;
  attachments: Array<{ name: string; mimeType: string; size: number; attachmentId: string }>;
}

// Action payloads stored in outbox.content as JSON
export interface GmailAction {
  action: 'reply' | 'reply_all' | 'forward' | 'compose' |
          'archive' | 'trash' | 'spam' |
          'mark_read' | 'mark_unread' |
          'star' | 'unstar' |
          'move' | 'unsubscribe';
  messageId?: string;
  threadId?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;           // plain text / markdown
  labelId?: string;        // for 'move'
}

const SETTINGS_KEY = 'credentials.gmail';

function saveCreds(creds: GmailCreds): void {
  const db = getDb();
  const value = JSON.stringify(creds);
  db.insert(settings)
    .values({ key: SETTINGS_KEY, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

function buildOAuth2Client(creds: GmailCreds) {
  const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  auth.setCredentials({
    access_token:  creds.accessToken,
    refresh_token: creds.refreshToken,
    expiry_date:   creds.tokenExpiry ? new Date(creds.tokenExpiry).getTime() : undefined,
  });
  return auth;
}

function parseEmailBody(payload: gmail_v1.Schema$MessagePart): EmailBody {
  const result: EmailBody = { html: '', text: '', attachments: [] };

  function walk(part: gmail_v1.Schema$MessagePart): void {
    const mime = part.mimeType || '';
    if (mime === 'text/plain' && part.body?.data) {
      result.text = Buffer.from(part.body.data, 'base64').toString('utf-8');
    } else if (mime === 'text/html' && part.body?.data) {
      result.html = Buffer.from(part.body.data, 'base64').toString('utf-8');
    } else if (part.filename && part.body?.attachmentId) {
      result.attachments.push({
        name: part.filename,
        mimeType: mime,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    for (const sub of part.parts || []) walk(sub);
  }

  walk(payload);
  return result;
}

function extractHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((a) => a.trim()).filter(Boolean);
}

export class GmailSync {
  private gmail: gmail_v1.Gmail | null = null;
  private creds: GmailCreds | null = null;
  private _cancelRequested = false;
  private _pollInterval: NodeJS.Timeout | null = null;
  public connected = false;
  public accountInfo: { email: string; displayName?: string } | null = null;
  private historyId: string | null = null;

  cancelSync(): void {
    this._cancelRequested = true;
    const email = this.accountInfo?.email;
    const db = getDb();
    try {
      db.update(syncRuns)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(and(eq(syncRuns.source, 'gmail'), eq(syncRuns.status, 'running')))
        .run();
      broadcast({ type: 'sync:progress', data: { service: 'gmail', status: 'idle', email } });
    } catch { /* ignore */ }
  }

  /** Start polling for new mail via the History API every `intervalMs` ms. */
  startPolling(intervalMs = 2 * 60 * 1000): void {
    this.stopPolling();
    this._pollInterval = setInterval(async () => {
      if (!this.connected) return;
      try { await this.incrementalSync(); }
      catch (e) { console.error('[gmail] Poll error:', e); }
    }, intervalMs);
    console.log(`[gmail] Polling started (every ${intervalMs / 1000}s) for ${this.accountInfo?.email}`);
  }

  stopPolling(): void {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  }

  /** Persist historyId to settings so incremental sync survives restarts.
   *  If historyId is null (e.g. after a 404 reset), the stale DB key is
   *  actively deleted so an expired value does not cause another 404 loop
   *  on the next server restart.
   */
  private saveHistoryId(): void {
    if (!this.accountInfo?.email) return;
    const key = `gmail.historyId.${this.accountInfo.email}`;
    const db = getDb();
    if (!this.historyId) {
      db.delete(settings).where(eq(settings.key, key)).run();
      return;
    }
    db.insert(settings).values({ key, value: this.historyId, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: settings.key, set: { value: this.historyId, updatedAt: new Date().toISOString() } })
      .run();
  }

  /** Restore historyId from settings on reconnect. */
  private loadHistoryId(): void {
    if (!this.accountInfo?.email) return;
    const key = `gmail.historyId.${this.accountInfo.email}`;
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    if (row?.value) this.historyId = row.value;
  }

  async connect(creds: GmailCreds): Promise<boolean> {
    this.creds = creds;
    this._cancelRequested = false;
    try {
      const auth = buildOAuth2Client(creds);

      auth.on('tokens', (tokens) => {
        if (!this.creds) return;
        if (tokens.access_token) this.creds.accessToken = tokens.access_token;
        if (tokens.expiry_date) this.creds.tokenExpiry = new Date(tokens.expiry_date).toISOString();
        saveCreds(this.creds);
      });

      this.gmail = google.gmail({ version: 'v1', auth });

      const profile = await this.gmail.users.getProfile({ userId: 'me' });
      const email = profile.data.emailAddress || '';
      this.accountInfo = { email };
      this.connected = true;

      if (!creds.email || creds.email !== email) {
        this.creds.email = email;
        saveCreds(this.creds);
      }

      // Restore persisted historyId so incremental sync works after restart
      this.loadHistoryId();

      broadcast({ type: 'connection:status', data: { service: 'gmail', status: 'connected', displayName: email } });
      console.log(`[gmail] Connected as ${email}`);
      return true;
    } catch (e) {
      console.error('[gmail] Connection failed:', e);
      return false;
    }
  }

  disconnect(): void {
    this.stopPolling();
    this.gmail = null;
    this.connected = false;
    this.accountInfo = null;
    broadcast({ type: 'connection:status', data: { service: 'gmail', status: 'disconnected' } });
  }

  async initialFullSync(maxMessages = 500): Promise<void> {
    if (!this.gmail) throw new Error('Gmail not connected');
    // Capture the client as a local const so a concurrent disconnect() call
    // setting this.gmail = null cannot affect this in-progress sync.
    const gmail = this.gmail;
    const db = getDb();
    this._cancelRequested = false;
    let saved = 0;
    let pageToken: string | undefined;

    const runId = db.insert(syncRuns).values({
      source: 'gmail',
      syncType: 'full',
      status: 'running',
      startedAt: new Date().toISOString(),
    }).run().lastInsertRowid as number;

    broadcast({ type: 'sync:progress', data: { service: 'gmail', status: 'running', type: 'full', messagesSaved: 0 } });

    try {
      do {
        if (this._cancelRequested) break;

        const listRes = await gmail.users.messages.list({
          userId: 'me',
          maxResults: Math.min(100, maxMessages - saved),
          pageToken,
        });

        const msgs = listRes.data.messages || [];
        if (msgs.length === 0) break;

        for (const stub of msgs) {
          if (this._cancelRequested) break;
          if (!stub.id) continue;
          try {
            const msgRes = await gmail.users.messages.get({
              userId: 'me',
              id: stub.id,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'List-Unsubscribe'],
            });

            const msg = msgRes.data;
            const headers = msg.payload?.headers || [];
            const from = extractHeader(headers, 'from');
            const fromMatch = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
            const fromName = fromMatch?.[1]?.trim() || '';
            const fromAddress = fromMatch?.[2]?.trim() || from;

            const result = db.insert(gmailMessages).values({
              gmailId: msg.id!,
              threadId: msg.threadId || msg.id!,
              accountId: this.accountInfo?.email,
              fromAddress, fromName,
              toAddresses: JSON.stringify(parseAddressList(extractHeader(headers, 'to'))),
              ccAddresses: JSON.stringify(parseAddressList(extractHeader(headers, 'cc'))),
              bccAddresses: JSON.stringify(parseAddressList(extractHeader(headers, 'bcc'))),
              subject: extractHeader(headers, 'subject'),
              snippet: msg.snippet,
              labels: JSON.stringify(msg.labelIds || []),
              hasAttachments: (msg.payload?.parts?.some((p) => !!p.filename && !!p.body?.attachmentId)) ?? false,
              isRead: !msg.labelIds?.includes('UNREAD'),
              isStarred: msg.labelIds?.includes('STARRED') ?? false,
              internalDate: msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : null,
              sizeEstimate: msg.sizeEstimate,
              rawHeaders: JSON.stringify(headers.reduce((acc, h) => ({ ...acc, [h.name || '']: h.value }), {})),
            }).onConflictDoNothing().run();

            if (result.changes > 0) saved++;
          } catch { /* skip individual message errors */ }
        }

        // Capture historyId from most recent message for incremental sync
        if (msgs.length > 0) {
          try {
            const firstMsg = await gmail.users.messages.get({ userId: 'me', id: msgs[0].id!, format: 'minimal' });
            if (firstMsg.data.historyId) { this.historyId = firstMsg.data.historyId; this.saveHistoryId(); }
          } catch (e) { console.warn('[gmail] Failed to capture historyId after full sync:', e); }
        }

        // Update progress in DB
        db.update(syncRuns).set({ messagesSaved: saved }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'gmail', status: 'running', type: 'full', messagesSaved: saved } });

        pageToken = listRes.data.nextPageToken || undefined;
      } while (pageToken && saved < maxMessages);

      if (this._cancelRequested) {
        db.update(syncRuns).set({ status: 'cancelled', finishedAt: new Date().toISOString(), messagesSaved: saved }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'gmail', status: 'idle' } });
        console.log('[gmail] Full sync cancelled');
      } else {
        db.update(syncRuns).set({ status: 'success', finishedAt: new Date().toISOString(), messagesSaved: saved }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'gmail', status: 'success', messagesSaved: saved } });
        console.debug(`[gmail] Full sync complete: ${saved} messages`);
        // Broadcast unread counts after sync
        this.fetchUnreadCounts().catch(console.error);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.update(syncRuns).set({ status: 'error', errorMessage: msg, finishedAt: new Date().toISOString() }).where(eq(syncRuns.id, runId)).run();
      broadcast({ type: 'sync:progress', data: { service: 'gmail', status: 'error', error: msg } });
      throw e;
    }
  }

  async fetchUnreadCounts(): Promise<void> {
    if (!this.gmail) return;
    try {
      const labels = await this.getLabels();
      const inbox = labels.find((l) => l.id === 'INBOX');
      if (inbox?.messagesUnread) {
        broadcastUnread([{ source: 'gmail', chatId: 'INBOX', count: inbox.messagesUnread }]);
      }
    } catch { /* best-effort */ }
  }

  async incrementalSync(): Promise<number> {
    if (!this.gmail || !this.historyId) {
      await this.initialFullSync();
      return 0;
    }

    const db = getDb();
    let saved = 0;

    try {
      const histRes = await this.gmail.users.history.list({
        userId: 'me',
        startHistoryId: this.historyId,
        historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
      });

      const histories = histRes.data.history || [];
      if (histRes.data.historyId) { this.historyId = histRes.data.historyId; this.saveHistoryId(); }

      for (const h of histories) {
        for (const added of h.messagesAdded || []) {
          const stub = added.message;
          if (!stub?.id) continue;
          try {
            const msgRes = await this.gmail.users.messages.get({
              userId: 'me', id: stub.id, format: 'metadata',
              metadataHeaders: ['From', 'To', 'Cc', 'Subject'],
            });
            const msg = msgRes.data;
            const headers = msg.payload?.headers || [];
            const from = extractHeader(headers, 'from');
            const fromMatch = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);

            const result = db.insert(gmailMessages).values({
              gmailId: msg.id!, threadId: msg.threadId || msg.id!,
              accountId: this.accountInfo?.email,
              fromAddress: fromMatch?.[2]?.trim() || from,
              fromName: fromMatch?.[1]?.trim() || '',
              toAddresses: JSON.stringify(parseAddressList(extractHeader(headers, 'to'))),
              ccAddresses: JSON.stringify([]),
              bccAddresses: JSON.stringify([]),
              subject: extractHeader(headers, 'subject'),
              snippet: msg.snippet,
              labels: JSON.stringify(msg.labelIds || []),
              hasAttachments: false,
              isRead: !msg.labelIds?.includes('UNREAD'),
              isStarred: msg.labelIds?.includes('STARRED') ?? false,
              internalDate: msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : null,
              sizeEstimate: msg.sizeEstimate,
              rawHeaders: '{}',
            }).onConflictDoNothing().run();

            if (result.changes > 0) {
              saved++;
              // Broadcast typed event so clients can show real-time email notifications
              broadcast({
                type: 'email:new',
                data: {
                  gmailId: msg.id,
                  threadId: msg.threadId,
                  subject: extractHeader(headers, 'subject'),
                  fromName: extractHeader(headers, 'from')?.split('<')[0]?.trim() || '',
                  fromAddress: extractHeader(headers, 'from')?.match(/<(.+)>/)?.[1] || extractHeader(headers, 'from') || '',
                  snippet: msg.snippet || '',
                  isUnread: msg.labelIds?.includes('UNREAD') ?? false,
                  labels: msg.labelIds || [],
                },
              });
            }
          } catch { /* skip */ }
        }

        // Handle label changes (mark read/unread, archive, etc.)
        for (const labChange of [...(h.labelsAdded || []), ...(h.labelsRemoved || [])]) {
          const stub = labChange.message;
          if (!stub?.id) continue;
          const isRead = !stub.labelIds?.includes('UNREAD');
          const isStarred = stub.labelIds?.includes('STARRED') ?? false;
          const labels = JSON.stringify(stub.labelIds || []);
          db.update(gmailMessages).set({ isRead, isStarred, labels })
            .where(eq(gmailMessages.gmailId, stub.id)).run();
        }
      }

      return saved;
    } catch (e: any) {
      // 404 means the historyId has expired (Gmail only retains ~7 days of history).
      // Reset and fall back to a full sync so we get back in sync.
      if (e?.code === 404 || e?.status === 404) {
        console.debug('[gmail] historyId expired (404), resetting and running full sync');
        this.historyId = null;
        this.saveHistoryId();
        await this.initialFullSync();
        return 0;
      }
      console.error('[gmail] Incremental sync error:', e);
      return 0;
    }
  }

  // Full body fetch — called on demand, never stored
  async fetchBody(messageId: string): Promise<EmailBody> {
    if (!this.gmail) throw new Error('Gmail not connected');
    const res = await this.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    if (!res.data.payload) return { html: '', text: '', attachments: [] };
    return parseEmailBody(res.data.payload);
  }

  async getLabels(): Promise<Array<{ id: string; name: string; type: string; messagesTotal?: number; messagesUnread?: number }>> {
    if (!this.gmail) throw new Error('Gmail not connected');
    const res = await this.gmail.users.labels.list({ userId: 'me' });
    return (res.data.labels || []).map((l) => ({
      id: l.id || '',
      name: l.name || '',
      type: l.type || '',
      messagesTotal: l.messagesTotal ?? undefined,
      messagesUnread: l.messagesUnread ?? undefined,
    }));
  }

  // ── Email actions (called on outbox approval) ──────────────────────────────

  async archive(messageId: string): Promise<void> {
    if (!this.gmail) throw new Error('Not connected');
    await this.gmail.users.messages.modify({
      userId: 'me', id: messageId,
      requestBody: { removeLabelIds: ['INBOX'] },
    });
    const db = getDb();
    const row = db.select().from(gmailMessages).where(eq(gmailMessages.gmailId, messageId)).get();
    if (row) {
      const labels = JSON.parse(row.labels || '[]') as string[];
      db.update(gmailMessages).set({ labels: JSON.stringify(labels.filter((l) => l !== 'INBOX')) })
        .where(eq(gmailMessages.gmailId, messageId)).run();
    }
  }

  async trash(messageId: string): Promise<void> {
    if (!this.gmail) throw new Error('Not connected');
    await this.gmail.users.messages.trash({ userId: 'me', id: messageId });
    const db = getDb();
    db.update(gmailMessages).set({ labels: JSON.stringify(['TRASH']) })
      .where(eq(gmailMessages.gmailId, messageId)).run();
  }

  async markSpam(messageId: string): Promise<void> {
    if (!this.gmail) throw new Error('Not connected');
    await this.gmail.users.messages.modify({
      userId: 'me', id: messageId,
      requestBody: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
    });
  }

  async markRead(messageId: string, read: boolean): Promise<void> {
    if (!this.gmail) throw new Error('Not connected');
    await this.gmail.users.messages.modify({
      userId: 'me', id: messageId,
      requestBody: read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] },
    });
    const db = getDb();
    db.update(gmailMessages).set({ isRead: read }).where(eq(gmailMessages.gmailId, messageId)).run();
  }

  async star(messageId: string, starred: boolean): Promise<void> {
    if (!this.gmail) throw new Error('Not connected');
    await this.gmail.users.messages.modify({
      userId: 'me', id: messageId,
      requestBody: starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] },
    });
    const db = getDb();
    db.update(gmailMessages).set({ isStarred: starred }).where(eq(gmailMessages.gmailId, messageId)).run();
  }

  async moveToLabel(messageId: string, labelId: string): Promise<void> {
    if (!this.gmail) throw new Error('Not connected');
    await this.gmail.users.messages.modify({
      userId: 'me', id: messageId,
      requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] },
    });
  }

  async sendEmail(opts: {
    to: string[]; cc?: string[]; bcc?: string[];
    subject: string; body: string;
    replyToMessageId?: string; threadId?: string;
  }): Promise<string> {
    if (!this.gmail) throw new Error('Not connected');

    const headers = [
      `To: ${opts.to.join(', ')}`,
      opts.cc?.length ? `Cc: ${opts.cc.join(', ')}` : null,
      opts.bcc?.length ? `Bcc: ${opts.bcc.join(', ')}` : null,
      `Subject: ${opts.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      opts.replyToMessageId ? `In-Reply-To: ${opts.replyToMessageId}` : null,
    ].filter(Boolean).join('\r\n');

    const raw = Buffer.from(`${headers}\r\n\r\n${opts.body}`).toString('base64url');

    const res = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: opts.threadId },
    });

    return res.data.id || '';
  }

  async unsubscribe(messageId: string): Promise<void> {
    if (!this.gmail) throw new Error('Not connected');

    // Fetch the raw List-Unsubscribe header
    const msgRes = await this.gmail.users.messages.get({
      userId: 'me', id: messageId, format: 'metadata',
      metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post'],
    });

    const headers = msgRes.data.payload?.headers || [];
    const listUnsub = headers.find((h) => h.name === 'List-Unsubscribe')?.value || '';
    const listUnsubPost = headers.find((h) => h.name === 'List-Unsubscribe-Post')?.value || '';

    // One-click unsubscribe (RFC 8058)
    if (listUnsubPost && listUnsub.includes('<mailto:') === false) {
      // POST method
      const url = listUnsub.match(/<(https?:[^>]+)>/)?.[1];
      if (url) {
          await fetch(url, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
        await this.archive(messageId);
        return;
      }
    }

    // Mailto method — compose an unsubscribe email
    const mailtoMatch = listUnsub.match(/<mailto:([^>]+)>/);
    if (mailtoMatch) {
      const mailtoRaw = mailtoMatch[1];
      const [address, queryString] = mailtoRaw.split('?');
      const subject = queryString?.match(/subject=([^&]+)/)?.[1] || 'Unsubscribe';
      await this.sendEmail({ to: [address], subject: decodeURIComponent(subject), body: '' });
      await this.archive(messageId);
    }
  }

  // ── Action dispatcher (called from outbox approval) ─────────────────────────

  async executeAction(action: GmailAction): Promise<void> {
    switch (action.action) {
      case 'archive':      await this.archive(action.messageId!); break;
      case 'trash':        await this.trash(action.messageId!); break;
      case 'spam':         await this.markSpam(action.messageId!); break;
      case 'mark_read':    await this.markRead(action.messageId!, true); break;
      case 'mark_unread':  await this.markRead(action.messageId!, false); break;
      case 'star':         await this.star(action.messageId!, true); break;
      case 'unstar':       await this.star(action.messageId!, false); break;
      case 'move':         await this.moveToLabel(action.messageId!, action.labelId!); break;
      case 'unsubscribe':  await this.unsubscribe(action.messageId!); break;
      case 'reply':
      case 'reply_all':
      case 'forward':
      case 'compose':
        await this.sendEmail({
          to: action.to || [],
          cc: action.cc,
          subject: action.subject || '',
          body: action.body || '',
          replyToMessageId: action.messageId,
          threadId: action.threadId,
        });
        break;
      default:
        throw new Error(`Unknown Gmail action: ${(action as GmailAction).action}`);
    }
  }
}
