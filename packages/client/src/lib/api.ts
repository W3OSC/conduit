const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    credentials: 'include',
    ...options,
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({})) as { loginRequired?: boolean; error?: string };
    // If the server is telling us we need to log in, reload so AuthGate re-checks
    if (body.loginRequired) {
      window.location.reload();
    }
    throw new Error(body.error || 'Authentication required');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// UI Auth uses a separate base URL since these routes are outside /api
async function uiAuthRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/ui-auth${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const uiAuth = {
  status: () => uiAuthRequest<{ enabled: boolean; totpEnabled: boolean; authenticated: boolean; configured: boolean }>('/status'),
  config: () => uiAuthRequest<{ enabled: boolean; totpEnabled: boolean; hasPassword: boolean }>('/config'),
  updateConfig: (body: { enabled?: boolean; password?: string; currentPassword?: string }) =>
    uiAuthRequest<{ success: boolean; enabled: boolean; totpEnabled: boolean }>('/config', { method: 'PUT', body: JSON.stringify(body) }),
  login: (password: string) =>
    uiAuthRequest<{ success: boolean; totpRequired: boolean; intermediateToken?: string; token?: string }>('/login', { method: 'POST', body: JSON.stringify({ password }) }),
  loginTotp: (code: string, intermediateToken: string) =>
    uiAuthRequest<{ success: boolean; token?: string }>('/login/totp', { method: 'POST', body: JSON.stringify({ code, intermediateToken }) }),
  logout: () => uiAuthRequest<{ success: boolean }>('/logout', { method: 'POST' }),
  totpSetup: () => uiAuthRequest<{ secret: string; otpauthUrl: string }>('/totp/setup', { method: 'POST' }),
  totpVerify: (code: string) => uiAuthRequest<{ success: boolean }>('/totp/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  totpDisable: () => uiAuthRequest<{ success: boolean }>('/totp', { method: 'DELETE' }),
};

export const api = {
  // Health
  health: () => request<{ status: string }>('/health'),

  // Status
  status: () => request<StatusResponse>('/status'),

  // Connections
  connections: () => request<Record<string, ConnectionStatus>>('/connections'),
  connect: (service: string) => request<{ success: boolean }>(`/connections/${service}/connect`, { method: 'POST' }),
  disconnect: (service: string) => request<{ success: boolean }>(`/connections/${service}/disconnect`, { method: 'POST' }),

  // Sync
  triggerSync: (service: string, forceFull = false) =>
    request<{ success: boolean; message: string }>(`/sync/${service}?force_full=${forceFull}`, { method: 'POST' }),
  cancelSync: (service: string) =>
    request<{ success: boolean; message: string }>(`/sync/${service}/cancel`, { method: 'POST' }),

  // Chats
  chats: () => request<ChatTreeMap>('/chats'),

  // Messages
  messages: (params?: MessageParams) => {
    const q = new URLSearchParams();
    if (params?.source)       q.set('source', params.source);
    if (params?.chat_id)      q.set('chat_id', params.chat_id);
    if (params?.limit)        q.set('limit', String(params.limit));
    if (params?.before)       q.set('before', params.before);
    if (params?.after)        q.set('after', params.after);
    if (params?.around)       q.set('around', params.around);
    if (params?.include_meta) q.set('include_meta', 'true');
    return request<MessagesResponse>(`/messages?${q}`);
  },

  // Unified activity feed — messages + emails across all platforms in one call
  activity: (params?: ActivityParams) => {
    const q = new URLSearchParams();
    if (params?.since)   q.set('since', params.since);
    if (params?.until)   q.set('until', params.until);
    if (params?.limit)   q.set('limit', String(params.limit));
    if (params?.sources) q.set('sources', params.sources);
    return request<ActivityResponse>(`/activity?${q}`);
  },

  search: (q: string, source?: string, limit?: number) => {
    const params = new URLSearchParams({ q });
    if (source) params.set('source', source);
    if (limit) params.set('limit', String(limit));
    return request<{ results: Message[] }>(`/search?${params}`);
  },

  // Outbox
  outbox: (status?: string, source?: string) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (source) q.set('source', source);
    return request<{ items: OutboxItem[]; pendingCount: number }>(`/outbox?${q}`);
  },
  createOutboxItem: (body: CreateOutboxItem) =>
    request<OutboxItem>('/outbox', { method: 'POST', body: JSON.stringify(body) }),
  createBatchOutbox: (body: BatchOutboxItem) =>
    request<{ batchId: string; items: OutboxItem[] }>('/outbox/batch', { method: 'POST', body: JSON.stringify(body) }),
  updateOutboxItem: (id: number, action: 'approve' | 'reject' | 'edit', content?: string) =>
    request<{ success: boolean; status: string }>(`/outbox/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action, content }),
    }),
  deleteOutboxItem: (id: number) =>
    request<{ success: boolean }>(`/outbox/${id}`, { method: 'DELETE' }),

  // Permissions
  permissions: () => request<Permission[]>('/permissions'),
  updatePermission: (service: string, updates: Partial<Permission>) =>
    request<Permission>(`/permissions/${service}`, { method: 'PUT', body: JSON.stringify(updates) }),

  // Unread state — server-authoritative
  getUnread: () => request<Array<{ source: string; chatId: string; count: number; isMuted: boolean }>>('/unread'),
  markChatRead: (source: string, chatId: string) =>
    request<{ success: boolean }>(`/unread/${source}/${encodeURIComponent(chatId)}/read`, { method: 'POST' }),

  // Audit Log
  auditLog: (params?: AuditParams) => {
    const q = new URLSearchParams();
    if (params?.action) q.set('action', params.action);
    if (params?.service) q.set('service', params.service);
    if (params?.actor) q.set('actor', params.actor);
    if (params?.from) q.set('from', params.from);
    if (params?.to) q.set('to', params.to);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    return request<{ items: AuditLogItem[]; total: number }>(`/audit-log?${q}`);
  },

  // Metrics
  messagesOverTime: (days?: number, granularity?: string) => {
    const q = new URLSearchParams();
    if (days) q.set('days', String(days));
    if (granularity) q.set('granularity', granularity);
    return request<MetricsTimeData>(`/metrics/messages-over-time?${q}`);
  },
  syncRuns: (days?: number, source?: string) => {
    const q = new URLSearchParams();
    if (days) q.set('days', String(days));
    if (source) q.set('source', source);
    return request<SyncRunsData>(`/metrics/sync-runs?${q}`);
  },
  outboxActivity: (days?: number) =>
    request<OutboxActivityData>(`/metrics/outbox-activity${days ? `?days=${days}` : ''}`),
  apiUsage: (days?: number) =>
    request<ApiUsageData>(`/metrics/api-usage${days ? `?days=${days}` : ''}`),

  // Settings
  settings: () => request<Record<string, unknown>>('/settings'),
  updateSettings: (updates: Record<string, unknown>) =>
    request<Record<string, unknown>>('/settings', { method: 'PUT', body: JSON.stringify(updates) }),

  // Credentials
  credentials: () => request<CredentialsResponse>('/credentials'),
  updateCredentials: (service: string, creds: Record<string, string>) =>
    request<Record<string, unknown>>(`/credentials/${service}`, { method: 'PUT', body: JSON.stringify(creds) }),

  // Telegram OTP auth
  telegramSendCode: (apiId: string, apiHash: string, phone: string) =>
    request<{ success: boolean }>('/connections/telegram/auth/send-code', {
      method: 'POST', body: JSON.stringify({ apiId, apiHash, phone }),
    }),
  telegramSignIn: (code: string) =>
    request<{ success: boolean; passwordRequired?: boolean; status: unknown }>('/connections/telegram/auth/sign-in', {
      method: 'POST', body: JSON.stringify({ code }),
    }),
  telegramCheckPassword: (password: string) =>
    request<{ success: boolean; status: unknown }>('/connections/telegram/auth/check-password', {
      method: 'POST', body: JSON.stringify({ password }),
    }),

  // Raw (unredacted) credentials for Settings page
  credentialsRaw: (service: string) =>
    request<Record<string, string>>(`/credentials/${service}/raw`),

  // Service data reset + resync
  resetService: (service: string) =>
    request<{ success: boolean; message: string }>(`/service/${service}/reset`, { method: 'POST' }),

  // Discord guild management
  discordGuilds: () =>
    request<DiscordGuildInfo[]>('/discord/guilds'),
  setDiscordSyncGuilds: (guildIds: string[]) =>
    request<{ success: boolean; guildIds: string[] }>('/discord/sync-guilds', {
      method: 'POST', body: JSON.stringify({ guildIds }),
    }),

  // Rebuild contacts from existing message DB (applies criteria changes in real-time)
  rebuildContacts: (source?: string) =>
    request<{ success: boolean; upserted: number; sources: string[] }>(
      `/contacts/rebuild${source ? `?source=${source}` : ''}`,
      { method: 'POST' },
    ),

  // Contacts
  contacts: (params?: ContactParams) => {
    const q = new URLSearchParams();
    if (params?.source)   q.set('source', params.source);
    if (params?.q)        q.set('q', params.q);
    if (params?.criteria) q.set('criteria', params.criteria);
    if (params?.limit)    q.set('limit', String(params.limit));
    if (params?.offset)   q.set('offset', String(params.offset));
    return request<{ contacts: Contact[]; total: number; limit: number; offset: number }>(`/contacts?${q}`);
  },
  contact: (source: string, platformId: string) =>
    request<Contact>(`/contacts/${source}/${encodeURIComponent(platformId)}`),
  contactHistory: (source: string, platformId: string, params?: { limit?: number; before?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit)  q.set('limit', String(params.limit));
    if (params?.before) q.set('before', params.before);
    return request<{ messages: ContactMessage[]; total: number; source: string; platformId: string }>(
      `/contacts/${source}/${encodeURIComponent(platformId)}/history?${q}`,
    );
  },
  contactDmChannel: (source: string, platformId: string) =>
    request<{ channelId: string; channelName: string }>(
      `/contacts/${source}/${encodeURIComponent(platformId)}/dm-channel`,
    ),
  messageContact: (source: string, platformId: string, content: string) =>
    request<{ success: boolean; status: string; outboxItemId?: number }>(
      `/contacts/${source}/${encodeURIComponent(platformId)}/message`,
      { method: 'POST', body: JSON.stringify({ content }) },
    ),
  deleteContact: (source: string, platformId: string) =>
    request<{ success: boolean }>(`/contacts/${source}/${encodeURIComponent(platformId)}`, { method: 'DELETE' }),
  contactCriteria: (service: string) =>
    request<ContactCriteria>(`/contacts/criteria/${service}`),
  updateContactCriteria: (service: string, criteria: Partial<ContactCriteria>) =>
    request<ContactCriteria>(`/contacts/criteria/${service}`, {
      method: 'PUT', body: JSON.stringify(criteria),
    }),

  // API Keys
  apiKeys: () => request<ApiKeyItem[]>('/keys'),
  createApiKey: (name: string) =>
    request<ApiKeyItem & { key: string }>('/keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (id: number) =>
    request<{ success: boolean }>(`/keys/${id}`, { method: 'DELETE' }),

  // Per-key permissions
  keyPermissions: (keyId: number) =>
    request<KeyPermissionsResponse>(`/permissions/keys/${keyId}`),
  updateKeyPermission: (keyId: number, service: string, perms: Partial<KeyServicePerm>) =>
    request<{ success: boolean }>(`/permissions/keys/${keyId}/${service}`, {
      method: 'PUT', body: JSON.stringify(perms),
    }),

  // Google Auth — multi-account
  googleStatus: () => request<GoogleAuthStatus>('/google/status'),
  googleAccounts: () => request<GoogleAccountStatus[]>('/google/accounts'),
  gmailAccountStatuses: () => request<GmailAccountConnectionStatus[]>('/connections/gmail/accounts'),
  addGoogleAccount: (creds: { clientId: string; clientSecret: string; accessToken: string; refreshToken: string }) =>
    request<{ success: boolean; email: string; accountCount: number }>('/google/credentials', { method: 'POST', body: JSON.stringify(creds) }),
  removeGoogleAccount: (email: string) =>
    request<{ success: boolean; remaining: number }>(`/google/credentials/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  removeAllGoogleAccounts: () => request<{ success: boolean }>('/google/credentials', { method: 'DELETE' }),
  refreshGoogleToken: (email?: string) =>
    email
      ? request<{ success: boolean; email: string; expiresAt: string }>(`/google/refresh/${encodeURIComponent(email)}`, { method: 'POST' })
      : request<{ success: boolean; results: unknown[] }>('/google/refresh', { method: 'POST' }),
  connectGoogle: () => request<{ success: boolean }>('/connections/gmail/connect', { method: 'POST' }),
  connectGmailAccount: (email: string) =>
    request<{ success: boolean; statuses: GmailAccountConnectionStatus[] }>(`/connections/gmail/accounts/${encodeURIComponent(email)}/connect`, { method: 'POST' }),
  disconnectGmailAccount: (email: string) =>
    request<{ success: boolean }>(`/connections/gmail/accounts/${encodeURIComponent(email)}/disconnect`, { method: 'POST' }),
  syncGmailAccount: (email: string) =>
    request<{ success: boolean; message: string }>(`/connections/gmail/accounts/${encodeURIComponent(email)}/sync`, { method: 'POST' }),
  resetGmailAccount: (email: string) =>
    request<{ success: boolean; message: string }>(`/service/gmail/reset/${encodeURIComponent(email)}`, { method: 'POST' }),

  // Gmail
  gmailStatus: () => request<{ connected: boolean; status: string; email?: string; messageCount: number; unreadCount: number }>('/gmail/status'),
  gmailMessages: (params?: { q?: string; label?: string; unread?: boolean; starred?: boolean; limit?: number; offset?: number; thread_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.q)        q.set('q', params.q);
    if (params?.label)    q.set('label', params.label);
    if (params?.unread)   q.set('unread', 'true');
    if (params?.starred)  q.set('starred', 'true');
    if (params?.limit)    q.set('limit', String(params.limit));
    if (params?.offset)   q.set('offset', String(params.offset));
    if (params?.thread_id) q.set('thread_id', params.thread_id);
    return request<{ messages: GmailMessage[]; total: number; limit: number; offset: number }>(`/gmail/messages?${q}`);
  },
  gmailMessage: (id: string) => request<GmailMessage>(`/gmail/messages/${id}`),
  gmailBody: (id: string) => request<{ html: string; text: string; attachments: GmailAttachment[] }>(`/gmail/messages/${id}/body`),
  gmailThread: (threadId: string) => request<{ messages: GmailMessage[]; threadId: string }>(`/gmail/threads/${threadId}`),
  gmailLabels: () => request<{ labels: GmailLabel[] }>('/gmail/labels'),
  gmailAction: (action: GmailActionParams) => request<{ success: boolean; outboxItemId: number; status: string }>('/gmail/actions', { method: 'POST', body: JSON.stringify(action) }),
  gmailSync: () => request<{ success: boolean; message: string }>('/gmail/sync', { method: 'POST' }),

  // Calendar
  calendarStatus: () => request<{ connected: boolean; status: string; eventCount: number }>('/calendar/status'),
  calendarEvents: (params?: { from?: string; to?: string; calendarId?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.from)       q.set('from', params.from);
    if (params?.to)         q.set('to', params.to);
    if (params?.calendarId) q.set('calendarId', params.calendarId);
    if (params?.limit)      q.set('limit', String(params.limit));
    return request<{ events: CalendarEvent[]; total: number }>(`/calendar/events?${q}`);
  },
  calendarEvent: (id: string) => request<CalendarEvent>(`/calendar/events/${id}`),
  calendarList: () => request<{ calendars: GoogleCalendarInfo[] }>('/calendar/calendars'),
  calendarAction: (action: CalendarActionParams) => request<{ success: boolean; outboxItemId: number; status: string }>('/calendar/actions', { method: 'POST', body: JSON.stringify(action) }),
  calendarSync: () => request<{ success: boolean; message: string }>('/calendar/sync', { method: 'POST' }),

  // Twitter
  twitterStatus: () => request<TwitterStatus>('/twitter/status'),
  twitterAuthStatus: () => request<{ configured: boolean; connected: boolean; handle: string | null; cookiesValid: boolean }>('/twitter/auth/status'),
  twitterConnect: (cookieString: string) =>
    request<{ success: boolean; handle?: string; status: string; error?: string }>('/twitter/auth/connect', { method: 'POST', body: JSON.stringify({ cookieString }) }),
  twitterDisconnect: () => request<{ success: boolean }>('/twitter/auth/disconnect', { method: 'DELETE' }),
  twitterRefresh: () => request<{ success: boolean }>('/twitter/auth/refresh', { method: 'POST' }),
  twitterFeed: (count = 20, reset = false) => request<{ tweets: Tweet[] }>(`/twitter/feed?count=${count}&reset=${reset}`),
  twitterSearch: (q: string, count = 20, mode = 'Latest') => request<{ tweets?: Tweet[]; profiles?: TwitterProfile[] }>(`/twitter/search?q=${encodeURIComponent(q)}&count=${count}&mode=${mode}`),
  twitterTrends: () => request<{ trends: string[] }>('/twitter/trends'),
  twitterTweet: (id: string) => request<Tweet>(`/twitter/tweet/${id}`),
  twitterThread: (id: string) => request<{ tweets: Tweet[] }>(`/twitter/tweet/${id}/thread`),
  twitterUserProfile: (handle: string) => request<TwitterProfile>(`/twitter/user/${encodeURIComponent(handle)}`),
  twitterUserTweets: (handle: string, count = 20) => request<{ tweets: Tweet[] }>(`/twitter/user/${encodeURIComponent(handle)}/tweets?count=${count}`),
  twitterUserFollowers: (handle: string, count = 50) => request<{ profiles: TwitterProfile[] }>(`/twitter/user/${encodeURIComponent(handle)}/followers?count=${count}`),
  twitterUserFollowing: (handle: string, count = 50) => request<{ profiles: TwitterProfile[] }>(`/twitter/user/${encodeURIComponent(handle)}/following?count=${count}`),
  twitterMe: () => request<TwitterProfile>('/twitter/me'),
  twitterMentions: (count = 20) => request<{ tweets: Tweet[] }>(`/twitter/notifications/mentions?count=${count}`),
  twitterDms: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit)  q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    return request<{ conversations: TwitterConversation[]; total: number }>(`/twitter/dms?${q}`);
  },
  twitterDmConversation: (conversationId: string, limit = 100) =>
    request<{ messages: TwitterDm[]; conversationId: string }>(`/twitter/dms/${encodeURIComponent(conversationId)}?limit=${limit}`),
  twitterSyncDms: () => request<{ success: boolean; newMessages: number }>('/twitter/sync', { method: 'POST' }),
  twitterAction: (action: TwitterActionParams) => request<{ success: boolean; outboxItemId: number; status: string }>('/twitter/actions', { method: 'POST', body: JSON.stringify(action) }),
  twitterAnalytics: () => request<TwitterAnalytics>('/twitter/analytics'),

  // ── Meet Notes ──────────────────────────────────────────────────────────────
  meetNotes: (params?: { limit?: number; offset?: number; q?: string; account_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit)      q.set('limit',      String(params.limit));
    if (params?.offset)     q.set('offset',     String(params.offset));
    if (params?.q)          q.set('q',          params.q);
    if (params?.account_id) q.set('account_id', params.account_id);
    return request<{ notes: MeetNote[]; total: number; limit: number; offset: number }>(`/meet-notes?${q}`);
  },
  meetNote: (id: number) => request<MeetNote>(`/meet-notes/${id}`),
  meetNoteRefresh: (id: number) => request<{ success: boolean; content: string | null }>(`/meet-notes/${id}/refresh`, { method: 'POST' }),
  meetNotesSync: () => request<{ success: boolean; message: string }>('/meet-notes/sync', { method: 'POST' }),
  meetNotesSettings: () => request<{ driveSearchEnabled: boolean }>('/meet-notes/settings'),
  meetNotesUpdateSettings: (settings: { driveSearchEnabled: boolean }) =>
    request<{ success: boolean; driveSearchEnabled: boolean }>('/meet-notes/settings', { method: 'PUT', body: JSON.stringify(settings) }),

  // ── AI Chat ─────────────────────────────────────────────────────────────────
  aiConnection: () => request<AiConnection>('/ai/connection'),
  setupAiConnection: (webhookUrl: string, gatewayToken?: string) =>
    request<AiConnection & { apiKey: string }>('/ai/connection', { method: 'POST', body: JSON.stringify({ webhookUrl, gatewayToken: gatewayToken || undefined }) }),
  updateAiConnection: (patch: { callbackBaseUrl?: string | null; gatewayToken?: string | null }) =>
    request<AiConnection>('/ai/connection', { method: 'PATCH', body: JSON.stringify(patch) }),
  updateAiCallbackBase: (callbackBaseUrl: string | null) =>
    request<AiConnection>('/ai/connection', { method: 'PATCH', body: JSON.stringify({ callbackBaseUrl }) }),
  testAiConnection: () =>
    request<{ success: boolean; latencyMs?: number; error?: string }>('/ai/connection/test', { method: 'POST' }),
  disconnectAi: () =>
    request<{ success: boolean }>('/ai/connection', { method: 'DELETE' }),
  aiPermissions: () => request<AiPermissions>('/ai/permissions'),
  updateAiPermissions: (body: Partial<AiPermissions>) =>
    request<AiPermissions>('/ai/permissions', { method: 'PUT', body: JSON.stringify(body) }),

  aiSessions: () => request<AiSession[]>('/ai/sessions'),
  createAiSession: (body?: { title?: string }) =>
    request<AiSession>('/ai/sessions', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  updateAiSession: (id: string, body: { title?: string }) =>
    request<AiSession>(`/ai/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAiSession: (id: string) =>
    request<{ success: boolean }>(`/ai/sessions/${id}`, { method: 'DELETE' }),
  aiMessages: (sessionId: string, limit?: number) => {
    const q = new URLSearchParams();
    if (limit) q.set('limit', String(limit));
    return request<{ session: AiSession; messages: AiMessage[] }>(`/ai/sessions/${sessionId}/messages?${q}`);
  },
  sendAiMessage: (sessionId: string, content: string) =>
    request<AiMessage>(`/ai/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),

  // ── Obsidian Vault ───────────────────────────────────────────────────────────
  obsidianConfig: () => request<ObsidianConfigResponse>('/obsidian/config'),
  saveObsidianConfig: (body: ObsidianConfigInput) =>
    request<ObsidianConfigResponse>('/obsidian/config', { method: 'POST', body: JSON.stringify(body) }),
  deleteObsidianConfig: (deleteLocal = false) =>
    request<{ success: boolean }>('/obsidian/config', { method: 'DELETE', body: JSON.stringify({ delete_local: deleteLocal }) }),
  generateObsidianSshKey: () =>
    request<{ publicKey: string; fingerprint: string | null }>('/obsidian/config/generate-ssh-key', { method: 'POST' }),
  getObsidianSshKey: () =>
    request<{ publicKey: string }>('/obsidian/config/ssh-key'),
  getObsidianSshFingerprint: () =>
    request<{ fingerprint: string | null }>('/obsidian/config/ssh-fingerprint'),
  cloneObsidianVault: () =>
    request<{ success: boolean; message: string }>('/obsidian/config/clone', { method: 'POST' }),
  testObsidianConnection: () =>
    request<{ success: boolean; error?: string }>('/obsidian/config/test', { method: 'POST' }),
  obsidianSyncStatus: () =>
    request<ObsidianSyncStatus>('/obsidian/sync/status'),
  syncObsidianVault: () =>
    request<{ success: boolean; message: string }>('/obsidian/sync', { method: 'POST' }),
  obsidianFiles: () =>
    request<{ files: VaultFileEntry[] }>('/obsidian/files'),
  obsidianReadFile: (filePath: string) =>
    request<{ path: string; content: string }>(`/obsidian/files/${encodeURIComponent(filePath)}`),

  // ── Notion ───────────────────────────────────────────────────────────────────
  /** Search the Notion workspace. Pass no query to get top-level pages. */
  notionSearch: (params?: { query?: string; filter?: { property: 'object'; value: 'page' | 'data_source' }; page_size?: number; start_cursor?: string }) =>
    request<NotionSearchResponse>('/notion/search', { method: 'POST', body: JSON.stringify(params ?? {}) }),
  notionPage: (pageId: string) =>
    request<NotionPage>(`/notion/pages/${pageId}`),
  notionBlockChildren: (blockId: string, params?: { page_size?: number; start_cursor?: string }) => {
    const q = new URLSearchParams();
    if (params?.page_size)   q.set('page_size',   String(params.page_size));
    if (params?.start_cursor) q.set('start_cursor', params.start_cursor);
    const qs = q.toString() ? `?${q}` : '';
    return request<NotionBlockChildrenResponse>(`/notion/blocks/${blockId}/children${qs}`);
  },

  // Update
  updateStatus: () => request<UpdateStatus>('/update/status'),
  applyUpdate: () => request<{ success: boolean; message: string; followUp?: string }>('/update/apply', { method: 'POST' }),
};

// Types
export interface ActiveSyncRun {
  id: number;
  source: string;
  syncType: string;
  chatsVisited: number;
  messagesSaved: number;
  startedAt: string;
}

export interface StatusResponse {
  messageCounts: Record<string, number>;
  errorCount: number;
  chatCounts: Record<string, number>;
  lastSync: Record<string, unknown>;
  activeSyncs: Record<string, ActiveSyncRun>;
}

export interface ConnectionStatus {
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  mode?: string;
  phase?: string;
  message?: string;
  error?: string;
  accountId?: string;
  displayName?: string;
  lastSync?: string;
}

// Legacy flat chat item (kept for compat)
export interface ChatItem {
  id?: number;
  source?: string;
  chatId?: string;
  chatName?: string;
  channelId?: string;
  channelName?: string;
  lastMessageTs?: string;
  lastFetchedAt?: string;
  messageCount?: number;
}

// New tree structure returned by /chats
export interface ChatEntry {
  id: string;
  name: string;
  source: string;
  messageCount: number;
  lastTs?: string;
  avatarUrl?: string | null;
  guildId?: string | null;                  // Discord server channels only
  lastMessageId?: string | number | null;   // Telegram: for message-level deep links
}

export interface ChatSection {
  id: string;
  label: string;
  type: 'dms' | 'server' | 'channels' | 'flat';
  chats: ChatEntry[];
  children?: ChatSection[];
}

export interface ServiceTree {
  source: string;
  sections: ChatSection[];
}

export type ChatTreeMap = Record<string, ServiceTree>;

export interface MessageAttachmentFile {
  url: string;
  proxyURL?: string;
  filename?: string;
  contentType?: string;
  filetype?: string;
  width?: number | null;
  height?: number | null;
}

export interface MessageAttachments {
  files?: MessageAttachmentFile[];
  embedImages?: Array<{ url: string; proxyURL?: string }>;
  richAttachments?: unknown[];
}

// ─── Activity feed types ──────────────────────────────────────────────────────

export interface ActivityItem {
  type: 'message' | 'email';
  source: string;
  timestamp: string;
  messageId: string;
  chatId: string;
  chatName: string | null;
  content: string;
  senderName: string;
  senderAvatarUrl: string | null;
  isMe: boolean;
  context: 'dm' | 'group' | 'channel';
  // email-specific (present when type === 'email')
  subject?: string | null;
  isRead?: boolean;
  isStarred?: boolean;
  threadId?: string;
}

export interface ActivityParams {
  since?: string;        // ISO timestamp, default 24h ago
  until?: string;        // ISO timestamp, default now
  limit?: number;        // max 200, default 50
  sources?: string;      // comma-separated: slack,discord,telegram,gmail,twitter
}

export interface ActivityResponse {
  items: ActivityItem[];
  total: number;
  since: string;
  until: string;
}

// ─── Conversation meta (returned when include_meta=true on /messages) ─────────

export interface ConversationParticipant {
  platformId: string;
  displayName: string;
  avatarUrl: string | null;
  isMe: boolean;
  messageCount: number;
}

export interface ConversationMeta {
  chatId: string;
  source: string;
  chatName: string | null;
  type: 'dm' | 'group' | 'channel';
  participants: ConversationParticipant[];
}

export interface Message {
  id?: number;
  source: string;
  messageId?: number | string;
  chatId?: number | string;
  chatName?: string;
  channelId?: string;
  channelName?: string;
  guildName?: string;
  // Enriched sender fields (server joins contacts table)
  senderName?: string;
  senderId?: string | number | null;
  avatarUrl?: string | null;
  isMe?: boolean;
  // Raw platform-specific name fields (kept for compat)
  authorName?: string;
  authorId?: string | null;
  userName?: string;
  userId?: string | null;
  content?: string;
  // Attachments JSON string (parsed client-side)
  attachments?: string | null;
  timestamp: string;
}

export interface MessageParams {
  source?: string;
  chat_id?: string;
  limit?: number;
  before?: string;
  after?: string;
  around?: string;        // ISO timestamp — fetch messages centred on this point
  include_meta?: boolean; // when true + chat_id, returns conversationMeta
}

export interface MessagesResponse {
  messages: Message[];
  total: number;
  conversationMeta?: ConversationMeta;
}

/** Shape passed via React Router location.state when navigating to /chat */
export interface ChatNavState {
  chatId: string;
  source: string;
  name: string;
  messageCount?: number;
  scrollToMessageId?: string;   // auto-scroll to and highlight this message
  scrollToTimestamp?: string;   // ISO timestamp near the target (for page loading)
}

export interface OutboxItem {
  id: number;
  batchId?: string;
  source: string;
  recipientId: string;
  recipientName?: string;
  content: string;
  editedContent?: string;
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed';
  requester: 'ui' | 'api';
  apiKeyId?: number;
  errorMessage?: string;
  createdAt: string;
  approvedAt?: string;
  sentAt?: string;
}

export interface CreateOutboxItem {
  source: string;
  recipient_id: string;
  recipient_name?: string;
  content: string;
}

export interface BatchOutboxItem {
  source: string;
  recipient_ids: Array<{ id: string; name?: string }>;
  content: string;
}

export interface Permission {
  id: number;
  service: string;
  readEnabled: boolean;
  sendEnabled: boolean;
  requireApproval: boolean;
  directSendFromUi: boolean;
  markReadEnabled: boolean;
  updatedAt?: string;
}

export interface AuditLogItem {
  id: number;
  action: string;
  service?: string;
  actor: string;
  apiKeyId?: number;
  targetId?: string;
  detail?: string;
  timestamp?: string;
}

export interface AuditParams {
  action?: string;
  service?: string;
  actor?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface MetricsTimeData {
  data: Array<{ date: string; telegram: number; discord: number; slack: number }>;
  granularity: string;
  days: number;
}

export interface SyncRunsData {
  data: Array<{ date: string; success: number; error: number; totalMessages: number }>;
  avgDuration: Record<string, number>;
  total: number;
}

export interface OutboxActivityData {
  data: Array<{ date: string; received: number; approved: number; rejected: number; sent: number }>;
}

export interface ApiUsageData {
  daily: Array<{ date: string } & Record<string, number>>;
  keys: string[];
}

export interface Contact {
  id: number;
  source: string;
  platformId: string;
  accountId: string | null;
  displayName: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  avatarUrl: string | null;
  bio: string | null;
  statusText: string | null;
  workspaceIds: string[];
  mutualGroupIds: string[];
  criteria: {
    hasDm: boolean;
    isFromOwnedGroup: boolean;
    isFromSmallGroup: boolean;
    isNativeContact: boolean;
  };
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastMessageAt: string | null;
  updatedAt: string | null;
  activityScore?: number;
  messageCount?: number;
}

export interface ContactMessage {
  id: number;
  source: string;
  messageId: string;
  chatId: string;
  chatName: string | null;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  context: 'dm' | 'group';
}

export interface ContactCriteria {
  enabled: boolean;
  hasDm: boolean;
  ownedGroup: boolean;
  smallGroup: boolean;
  nativeContacts: boolean;
  smallGroupThreshold: number;
}

export interface ContactParams {
  source?: string;
  q?: string;
  criteria?: 'dm' | 'owned' | 'small' | 'native';
  limit?: number;
  offset?: number;
}

export interface GoogleAccountStatus {
  email: string | null;
  configured: boolean;
  tokenValid: boolean;
  expiresAt: string | null;
}

export interface GoogleAuthStatus {
  configured: boolean;
  accountCount: number;
  accounts: GoogleAccountStatus[];
}

export interface GmailAccountConnectionStatus {
  email: string;
  gmail: { status: string; error?: string };
  calendar: { status: string; error?: string };
}

export interface DiscordGuildInfo {
  id: string;
  name: string;
  icon: string | null;
  synced: boolean;
  channels: Array<{ id: string; name: string; type: number }>;
}

export interface ServiceCredential {
  configured: boolean;
  token?: string;
  appToken?: string;
  apiId?: string;
  apiHash?: string;
  phone?: string;
  sessionString?: string;
  authenticated?: boolean;
}

export interface CredentialsResponse {
  slack: ServiceCredential;
  discord: ServiceCredential;
  telegram: ServiceCredential;
}

// ─── Gmail types ──────────────────────────────────────────────────────────────
export interface GmailMessage {
  id: number;
  gmailId: string;
  threadId: string;
  accountId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  subject: string | null;
  snippet: string | null;
  labels: string | null;
  hasAttachments: boolean | null;
  isRead: boolean | null;
  isStarred: boolean | null;
  internalDate: string | null;
  sizeEstimate: number | null;
  syncedAt: string | null;
}

export interface GmailAttachment {
  name: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface GmailActionParams {
  action: 'reply' | 'reply_all' | 'forward' | 'compose' | 'archive' | 'trash' | 'spam' | 'mark_read' | 'mark_unread' | 'star' | 'unstar' | 'move' | 'unsubscribe';
  messageId?: string;
  threadId?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  labelId?: string;
}

// ─── Calendar types ────────────────────────────────────────────────────────────
export interface CalendarEvent {
  id: number;
  eventId: string;
  calendarId: string;
  accountId: string | null;
  title: string | null;
  description: string | null;
  location: string | null;
  startTime: string;
  endTime: string | null;
  allDay: boolean | null;
  status: string | null;
  attendees: string | null;
  organizerEmail: string | null;
  organizerName: string | null;
  recurrence: string | null;
  htmlLink: string | null;
  meetLink: string | null;
  colorId: string | null;
  syncedAt: string | null;
  updatedAt: string | null;
}

export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor?: string;
  accessRole?: string;
  timeZone?: string;
}

export interface CalendarActionParams {
  action: 'create' | 'update' | 'delete' | 'rsvp';
  calendarId: string;
  eventId?: string;
  title?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  attendees?: string[];
  rsvpStatus?: 'accepted' | 'declined' | 'tentative';
  colorId?: string;
}

// ─── Twitter types ─────────────────────────────────────────────────────────────
export interface Tweet {
  id: string;
  text: string;
  username: string;
  name: string;
  userId: string;
  likes: number;
  retweets: number;
  replies: number;
  timestamp: number;
  permanentUrl: string;
  photos: Array<{ url: string; alt?: string }>;
  videos: Array<{ url: string; preview?: string }>;
  hashtags: string[];
  mentions: string[];
  urls: string[];
  isReply: boolean;
  isRetweet: boolean;
  retweetedStatus?: Tweet;
  quotedStatus?: Tweet;
  inReplyToStatusId?: string;
}

export interface TwitterProfile {
  userId?: string;
  username: string;
  name: string;
  biography?: string;
  followersCount?: number;
  followingCount?: number;
  tweetsCount?: number;
  isVerified?: boolean;
  location?: string;
  website?: string;
  avatar?: string;
  banner?: string;
  joined?: string;
}

export interface TwitterDm {
  id: number;
  conversationId: string;
  messageId: string;
  senderId: string;
  senderHandle: string | null;
  senderName: string | null;
  recipientId: string | null;
  text: string | null;
  createdAt: string;
  accountId: string | null;
  syncedAt: string | null;
}

export interface TwitterConversation {
  conversationId: string;
  participantIds: string[];
  lastMessage: TwitterDm;
  messageCount: number;
}

// ─── Twitter Analytics ────────────────────────────────────────────────────────

export interface TweetAnalytic {
  id: string;
  text: string;
  timestamp: number;
  date: string;
  likes: number;
  retweets: number;
  replies: number;
  totalEngagement: number;
  url: string;
}

export interface TwitterAnalyticsByDay {
  date: string;
  likes: number;
  retweets: number;
  replies: number;
  tweets: number;
}

export interface TwitterAnalyticsSummary {
  totalTweets: number;
  totalLikes: number;
  totalRetweets: number;
  totalReplies: number;
  avgLikes: number;
  avgRetweets: number;
  avgEngagement: number;
  bestTweet: TweetAnalytic | null;
  mostLiked: TweetAnalytic | null;
  mostRetweeted: TweetAnalytic | null;
}

export interface TwitterAnalytics {
  handle: string;
  tweets: TweetAnalytic[];
  byDay: TwitterAnalyticsByDay[];
  summary: TwitterAnalyticsSummary;
}

export interface TwitterStatus {
  connected: boolean;
  status: string;
  handle: string | null;
  userId: string | null;
  dmCount: number;
  configured: boolean;
}

export interface TwitterActionParams {
  action: 'tweet' | 'reply' | 'quote' | 'retweet' | 'like' | 'follow' | 'dm';
  text?: string;
  replyToId?: string;
  quotedId?: string;
  tweetId?: string;
  handle?: string;
  conversationId?: string;
}

export interface ApiKeyItem {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  key?: string;
}

export interface KeyServicePerm {
  service: string;
  readEnabled: boolean;
  sendEnabled: boolean;
  requireApproval: boolean;
  overrides: {
    readEnabled:     boolean | null;
    sendEnabled:     boolean | null;
    requireApproval: boolean | null;
  };
}

// ─── Meet Notes ───────────────────────────────────────────────────────────────

export interface MeetNote {
  id: number;
  noteId: string;
  source: 'meet' | 'drive';
  accountId: string | null;
  conferenceId: string | null;
  title: string | null;
  summary: string | null;
  docsUrl: string | null;
  driveFileId: string | null;
  meetingDate: string | null;
  calendarEventId: string | null;
  attendees: string | null;  // JSON array of { name, email }
  state: string | null;
  syncedAt: string | null;
  updatedAt: string | null;
}

export interface KeyPermissionsResponse {
  keyId: number;
  keyName: string;
  keyPrefix: string;
  permissions: KeyServicePerm[];
}

// ─── AI Chat types ────────────────────────────────────────────────────────────

export interface AiConnection {
  configured: boolean;
  /** True only after a connection test has passed. The connection is not fully enabled until this is true. */
  verified: boolean;
  webhookUrl: string | null;
  keyPrefix: string | null;
  /**
   * Optional override for the base URL sent to the AI agent as `conduitBaseUrl` and used to
   * build `streamUrl` in webhook payloads. Set this when the AI agent runs in a separate
   * container or machine and cannot reach `localhost`.
   */
  callbackBaseUrl: string | null;
  /**
   * Optional Bearer token sent as `Authorization: Bearer <token>` on every outbound webhook
   * request. Required when the webhook endpoint is protected by gateway authentication.
   */
  gatewayToken: string | null;
  baseUrl: string;
  streamUrlTemplate: string;
  openApiUrl: string;
  /** Only present on POST /ai/connection response — shown once */
  apiKey?: string;
}

export interface AiPermissions {
  readMessages: boolean;
  readEmails: boolean;
  readCalendar: boolean;
  readContacts: boolean;
  readVault: boolean;
  writeVault: boolean;
  sendOutbox: boolean;
  requireApproval: boolean;
}

export interface AiSession {
  id: string;
  title: string;
  systemPromptSent: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AiMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls: string | null; // JSON string of ToolCall[]
  streaming: boolean;
  createdAt: string | null;
}

export interface AiToolCall {
  name: string;
  input: unknown;
  output?: unknown;
}

// ─── Obsidian Vault types ─────────────────────────────────────────────────────

export interface VaultFileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  children?: VaultFileEntry[];
  extension?: string;
}

export interface ObsidianVaultConfigRow {
  id: number;
  name: string;
  remoteUrl: string;
  authType: 'https' | 'ssh';
  sshPublicKey: string | null;
  localPath: string;
  branch: string;
  lastSyncedAt: string | null;
  lastCommitHash: string | null;
  syncStatus: string;
  syncError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  hasHttpsToken: boolean;
  hasSshPrivateKey: boolean;
}

export interface ObsidianConfigResponse {
  configured: boolean;
  vault?: ObsidianVaultConfigRow;
}

export interface ObsidianConfigInput {
  name: string;
  remote_url: string;
  auth_type?: 'https' | 'ssh';
  https_token?: string;
  ssh_private_key?: string;
  ssh_public_key?: string;
  branch?: string;
}

export interface ObsidianSyncStatus {
  configured: boolean;
  syncStatus?: string;
  lastSyncedAt?: string | null;
  lastCommitHash?: string | null;
  error?: string | null;
}

export interface UpdateStatus {
  version: string;
  hasUpdate: boolean;
  commitsBehind: number;
  latestCommitSha: string;
  isDocker: boolean;
}

// ─── Notion types ─────────────────────────────────────────────────────────────

export interface NotionRichText {
  type: string;
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  text?: { content: string; link?: { url: string } | null };
  mention?: unknown;
  equation?: { expression: string };
}

export interface NotionPage {
  id: string;
  object: 'page';
  url: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  in_trash?: boolean;
  has_children?: boolean;
  parent: {
    type: string;
    page_id?: string;
    database_id?: string;
    workspace?: boolean;
  };
  properties: Record<string, NotionProperty>;
  icon?: { type: string; emoji?: string; external?: { url: string }; file?: { url: string } } | null;
  cover?: { type: string; external?: { url: string }; file?: { url: string } } | null;
}

export interface NotionProperty {
  id: string;
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number | null;
  select?: { id: string; name: string; color: string } | null;
  multi_select?: { id: string; name: string; color: string }[];
  date?: { start: string; end?: string | null } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  [key: string]: unknown;
}

export interface NotionDatabase {
  id: string;
  object: 'database';
  title: NotionRichText[];
  url: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  in_trash?: boolean;
  parent: {
    type: string;
    page_id?: string;
    workspace?: boolean;
  };
  icon?: { type: string; emoji?: string; external?: { url: string } } | null;
}

export type NotionSearchResult = NotionPage | NotionDatabase;

export interface NotionSearchResponse {
  object: 'list';
  results: NotionSearchResult[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionBlock {
  id: string;
  object: 'block';
  type: string;
  created_time: string;
  last_edited_time: string;
  has_children: boolean;
  archived: boolean;
  // Content keyed by type
  paragraph?: { rich_text: NotionRichText[]; color?: string };
  heading_1?: { rich_text: NotionRichText[]; color?: string; is_toggleable?: boolean };
  heading_2?: { rich_text: NotionRichText[]; color?: string; is_toggleable?: boolean };
  heading_3?: { rich_text: NotionRichText[]; color?: string; is_toggleable?: boolean };
  bulleted_list_item?: { rich_text: NotionRichText[]; color?: string };
  numbered_list_item?: { rich_text: NotionRichText[]; color?: string };
  to_do?: { rich_text: NotionRichText[]; checked: boolean; color?: string };
  toggle?: { rich_text: NotionRichText[]; color?: string };
  code?: { rich_text: NotionRichText[]; language: string; caption?: NotionRichText[] };
  quote?: { rich_text: NotionRichText[]; color?: string };
  callout?: { rich_text: NotionRichText[]; icon?: { type: string; emoji?: string }; color?: string };
  divider?: Record<string, never>;
  image?: { type: string; external?: { url: string }; file?: { url: string; expiry_time?: string }; caption?: NotionRichText[] };
  child_page?: { title: string };
  child_database?: { title: string };
  table?: { table_width: number; has_column_header: boolean; has_row_header: boolean };
  table_row?: { cells: NotionRichText[][] };
  embed?: { url: string; caption?: NotionRichText[] };
  bookmark?: { url: string; caption?: NotionRichText[] };
  link_preview?: { url: string };
  equation?: { expression: string };
  [key: string]: unknown;
}

export interface NotionBlockChildrenResponse {
  object: 'list';
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}
