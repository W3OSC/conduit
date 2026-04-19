import { SlackSync } from '../sync/slack.js';
import { DiscordSync } from '../sync/discord.js';
import { TelegramBridge } from '../sync/telegram-bridge.js';
import { GmailSync, type GmailAction } from '../sync/gmail.js';
import { CalendarSync, type CalendarAction } from '../sync/google-calendar.js';
import { MeetNotesSync } from '../sync/meet-notes.js';
import { TwitterSync, type TwitterAction, type TwitterCreds } from '../sync/twitter.js';
import { NotionSync, type NotionWriteAction } from '../sync/notion.js';
import { ObsidianVaultSync, type ObsidianWriteAction, type VaultConfig } from '../sync/obsidian.js';
import { syncGmailContactsFromDb, syncCalendarContactsFromDb } from '../sync/contacts.js';
import { broadcast, onNextBroadcast } from '../websocket/hub.js';
import { randomBytes } from 'crypto';
import { getCreds, type SlackCreds, type DiscordCreds, type TelegramCreds, type TwitterCredsLite, type NotionCredsLite } from '../api/credentials.js';
import { getAllGmailCreds } from '../api/google-auth.js';
import type { GmailCreds as GmailCredsType } from '../sync/gmail.js';
import { getDb } from '../db/client.js';
import { settings, obsidianVaultConfig } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type ServiceName = 'slack' | 'discord' | 'telegram' | 'gmail' | 'calendar' | 'twitter' | 'notion' | 'obsidian' | 'ai';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ServiceStatus {
  status: ConnectionStatus;
  mode?: string;
  error?: string;
  accountId?: string;
  displayName?: string;
  lastSync?: string;
}

export class ConnectionManager {
  private slack: SlackSync | null = null;
  private discord: DiscordSync | null = null;
  private telegram: TelegramBridge | null = null;
  // Multi-account: keyed by email address
  private gmailAccounts = new Map<string, GmailSync>();
  private calendarAccounts = new Map<string, CalendarSync>();
  private meetNotesAccounts = new Map<string, MeetNotesSync>();
  private twitter: TwitterSync | null = null;
  private notion: NotionSync | null = null;
  private obsidian: ObsidianVaultSync | null = null;

  private statuses: Record<ServiceName, ServiceStatus> = {
    slack:    { status: 'disconnected' },
    discord:  { status: 'disconnected' },
    telegram: { status: 'disconnected' },
    gmail:    { status: 'disconnected' },
    calendar: { status: 'disconnected' },
    twitter:  { status: 'disconnected' },
    notion:   { status: 'disconnected' },
    obsidian: { status: 'disconnected' },
    ai:       { status: 'disconnected' },
  };

  // Per-account Gmail/Calendar statuses
  private gmailStatuses = new Map<string, ServiceStatus>();
  private calendarStatuses = new Map<string, ServiceStatus>();

  getStatus(service: ServiceName): ServiceStatus { return this.statuses[service]; }
  getAllStatuses(): Record<ServiceName, ServiceStatus> { return { ...this.statuses }; }

  // Return per-account statuses for the UI
  getGmailAccountStatuses(): Array<{ email: string; gmail: ServiceStatus; calendar: ServiceStatus }> {
    const emails = new Set([...this.gmailStatuses.keys(), ...this.calendarStatuses.keys()]);
    return [...emails].map((email) => ({
      email,
      gmail:    this.gmailStatuses.get(email)    ?? { status: 'disconnected' },
      calendar: this.calendarStatuses.get(email) ?? { status: 'disconnected' },
    }));
  }

  private setStatus(service: ServiceName, status: Partial<ServiceStatus>): void {
    this.statuses[service] = { ...this.statuses[service], ...status };
    broadcast({ type: 'connection:status', data: { service, ...this.statuses[service] } });
  }

  private updateAggregateGmailStatus(): void {
    const statuses = [...this.gmailStatuses.values()];
    const anyConnected = statuses.some((s) => s.status === 'connected');
    const anyError = statuses.some((s) => s.status === 'error');
    const emails = [...this.gmailStatuses.keys()].join(', ');
    if (statuses.length === 0) {
      this.setStatus('gmail',    { status: 'disconnected' });
      this.setStatus('calendar', { status: 'disconnected' });
    } else if (anyConnected) {
      this.setStatus('gmail',    { status: 'connected', displayName: emails, mode: 'oauth2' });
      this.setStatus('calendar', { status: 'connected', displayName: emails, mode: 'oauth2' });
    } else if (anyError) {
      this.setStatus('gmail',    { status: 'error', error: 'One or more accounts failed' });
      this.setStatus('calendar', { status: 'error', error: 'One or more accounts failed' });
    }
  }

  getSlack(): SlackSync | null { return this.slack; }
  getDiscord(): DiscordSync | null { return this.discord; }
  getTelegram(): TelegramBridge | null { return this.telegram; }
  getObsidian(): ObsidianVaultSync | null { return this.obsidian; }
  /** Returns the first connected Gmail instance (legacy compat) */
  getGmail(): GmailSync | null {
    for (const g of this.gmailAccounts.values()) if (g.connected) return g;
    return this.gmailAccounts.values().next().value ?? null;
  }
  /** Returns the first connected Calendar instance (legacy compat) */
  getCalendar(): CalendarSync | null {
    for (const c of this.calendarAccounts.values()) if (c.connected) return c;
    return this.calendarAccounts.values().next().value ?? null;
  }
  getTwitter(): TwitterSync | null { return this.twitter; }
  getNotion(): NotionSync | null { return this.notion; }
  getAllGmailInstances(): GmailSync[] { return [...this.gmailAccounts.values()]; }
  getAllCalendarInstances(): CalendarSync[] { return [...this.calendarAccounts.values()]; }
  getAllMeetNotesInstances(): MeetNotesSync[] { return [...this.meetNotesAccounts.values()]; }

  /**
   * Connect all services that have stored credentials.
   * Called on server startup — runs every connection in parallel and silently
   * skips services that have no credentials configured.
   */
  async connectAll(): Promise<void> {
    console.log('[conduit] Auto-connecting all configured services...');

    const tasks: Promise<void>[] = [];

    // Slack
    const slackCreds = getCreds('slack') as SlackCreds | null;
    if (slackCreds?.token) {
      tasks.push(this.connectSlack().catch((e) => console.error('[slack] Auto-connect failed:', e)));
    }

    // Discord
    const discordCreds = getCreds('discord') as DiscordCreds | null;
    if (discordCreds?.token) {
      tasks.push(this.connectDiscord().catch((e) => console.error('[discord] Auto-connect failed:', e)));
    }

    // Telegram — only if session string exists (OTP already completed)
    const telegramCreds = getCreds('telegram') as TelegramCreds | null;
    if (telegramCreds?.apiId && telegramCreds?.apiHash && telegramCreds?.phone && telegramCreds?.sessionString) {
      tasks.push(this.connectTelegram().catch((e) => console.error('[telegram] Auto-connect failed:', e)));
    }

    // Gmail + Calendar — multi-account, each with its own token set
    const allGmailCreds = getAllGmailCreds();
    if (allGmailCreds.length > 0) {
      tasks.push(this.connectGmail().catch((e) => console.error('[gmail] Auto-connect failed:', e)));
    }

    // Twitter — restore session from stored cookie string / persisted cookie jar
    const twitterRaw = getCreds('twitter') as TwitterCredsLite | null;
    if (twitterRaw?.cookieString) {
      const twitterCreds: TwitterCreds = {
        cookieString: twitterRaw.cookieString,
        cookies: twitterRaw.cookies,
        userId: twitterRaw.userId,
        handle: twitterRaw.handle,
        displayName: twitterRaw.displayName,
      };
      tasks.push(this.connectTwitter(twitterCreds).catch((e) => console.error('[twitter] Auto-connect failed:', e)));
    }

    // Notion — connect if integration token is stored
    const notionRaw = getCreds('notion') as NotionCredsLite | null;
    if (notionRaw?.token) {
      tasks.push(this.connectNotion().catch((e) => console.error('[notion] Auto-connect failed:', e)));
    }

    // Obsidian — connect if vault config exists and local clone is present
    const db = getDb();
    const vaultRow = db.select().from(obsidianVaultConfig).get();
    if (vaultRow) {
      tasks.push(this.connectObsidian().catch((e) => console.error('[obsidian] Auto-connect failed:', e)));
    }

    // AI — reflect configured status from stored settings
    this.checkAiStatus();

    await Promise.allSettled(tasks);
    console.log('[conduit] Auto-connect complete.');
  }

  /** Reads AI webhook settings and updates the ai connection status accordingly. */
  checkAiStatus(): void {
    const db = getDb();
    const webhookRow  = db.select().from(settings).where(eq(settings.key, 'ai.webhookUrl')).get();
    const keyIdRow    = db.select().from(settings).where(eq(settings.key, 'ai.apiKeyId')).get();
    const verifiedRow = db.select().from(settings).where(eq(settings.key, 'ai.verified')).get();
    const configured  = !!(webhookRow?.value && keyIdRow?.value);
    const verified    = configured && verifiedRow?.value === '1';
    this.setStatus('ai',
      !configured
        ? { status: 'disconnected' }
        : verified
          ? { status: 'connected',   mode: 'webhook', displayName: webhookRow!.value }
          : { status: 'connecting',  mode: 'webhook', displayName: webhookRow!.value },
    );
  }

  disconnectAi(): void {
    this.setStatus('ai', { status: 'disconnected', mode: undefined, displayName: undefined });
  }

  async connectSlack(): Promise<void> {
    // Cancel any in-progress sync before replacing the instance
    this.slack?.cancelSync();
    const creds = getCreds('slack') as SlackCreds | null;
    if (!creds?.token) { this.setStatus('slack', { status: 'error', error: 'No token configured' }); return; }
    this.setStatus('slack', { status: 'connecting' });
    try {
      this.slack = new SlackSync({ token: creds.token, appToken: creds.appToken });
      const ok = await this.slack.authenticate();
      if (!ok) throw new Error('Authentication failed');
      const info = this.slack.accountInfo;
      this.setStatus('slack', { status: 'connected', accountId: info?.userId, displayName: info?.displayName });
      await this.slack.startSocketMode();
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.setStatus('slack', { status: 'error', error: err });
      console.error('[slack] Connection failed:', err);
    }
  }

  async connectDiscord(): Promise<void> {
    this.discord?.cancelSync();
    const creds = getCreds('discord') as DiscordCreds | null;
    if (!creds?.token) { this.setStatus('discord', { status: 'error', error: 'No token configured' }); return; }
    this.setStatus('discord', { status: 'connecting' });
    try {
      this.discord = new DiscordSync({ token: creds.token });
      const ok = await this.discord.connect();
      if (!ok) throw new Error('Login failed');
      const info = this.discord.accountInfo;
      this.setStatus('discord', { status: 'connected', accountId: info?.userId, displayName: info?.displayName, mode: 'gateway' });
      // Broadcast initial unread counts with mute state from guild settings
      this.discord.fetchUnreadCounts().catch((e) => console.error('[discord] fetchUnreadCounts failed:', e));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.setStatus('discord', { status: 'error', error: err });
      console.error('[discord] Connection failed:', err);
    }
  }

  async connectTelegram(): Promise<void> {
    this.telegram?.cancelSync();
    const creds = getCreds('telegram') as TelegramCreds | null;
    if (!creds?.apiId || !creds?.apiHash || !creds?.phone) { this.setStatus('telegram', { status: 'error', error: 'Telegram credentials not configured' }); return; }
    if (!creds.sessionString) { this.setStatus('telegram', { status: 'error', error: 'Not authenticated — complete the OTP flow in Connections' }); return; }
    this.setStatus('telegram', { status: 'connecting' });
    try {
      if (this.telegram) this.telegram.disconnect();
      this.telegram = new TelegramBridge();
      const ok = await this.telegram.connect({ phone: creds.phone, apiId: Number(creds.apiId), apiHash: creds.apiHash, sessionString: creds.sessionString });
      if (!ok) { this.setStatus('telegram', { status: 'error', error: 'Session invalid — re-authenticate in Connections' }); return; }
      const info = this.telegram.accountInfo;
      this.setStatus('telegram', { status: 'connected', accountId: info?.userId, displayName: info?.displayName, mode: 'mtproto' });
    } catch (e) {
      this.setStatus('telegram', { status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Connect a single Gmail account, run test, start sync + polling. */
  async connectGmailAccount(creds: GmailCredsType): Promise<void> {
    if (!creds.accessToken || !creds.refreshToken) return;
    const email = creds.email || 'unknown';

    this.gmailStatuses.set(email, { status: 'connecting' });
    this.updateAggregateGmailStatus();

    try {
      const gmail = new GmailSync();
      const ok = await gmail.connect(creds);
      if (!ok) {
        this.gmailStatuses.set(email, { status: 'error', error: 'Authentication failed' });
        this.updateAggregateGmailStatus();
        return;
      }
      this.gmailAccounts.set(email, gmail);
      this.gmailStatuses.set(email, { status: 'connected', displayName: email, mode: 'oauth2' });

      const cal = new CalendarSync();
      const calOk = await cal.connect(creds);
      if (calOk) {
        this.calendarAccounts.set(email, cal);
        this.calendarStatuses.set(email, { status: 'connected', displayName: email, mode: 'oauth2' });
      }

      // Meet Notes — connects with same creds; silently skips if scopes not granted
      const meetNotes = new MeetNotesSync();
      const meetNotesOk = await meetNotes.connect(creds);
      if (meetNotesOk) {
        this.meetNotesAccounts.set(email, meetNotes);
      }

      this.updateAggregateGmailStatus();
      console.log(`[gmail] Connected ${email}`);

      // First connect → full sync; reconnect → incremental
      const { getDb } = await import('../db/client.js');
      const { syncRuns: sr } = await import('../db/schema.js');
      const { eq: eqFn, and: andFn } = await import('drizzle-orm');
      const db = getDb();
      const hasPriorSync = db.select().from(sr)
        .where(andFn(eqFn(sr.source, 'gmail'), eqFn(sr.status, 'success')))
        .get();

      if (hasPriorSync) {
        // Gmail: incremental catch-up from stored historyId (falls back to
        // initialFullSync internally when historyId is missing).
        gmail.incrementalSync()
          .then(() => { try { syncGmailContactsFromDb(email); } catch (e) { console.error('[gmail] Contact sync failed:', e); } })
          .catch(console.error);
        // Calendar: always do a full sync on reconnect — sync tokens expire and
        // the event window is bounded (90 days), so this is fast and safe.
        if (calOk) {
          cal.initialFullSync()
            .then(() => { try { syncCalendarContactsFromDb(email); } catch (e) { console.error('[calendar] Contact sync failed:', e); } })
            .catch(console.error);
        } else {
          try { syncCalendarContactsFromDb(email); } catch (e) { console.error('[calendar] Contact sync failed:', e); }
        }
        // Meet Notes: incremental catch-up
        if (meetNotesOk) {
          meetNotes.incrementalSync().catch((e) => console.error('[meet-notes] Incremental sync failed:', e));
        }
      } else {
        // First time — full sync for both, then extract contacts.
        gmail.initialFullSync()
          .then(() => { try { syncGmailContactsFromDb(email); } catch (e) { console.error('[gmail] Contact sync failed:', e); } })
          .catch(console.error);
        if (calOk) {
          cal.initialFullSync()
            .then(() => { try { syncCalendarContactsFromDb(email); } catch (e) { console.error('[calendar] Contact sync failed:', e); } })
            .catch(console.error);
        }
        // Meet Notes: full sync after first connect
        if (meetNotesOk) {
          meetNotes.initialFullSync().catch((e) => console.error('[meet-notes] Full sync failed:', e));
        }
      }

      // Start continuous polling: 2 min for Gmail/Calendar, 30 min for Meet Notes
      gmail.startPolling(2 * 60 * 1000);
      if (calOk) cal.startPolling(2 * 60 * 1000);
      if (meetNotesOk) meetNotes.startPolling(30 * 60 * 1000);

    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.gmailStatuses.set(email, { status: 'error', error: err });
      this.updateAggregateGmailStatus();
      console.error(`[gmail] Connection failed for ${email}:`, err);
    }
  }

  /** Connect all configured Gmail accounts */
  async connectGmail(): Promise<void> {
    const allCreds = getAllGmailCreds();
    if (allCreds.length === 0) {
      this.setStatus('gmail', { status: 'error', error: 'No Google accounts configured' });
      return;
    }
    await Promise.allSettled(allCreds.map((c) => this.connectGmailAccount(c)));
  }

  /** Disconnect a specific Gmail account — stops polling and cleans up. */
  disconnectGmailAccount(email: string): void {
    this.gmailAccounts.get(email)?.stopPolling();
    this.gmailAccounts.get(email)?.disconnect();
    this.calendarAccounts.get(email)?.stopPolling();
    this.calendarAccounts.get(email)?.disconnect();
    this.meetNotesAccounts.get(email)?.stopPolling();
    this.meetNotesAccounts.get(email)?.disconnect();
    this.gmailAccounts.delete(email);
    this.calendarAccounts.delete(email);
    this.meetNotesAccounts.delete(email);
    this.gmailStatuses.delete(email);
    this.calendarStatuses.delete(email);
    this.updateAggregateGmailStatus();
  }

  /** Disconnect all Gmail accounts */
  disconnectAllGmailAccounts(): void {
    for (const [email] of this.gmailAccounts) this.disconnectGmailAccount(email);
  }

  async connectTwitter(creds: TwitterCreds): Promise<void> {
    if (!creds.cookieString?.trim()) { this.setStatus('twitter', { status: 'error', error: 'Twitter cookie string not configured' }); return; }
    this.setStatus('twitter', { status: 'connecting' });
    try {
      if (this.twitter) this.twitter.disconnect();
      this.twitter = new TwitterSync();
      await this.twitter.connect(creds);
      const info = this.twitter.accountInfo;
      this.setStatus('twitter', { status: 'connected', accountId: info?.userId, displayName: info?.handle ? `@${info.handle}` : info?.displayName, mode: 'cookie' });
      // DM polling and initial sync are started inside twitter.connect() via setInterval + syncDMs()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // agent-twitter-client sometimes throws with a JSON string from Twitter's API — extract the human-readable message
      const friendly = (() => {
        try {
          const parsed = JSON.parse(raw) as { errors?: Array<{ message?: string }> };
          const msg = parsed?.errors?.[0]?.message;
          if (msg) return `Twitter: ${msg}`;
        } catch { /* not JSON */ }
        return raw;
      })();
      this.setStatus('twitter', { status: 'error', error: friendly });
      throw new Error(friendly);
    }
  }

  async connectNotion(): Promise<void> {
    const creds = getCreds('notion') as NotionCredsLite | null;
    if (!creds?.token) { this.setStatus('notion', { status: 'error', error: 'No integration token configured' }); return; }
    this.setStatus('notion', { status: 'connecting' });
    try {
      if (this.notion) this.notion.disconnect();
      this.notion = new NotionSync();
      const ok = await this.notion.connect({ token: creds.token, workspaceName: creds.workspaceName, botId: creds.botId });
      if (!ok) { this.setStatus('notion', { status: 'error', error: 'Connection failed — check your integration token' }); return; }
      const info = this.notion.accountInfo;
      this.setStatus('notion', {
        status: 'connected',
        accountId: info?.userId,
        displayName: info?.workspaceName ? `${info.displayName} @ ${info.workspaceName}` : info?.displayName,
        mode: 'token',
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.setStatus('notion', { status: 'error', error: err });
      console.error('[notion] Connection failed:', err);
    }
  }

  async connectObsidian(): Promise<void> {
    const db = getDb();
    const row = db.select().from(obsidianVaultConfig).get();
    if (!row) {
      this.setStatus('obsidian', { status: 'error', error: 'No vault configured' });
      return;
    }
    this.setStatus('obsidian', { status: 'connecting' });
    try {
      if (this.obsidian) this.obsidian.disconnect();
      this.obsidian = new ObsidianVaultSync();
      const config: VaultConfig = {
        id: row.id,
        name: row.name,
        remoteUrl: row.remoteUrl,
        authType: (row.authType as 'https' | 'ssh') ?? 'https',
        httpsToken: row.httpsToken,
        sshPrivateKey: row.sshPrivateKey,
        sshPublicKey: row.sshPublicKey,
        localPath: row.localPath,
        branch: row.branch,
        lastSyncedAt: row.lastSyncedAt,
      };
      const ok = await this.obsidian.connect(config);
      if (!ok) {
        this.setStatus('obsidian', { status: 'error', error: 'Vault not cloned yet. Use the Connections page to clone.' });
        return;
      }
      this.setStatus('obsidian', { status: 'connected', displayName: row.name, mode: 'git' });
      // Start background sync polling (5 minutes)
      this.obsidian.startPolling(5 * 60 * 1000);
      // Run an initial sync to ensure we're up to date
      this.obsidian.sync().catch((e) => console.error('[obsidian] Initial sync failed:', e));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.setStatus('obsidian', { status: 'error', error: err });
      console.error('[obsidian] Connection failed:', err);
    }
  }

  disconnectObsidian(): void {
    if (this.obsidian) {
      this.obsidian.disconnect();
      this.obsidian = null;
    }
    this.setStatus('obsidian', { status: 'disconnected' });
  }

  /**
   * Clone the vault repo and then connect to it.
   * Called from the API when the user triggers a clone.
   */
  async cloneObsidianVault(row: { id: number; name: string; remoteUrl: string; authType: string | null; httpsToken: string | null; sshPrivateKey: string | null; sshPublicKey: string | null; localPath: string; branch: string; lastSyncedAt: string | null }): Promise<void> {
    this.setStatus('obsidian', { status: 'connecting', mode: 'cloning' });
    try {
      const config: VaultConfig = {
        id: row.id,
        name: row.name,
        remoteUrl: row.remoteUrl,
        authType: (row.authType as 'https' | 'ssh') ?? 'https',
        httpsToken: row.httpsToken,
        sshPrivateKey: row.sshPrivateKey,
        sshPublicKey: row.sshPublicKey,
        localPath: row.localPath,
        branch: row.branch,
        lastSyncedAt: row.lastSyncedAt,
      };
      const sync = new ObsidianVaultSync();
      await sync.clone(config);
      this.obsidian = sync;
      this.setStatus('obsidian', { status: 'connected', displayName: row.name, mode: 'git' });
      this.obsidian.startPolling(5 * 60 * 1000);
      this.obsidian.sync().catch((e) => console.error('[obsidian] Post-clone sync failed:', e));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.setStatus('obsidian', { status: 'error', error: err });
      console.error('[obsidian] Clone failed:', err);
      throw e;
    }
  }

  cancelSync(service: ServiceName): { success: boolean; message: string } {
    switch (service) {
      case 'slack':    this.slack?.cancelSync();    break;
      case 'discord':  this.discord?.cancelSync();  break;
      case 'telegram': this.telegram?.cancelSync(); break;
      case 'gmail':    this.getAllGmailInstances().forEach((g) => g.cancelSync());    break;
      case 'calendar': this.getAllCalendarInstances().forEach((c) => c.cancelSync()); break;
      case 'twitter':  this.twitter?.cancelSync(); break;
      case 'notion':   /* no background sync for Notion */ break;
      case 'obsidian': this.obsidian?.stopPolling(); break;
      default: return { success: false, message: `Cancel not supported for ${service}` };
    }
    return { success: true, message: `${service} sync cancellation requested` };
  }

  async triggerSync(service: ServiceName, _forceFull = false): Promise<{ success: boolean; message: string }> {
    switch (service) {
      case 'slack':
        if (!this.slack) return { success: false, message: 'Slack not connected' };
        this.slack.initialFullSync().catch(console.error);
        return { success: true, message: 'Slack sync started' };
      case 'discord':
        if (!this.discord) return { success: false, message: 'Discord not connected' };
        this.discord.initialFullSync().catch(console.error);
        return { success: true, message: 'Discord sync started' };
      case 'telegram':
        if (!this.telegram) return { success: false, message: 'Telegram not connected' };
        this.telegram.initialFullSync().catch(console.error);
        return { success: true, message: 'Telegram sync started' };
      case 'gmail':
        if (this.gmailAccounts.size === 0) return { success: false, message: 'No Gmail accounts connected' };
        for (const [email, g] of this.gmailAccounts.entries()) {
          g.initialFullSync()
            .then(() => { try { syncGmailContactsFromDb(email); } catch (e) { console.error('[gmail] Contact sync failed:', e); } })
            .catch(console.error);
          // Also trigger meet notes incremental on manual Gmail sync
          this.meetNotesAccounts.get(email)?.incrementalSync().catch(console.error);
        }
        return { success: true, message: `Gmail sync started for ${this.gmailAccounts.size} account(s)` };
      case 'calendar':
        if (this.calendarAccounts.size === 0) return { success: false, message: 'No Calendar accounts connected' };
        for (const [email, c] of this.calendarAccounts.entries()) {
          c.initialFullSync()
            .then(() => { try { syncCalendarContactsFromDb(email); } catch (e) { console.error('[calendar] Contact sync failed:', e); } })
            .catch(console.error);
        }
        return { success: true, message: `Calendar sync started for ${this.calendarAccounts.size} account(s)` };
      case 'twitter':
        if (!this.twitter) return { success: false, message: 'Twitter not connected' };
        this.twitter.syncDMs().catch(console.error);
        return { success: true, message: 'Twitter DM sync started' };
      case 'notion':
        // Notion is passthrough-only — no background sync
        return { success: false, message: 'Notion has no background sync — operations are executed on demand' };
      case 'obsidian':
        if (!this.obsidian) return { success: false, message: 'Obsidian vault not connected' };
        this.obsidian.sync().catch(console.error);
        return { success: true, message: 'Obsidian vault sync started' };
      default:
        return { success: false, message: `Unknown service: ${service}` };
    }
  }

  async sendMessage(service: 'slack' | 'discord' | 'telegram', recipientId: string, text: string): Promise<void> {
    switch (service) {
      case 'slack':    if (!this.slack) throw new Error('Slack not connected'); await this.slack.sendMessage(recipientId, text); break;
      case 'discord':  if (!this.discord) throw new Error('Discord not connected'); await this.discord.sendMessage(recipientId, text); break;
      case 'telegram': if (!this.telegram) throw new Error('Telegram not connected'); await this.telegram.sendMessage(recipientId, text); break;
    }
  }

  async executeGmailAction(action: GmailAction): Promise<void> {
    // Route to the correct account if action specifies one, else use first connected
    const target = this.getGmail();
    if (!target) throw new Error('No Gmail account connected');
    await target.executeAction(action);
  }

  async executeCalendarAction(action: CalendarAction): Promise<void> {
    // Route to the account matching the calendarId (format: email/calendarId) or first
    let target: CalendarSync | null = null;
    if (action.calendarId) {
      // Try to match by email prefix in calendarId
      for (const [email, cal] of this.calendarAccounts) {
        if (action.calendarId.includes(email) || action.calendarId === 'primary') {
          target = cal; break;
        }
      }
    }
    if (!target) target = this.getCalendar();
    if (!target) throw new Error('No Calendar account connected');
    await target.executeAction(action);
  }

  async executeTwitterAction(action: TwitterAction): Promise<void> {
    if (!this.twitter) throw new Error('Twitter not connected');
    await this.twitter.executeAction(action);
  }

  async executeNotionAction(action: NotionWriteAction): Promise<string> {
    if (!this.notion) throw new Error('Notion not connected');
    return this.notion.executeAction(action);
  }

  async executeObsidianAction(action: ObsidianWriteAction): Promise<string> {
    if (!this.obsidian) throw new Error('Obsidian vault not connected');
    return this.obsidian.executeAction(action);
  }

  async* runTest(service: ServiceName): AsyncGenerator<{ step: number; name: string; status: 'running' | 'success' | 'error'; detail?: string }> {
    type Step = { name: string; run: () => Promise<string> };

    // Unique token for the DM-self step — used to verify the correct message
    // arrives via the realtime listener and to safety-check deletion
    const token = `conduit-test-${randomBytes(6).toString('hex')}`;

    const steps: Step[] = (() => {
      switch (service) {

        case 'slack': return [
          {
            name: 'Verify login',
            run: async () => {
              if (!this.slack) throw new Error('Slack not connected');
              const auth = await (this.slack as unknown as { client: { auth: { test: () => Promise<{ ok: boolean; user?: string; team?: string }> } } }).client.auth.test();
              if (!auth.ok) throw new Error('Auth test failed');
              return `${auth.user} @ ${auth.team}`;
            },
          },
          {
            name: 'DM access',
            run: async () => {
              if (!this.slack) throw new Error('Not connected');
              const r = await this.slack.getLatestDM();
              return r ? `${r.channelName}: ${r.content.slice(0, 80)}` : 'No DMs found';
            },
          },
          {
            name: 'Channel access',
            run: async () => {
              if (!this.slack) throw new Error('Not connected');
              const r = await this.slack.getLatestChannelMessage();
              return r ? `#${r.channelName}: ${r.content.slice(0, 80)}` : 'No channels found';
            },
          },
          {
            name: 'Send & receive DM to self',
            run: async () => {
              if (!this.slack) throw new Error('Not connected');
              const t0 = Date.now();
              // Subscribe to the broadcast bus BEFORE sending so we never miss the event
              const received = onNextBroadcast(
                (e) => e.type === 'message:new' &&
                        (e.data as Record<string, unknown>)?.source === 'slack' &&
                        String((e.data as Record<string, unknown>)?.content).includes(token),
                10000,
              );
              // Suppress unhandled-rejection noise: if the step throws before or
              // after we await `received`, the timeout rejection must still be
              // observed somewhere or Node will surface it as an unhandled rejection.
              received.catch(() => {});
              const sent = await this.slack.sendSelfWithToken(token);
              if (!sent) throw new Error('Failed to send message');
              await received; // waits for the realtime listener to push it back
              const ms = Date.now() - t0;
              // Safety-checked delete
              const deleted = await this.slack.deleteSelfMessage(sent.channelId, sent.ts, token);
              return `Message received in ${ms}ms via realtime listener${deleted ? ', deleted' : ' (delete failed)'}`;
            },
          },
        ];

        case 'discord': return [
          {
            name: 'Verify login',
            run: async () => {
              if (!this.discord) throw new Error('Discord not connected');
              const u = (this.discord as unknown as { client: { user: { tag: string; id: string } | null } }).client.user;
              if (!u) throw new Error('Not logged in');
              return u.tag;
            },
          },
          {
            name: 'DM access',
            run: async () => {
              if (!this.discord) throw new Error('Not connected');
              const r = await this.discord.getLatestDM();
              return r ? `${r.channelName}: ${r.content.slice(0, 80)}` : 'No DMs found';
            },
          },
          {
            name: 'Server access',
            run: async () => {
              if (!this.discord) throw new Error('Not connected');
              const r = await this.discord.getLatestChannelMessage();
              return r ? `#${r.channelName}: ${r.content.slice(0, 80)}` : 'No servers/channels found';
            },
          },
          {
            name: 'Gateway connection',
            run: async () => {
              if (!this.discord) throw new Error('Not connected');
              // Discord does not allow DMing yourself and group DMs require
              // other users — so we verify the live connection via gateway ping.
              const ping = (this.discord as unknown as { client: { ws: { ping: number } } }).client.ws.ping;
              if (ping < 0) throw new Error('Gateway not connected (ping unavailable)');
              return `Gateway live — ${ping}ms latency`;
            },
          },
        ];

        case 'telegram': return [
          {
            name: 'Verify session',
            run: async () => {
              if (!this.telegram) throw new Error('Telegram not connected');
              const info = this.telegram.accountInfo;
              if (!info) throw new Error('No account info');
              return `${info.displayName} (${info.userId})`;
            },
          },
          {
            name: 'DM access',
            run: async () => {
              if (!this.telegram) throw new Error('Not connected');
              const r = await this.telegram.testLatestDM();
              return r ? `${r.channelName}: ${r.content.slice(0, 80)}` : 'No DMs found';
            },
          },
          {
            name: 'Group/channel access',
            run: async () => {
              if (!this.telegram) throw new Error('Not connected');
              const r = await this.telegram.testLatestChannel();
              return r ? `${r.channelName}: ${r.content.slice(0, 80)}` : 'No groups/channels found';
            },
          },
          {
            name: 'Send & receive DM to self',
            run: async () => {
              if (!this.telegram) throw new Error('Not connected');
              const t0 = Date.now();
              // Send to Saved Messages (self)
              const sent = await this.telegram.sendSelfWithToken(token);
              if (!sent) throw new Error('Failed to send message');
              // GramJS NewMessage only fires for incoming messages, not outgoing
              // ones — so we verify by fetching the message directly from the API
              const verified = await this.telegram.verifyMessageExists(sent.messageId, token);
              if (!verified) throw new Error('Message sent but could not be verified in Saved Messages');
              const ms = Date.now() - t0;
              const deleted = await this.telegram.deleteSelfMessage(sent.messageId, token);
              return `Sent to Saved Messages in ${ms}ms, verified${deleted ? ', deleted' : ' (delete failed)'}`;
            },
          },
        ];

        case 'twitter': return [
          {
            name: 'Verify session',
            run: async () => {
              if (!this.twitter) throw new Error('Twitter not connected');
              const info = this.twitter.accountInfo;
              if (!info) throw new Error('Not logged in');
              return `@${info.handle} (${info.displayName})`;
            },
          },
          {
            name: 'DM access',
            run: async () => {
              if (!this.twitter) throw new Error('Not connected');
              await this.twitter.syncDMs();
              const { getDb } = await import('../db/client.js');
              const { twitterDms } = await import('../db/schema.js');
              const db = getDb();
              const count = db.select().from(twitterDms).all().length;
              return count > 0 ? `${count} DMs synced` : 'No DMs found (DM sync ran successfully)';
            },
          },
          {
            name: 'Feed access',
            run: async () => {
              if (!this.twitter) throw new Error('Not connected');
              try {
                const feed = await this.twitter.getHomeFeed(1);
                if (!feed.length) return 'No tweets in feed (authenticated but feed may be empty)';
                const t = feed[0];
                return `@${t.username}: ${(t.text || '').slice(0, 80)}`;
              } catch (e) {
                // Surface ApiError.data if available for better diagnostics
                const apiData = (e as Record<string, unknown>)?.data;
                const detail = apiData ? ` — ${JSON.stringify(apiData).slice(0, 120)}` : '';
                throw new Error(`${e instanceof Error ? e.message : String(e)}${detail}`);
              }
            },
          },
        ];

        case 'gmail': return [
          {
            name: 'Verify OAuth',
            run: async () => {
              const gmail = this.getGmail();
              if (!gmail) throw new Error('No Gmail accounts connected');
              const info = gmail.accountInfo;
              if (!info) throw new Error('No account info');
              const count = this.gmailAccounts.size;
              return `${info.email}${count > 1 ? ` (+${count - 1} more)` : ''}`;
            },
          },
          {
            name: 'Gmail inbox access',
            run: async () => {
              const gmail = this.getGmail();
              if (!gmail) throw new Error('Not connected');
              const labels = await gmail.getLabels();
              const inbox = labels.find((l) => l.id === 'INBOX');
              if (!inbox) return 'Gmail accessible (INBOX label not found)';
              const unread = inbox.messagesUnread ?? 0;
              return `INBOX accessible — ${unread} unread`;
            },
          },
          {
            name: 'Calendar access',
            run: async () => {
              const cal = this.getCalendar();
              if (!cal) throw new Error('No Calendar account connected — ensure the account was connected with calendar scope');
              const cals = await cal.getCalendars();
              if (!cals.length) throw new Error('Calendar scope granted but no calendars returned');
              const primary = cals.find((c) => c.primary);
              return `${primary?.summary || cals[0].summary} (${cals.length} calendar${cals.length !== 1 ? 's' : ''})`;
            },
          },
          {
            name: 'Drive access (Meet Notes)',
            run: async () => {
              // Verify the drive.readonly scope by listing a single file.
              // If the scope is missing the API returns a 403, which we surface clearly.
              const creds = this.getGmail()?.accountInfo;
              if (!creds) throw new Error('No Gmail account connected');
              const { google } = await import('googleapis');
              const { getGmailCredsByEmail } = await import('../api/google-auth.js');
              const gmailCreds = getGmailCredsByEmail(creds.email);
              if (!gmailCreds) throw new Error('Credentials not found');
              const auth = new google.auth.OAuth2(gmailCreds.clientId, gmailCreds.clientSecret);
              auth.setCredentials({ access_token: gmailCreds.accessToken, refresh_token: gmailCreds.refreshToken });
              const drive = google.drive({ version: 'v3', auth });
              try {
                const res = await drive.files.list({ pageSize: 1, fields: 'files(id,name)' });
                const count = res.data.files?.length ?? 0;
                return `Drive accessible${count > 0 ? ` — found ${count} file(s) in sample` : ' (no files returned, but scope is valid)'}`;
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('insufficient')) {
                  throw new Error('drive.readonly scope not granted — remove and re-add this Google account with the updated scope list');
                }
                throw e;
              }
            },
          },
          {
            name: 'Meet API access (Meet Notes)',
            run: async () => {
              // Verify meetings.space.readonly scope via the Meet REST API.
              const gmailInst = this.getGmail();
              if (!gmailInst?.accountInfo) throw new Error('No Gmail account connected');
              const { google } = await import('googleapis');
              const { getGmailCredsByEmail } = await import('../api/google-auth.js');
              const gmailCreds = getGmailCredsByEmail(gmailInst.accountInfo.email);
              if (!gmailCreds) throw new Error('Credentials not found');
              const auth = new google.auth.OAuth2(gmailCreds.clientId, gmailCreds.clientSecret);
              auth.setCredentials({ access_token: gmailCreds.accessToken, refresh_token: gmailCreds.refreshToken });
              const meet = google.meet({ version: 'v2', auth });
              try {
                type ListFn = (p: Record<string, unknown>) => Promise<{ data: { conferenceRecords?: unknown[] } }>;
                const res = await (meet.conferenceRecords.list as unknown as ListFn)({ pageSize: 1 });
                const count = res.data.conferenceRecords?.length ?? 0;
                return `Meet API accessible${count > 0 ? ` — ${count} recent conference record(s) found` : ' (no recent conferences, but scope is valid)'}`;
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('insufficient')) {
                  throw new Error('meetings.space.readonly scope not granted — remove and re-add this Google account with the updated scope list');
                }
                throw e;
              }
            },
          },
        ];

        case 'calendar': return [
          {
            name: 'Verify OAuth',
            run: async () => {
              const cal = this.getCalendar();
              if (!cal) throw new Error('No Calendar accounts connected');
              const cals = await cal.getCalendars();
              if (!cals.length) throw new Error('No calendars returned');
              const primary = cals.find((c) => c.primary);
              return `${primary?.summary || cals[0].summary} (${cals.length} calendar${cals.length !== 1 ? 's' : ''})`;
            },
          },
          {
            name: 'Events access',
            run: async () => {
              if (!this.getCalendar()) throw new Error('Not connected');
              const { getDb } = await import('../db/client.js');
              const { calendarEvents } = await import('../db/schema.js');
              const db = getDb();
              const count = db.select().from(calendarEvents).all().length;
              return count > 0 ? `${count} events synced` : 'Calendar accessible (no events in sync range)';
            },
          },
        ];

        case 'notion': return (() => {
          // Notion test steps inlined here to match the synchronous Step[] shape used by other services.
          return [
            {
              name: 'Verify token',
              run: async () => {
                if (!this.notion) throw new Error('Notion not connected');
                const info = this.notion.accountInfo;
                if (!info) throw new Error('No account info — reconnect');
                const { Client } = await import('@notionhq/client');
                const { getCreds } = await import('../api/credentials.js');
                const creds = getCreds('notion') as NotionCredsLite | null;
                if (!creds?.token) throw new Error('No token stored');
                const client = new Client({ auth: creds.token });
                const me = await client.users.me({});
                const workspaceName = (me as unknown as { workspace_name?: string }).workspace_name;
                const name = ('name' in me && me.name) ? me.name : me.id;
                return workspaceName ? `${name} @ ${workspaceName}` : name;
              },
            },
            {
              name: 'List accessible databases',
              run: async () => {
                if (!this.notion) throw new Error('Notion not connected');
                // In SDK v3, databases are data_sources
                const result = await this.notion.executeRead({ action: 'list_databases' }) as { results: unknown[]; has_more?: boolean };
                const count = result.results.length;
                if (count === 0) return 'No databases accessible — share databases with the integration in Notion';
                const names = (result.results as Array<{ title?: Array<{ plain_text?: string }> }>)
                  .slice(0, 3)
                  .map((r) => (r.title?.[0]?.plain_text) || 'Untitled')
                  .join(', ');
                return `${count}${result.has_more ? '+' : ''} databases: ${names}`;
              },
            },
            {
              name: 'List accessible pages',
              run: async () => {
                if (!this.notion) throw new Error('Notion not connected');
                const result = await this.notion.executeRead({
                  action: 'search',
                  query: '',
                  filter: { property: 'object', value: 'page' },
                }) as { results: unknown[]; has_more?: boolean };
                if (result.results.length === 0) return 'No pages accessible — share pages with the integration in Notion';
                return `${result.results.length}${result.has_more ? '+' : ''} pages accessible`;
              },
            },
          ];
        })();

        default:
          return [{ name: 'Check connection', run: async () => `${service} not supported` }];
      }
    })();

    for (let i = 0; i < steps.length; i++) {
      yield { step: i + 1, name: steps[i].name, status: 'running' };
      try {
        const detail = await steps[i].run();
        yield { step: i + 1, name: steps[i].name, status: 'success', detail };
      } catch (e) {
        yield { step: i + 1, name: steps[i].name, status: 'error', detail: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  async disconnectAll(): Promise<void> {
    if (this.slack) await this.slack.disconnect();
    if (this.discord) await this.discord.disconnect();
    if (this.telegram) this.telegram.disconnect();
    this.disconnectAllGmailAccounts();
    if (this.twitter) this.twitter.disconnect();
    if (this.notion) this.notion.disconnect();
    if (this.obsidian) this.obsidian.disconnect();
  }
}

let _manager: ConnectionManager | null = null;
export function getConnectionManager(): ConnectionManager {
  if (!_manager) _manager = new ConnectionManager();
  return _manager;
}
