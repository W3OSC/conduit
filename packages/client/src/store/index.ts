import { create } from 'zustand';
import type { ConnectionStatus, OutboxItem, Message, ActiveSyncRun, UpdateStatus } from '../lib/api';

export { useAiChatStore } from './aiChat';
export type { StreamingMessage } from './aiChat';

export { useThemeStore } from './theme';
export type { ColorMode, PrimaryColor, FontSize, BorderRadius, ThemeSettings } from './theme';

// ── Connection Store ──────────────────────────────────────────────────────────

interface ConnectionStore {
  statuses: Record<string, ConnectionStatus>;
  setStatus: (service: string, status: ConnectionStatus) => void;
  setAllStatuses: (statuses: Record<string, ConnectionStatus>) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  statuses: {
    slack: { status: 'disconnected' },
    discord: { status: 'disconnected' },
    telegram: { status: 'disconnected' },
    obsidian: { status: 'disconnected' },
  },
  setStatus: (service, status) =>
    set((s) => ({ statuses: { ...s.statuses, [service]: status } })),
  setAllStatuses: (statuses) => set({ statuses }),
}));

// ── Outbox Store ──────────────────────────────────────────────────────────────

interface OutboxStore {
  pendingCount: number;
  recentItems: OutboxItem[];
  setPendingCount: (n: number) => void;
  addItem: (item: OutboxItem) => void;
  updateItem: (id: number, updates: Partial<OutboxItem>) => void;
}

export const useOutboxStore = create<OutboxStore>((set) => ({
  pendingCount: 0,
  recentItems: [],
  setPendingCount: (pendingCount) => set({ pendingCount }),
  addItem: (item) =>
    set((s) => ({
      recentItems: [item, ...s.recentItems].slice(0, 20),
      pendingCount: item.status === 'pending' ? s.pendingCount + 1 : s.pendingCount,
    })),
  updateItem: (id, updates) =>
    set((s) => ({
      recentItems: s.recentItems.map((i) => (i.id === id ? { ...i, ...updates } : i)),
      pendingCount:
        updates.status && updates.status !== 'pending'
          ? Math.max(0, s.pendingCount - 1)
          : s.pendingCount,
    })),
}));

// ── Sync Store ─────────────────────────────────────────────────────────────────

export interface SyncProgress {
  service: string;
  status: 'running' | 'success' | 'error' | 'idle';
  type?: string;
  messagesSaved?: number;
  chatsVisited?: number;
  error?: string;
  startedAt?: string;
  runId?: number;
}

interface SyncStore {
  progress: Record<string, SyncProgress>;
  setProgress: (service: string, progress: SyncProgress) => void;
  seedFromActiveSyncs: (activeSyncs: Record<string, ActiveSyncRun>) => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  progress: {},
  setProgress: (service, progress) =>
    set((s) => ({ progress: { ...s.progress, [service]: progress } })),
  seedFromActiveSyncs: (activeSyncs) =>
    set((s) => {
      const next = { ...s.progress };
      for (const [service, run] of Object.entries(activeSyncs)) {
        const existing = next[service];
        if (!existing || existing.status !== 'running') {
          next[service] = {
            service,
            status: 'running',
            type: run.syncType,
            messagesSaved: run.messagesSaved,
            chatsVisited: run.chatsVisited,
            startedAt: run.startedAt,
            runId: run.id,
          };
        }
      }
      return { progress: next };
    }),
}));

// ── Message Stream Store ──────────────────────────────────────────────────────

interface MessageStreamStore {
  recentMessages: Message[];
  addMessage: (msg: Message) => void;
  clearMessages: () => void;
}

export const useMessageStreamStore = create<MessageStreamStore>((set) => ({
  recentMessages: [],
  addMessage: (msg) =>
    set((s) => ({
      recentMessages: [msg, ...s.recentMessages].slice(0, 100),
    })),
  clearMessages: () => set({ recentMessages: [] }),
}));

// ── Toast Store ───────────────────────────────────────────────────────────────

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'destructive' | 'success';
}

interface ToastStore {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(t: Omit<Toast, 'id'>) {
  useToastStore.getState().addToast(t);
}

// ── Notification Store ────────────────────────────────────────────────────────
// Stores recent notifications for display in the notification center.
// Notifications are generated client-side from WS events (message:new,
// email:new, calendar:updated, outbox:updated) and shown in the UI.

export type NotificationType = 'message' | 'email' | 'calendar' | 'outbox';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  source?: string;       // 'discord' | 'slack' | 'telegram' etc.
  chatId?: string;       // for navigating to the chat on click
  timestamp: string;     // ISO-8601
  read: boolean;
}

interface NotificationStore {
  notifications: AppNotification[];
  unreadCount: number;
  add: (n: Omit<AppNotification, 'id' | 'read'>) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,

  add: (n) => {
    const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const notification: AppNotification = { ...n, id, read: false };
    set((s) => ({
      notifications: [notification, ...s.notifications].slice(0, 100),
      unreadCount: s.unreadCount + 1,
    }));
    return id;
  },

  markAllRead: () => {
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }));
  },

  dismiss: (id) => {
    set((s) => {
      const n = s.notifications.find((x) => x.id === id);
      return {
        notifications: s.notifications.filter((x) => x.id !== id),
        unreadCount: n && !n.read ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
      };
    });
  },

  clear: () => set({ notifications: [], unreadCount: 0 }),
}));

// ── Update Store ──────────────────────────────────────────────────────────────
// Tracks whether a new version of Conduit is available upstream.
// Seeded by GET /api/update/status on sidebar mount and kept live via
// the update:available WebSocket event pushed by the background poller.

interface UpdateStore {
  version: string;
  hasUpdate: boolean;
  commitsBehind: number;
  latestCommitSha: string;
  isDocker: boolean;
  set: (status: Partial<UpdateStatus>) => void;
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  version: '',
  hasUpdate: false,
  commitsBehind: 0,
  latestCommitSha: '',
  isDocker: false,
  set: (status) => set((s) => ({ ...s, ...status })),
}));
