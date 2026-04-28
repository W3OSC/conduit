import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AiSession, AiMessage } from '../lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamingMessage {
  messageId: string;
  content: string;
  toolCalls?: Array<{ name: string; input: unknown; output?: unknown }>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AiChatStore {
  // Active session tab
  activeId: string | null;
  setActiveId: (id: string | null) => void;

  // Session list
  sessions: AiSession[];
  setSessions: (sessions: AiSession[]) => void;
  addSession: (session: AiSession) => void;
  updateSession: (id: string, updates: Partial<AiSession>) => void;
  removeSession: (id: string) => void;

  // Messages per session (keyed by sessionId)
  messages: Record<string, AiMessage[]>;
  setMessages: (sessionId: string, messages: AiMessage[]) => void;
  addMessage: (sessionId: string, message: AiMessage) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<AiMessage>) => void;
  replaceOptimisticMessage: (sessionId: string, message: AiMessage) => void;
  /**
   * Reconcile the store against a fresh DB snapshot.
   *
   * Called after every re-fetch (including post-reconnect re-fetches).  It
   * detects two recovery scenarios:
   *
   * 1. The DB has a message that is no longer streaming (streaming: false) but
   *    the client store still has an active WS-level stream for it.  This
   *    happens when the browser missed the final `done: true` ai:token event.
   *    → finalizeStream is called with the DB content so the bubble is filled.
   *
   * 2. The DB has a message that is marked streaming: true (the AI is still
   *    mid-stream) but there is no active WS stream in the store.  This means
   *    the client reconnected mid-stream and is missing partial content.
   *    → The in-progress DB row is shown as-is so the user can at least see
   *      what arrived, and finalizeStream will be called when the done token
   *      eventually arrives (or on the next re-fetch once it finishes).
   */
  reconcileFromDb: (sessionId: string, dbMessages: AiMessage[]) => void;

  // Active streaming state per session (transient — not persisted)
  streaming: Record<string, StreamingMessage | null>;
  startStream: (sessionId: string, messageId: string) => void;
  appendToken: (sessionId: string, messageId: string, delta: string, toolCalls?: StreamingMessage['toolCalls']) => void;
  finalizeStream: (sessionId: string, messageId: string) => void;

  // Error state per session (transient — not persisted)
  errors: Record<string, string | null>;
  setError: (sessionId: string, error: string | null) => void;

  // Waiting-for-first-token state (transient — not persisted)
  waiting: Record<string, boolean>;
  setWaiting: (sessionId: string, waiting: boolean) => void;
}

export const useAiChatStore = create<AiChatStore>()(
  persist(
    (set, get) => ({
      activeId: null,
      setActiveId: (id) => set({ activeId: id }),

      sessions: [],
      setSessions: (sessions) => set({ sessions }),
      addSession: (session) =>
        set((s) => ({ sessions: [session, ...s.sessions] })),
      updateSession: (id, updates) =>
        set((s) => ({
          sessions: s.sessions.map((sess) => (sess.id === id ? { ...sess, ...updates } : sess)),
        })),
      removeSession: (id) =>
        set((s) => {
          const { [id]: _msgs, ...restMessages } = s.messages;
          const { [id]: _stream, ...restStreaming } = s.streaming;
          const { [id]: _err, ...restErrors } = s.errors;
          const { [id]: _wait, ...restWaiting } = s.waiting;
          return {
            activeId: s.activeId === id ? (s.sessions.find((sess) => sess.id !== id)?.id ?? null) : s.activeId,
            sessions: s.sessions.filter((sess) => sess.id !== id),
            messages: restMessages,
            streaming: restStreaming,
            errors: restErrors,
            waiting: restWaiting,
          };
        }),

      messages: {},
      setMessages: (sessionId, messages) =>
        set((s) => {
          const hasActiveWsStream = s.streaming[sessionId] != null;

          // Only drop in-flight (streaming: true) DB rows when there is an
          // active WS stream for this session.  Those rows are owned by the
          // ai:token stream and merging them would produce a blank duplicate
          // bubble alongside the live streaming bubble.
          //
          // When there is NO active WS stream (e.g. after a reconnect where we
          // missed the done token), keep the DB row so the user can see the
          // partial or complete content that the server already has.
          const settled = hasActiveWsStream
            ? messages.filter((m) => !m.streaming)
            : messages;

          // Preserve any finalized messages that are already in the store but
          // not yet in the DB snapshot (e.g. just written by finalizeStream
          // before the query re-ran).
          const current = s.messages[sessionId] ?? [];
          const incomingIds = new Set(settled.map((m) => m.id));
          const localOnly = current.filter((m) => !m.streaming && !incomingIds.has(m.id));
          return { messages: { ...s.messages, [sessionId]: [...settled, ...localOnly] } };
        }),

      addMessage: (sessionId, message) =>
        set((s) => ({
          messages: {
            ...s.messages,
            [sessionId]: [...(s.messages[sessionId] || []), message],
          },
        })),
      updateMessage: (sessionId, messageId, updates) =>
        set((s) => ({
          messages: {
            ...s.messages,
            [sessionId]: (s.messages[sessionId] || []).map((m) =>
              m.id === messageId ? { ...m, ...updates } : m,
            ),
          },
        })),
      replaceOptimisticMessage: (sessionId, message) =>
        set((s) => {
          const existing = s.messages[sessionId] || [];
          // If the real message is already present, just remove any optimistic entry
          if (existing.some((m) => m.id === message.id)) {
            return {
              messages: {
                ...s.messages,
                [sessionId]: existing.filter((m) => !m.id.startsWith('opt-')),
              },
            };
          }
          // Replace the optimistic entry with the confirmed message
          const hasOptimistic = existing.some((m) => m.id.startsWith('opt-'));
          if (hasOptimistic) {
            return {
              messages: {
                ...s.messages,
                [sessionId]: existing.map((m) => (m.id.startsWith('opt-') ? message : m)),
              },
            };
          }
          // No optimistic entry — just append (fallback)
          return {
            messages: {
              ...s.messages,
              [sessionId]: [...existing, message],
            },
          };
        }),

      reconcileFromDb: (sessionId, dbMessages) => {
        const s = get();
        const activeStream = s.streaming[sessionId];

        for (const dbMsg of dbMessages) {
          if (dbMsg.role !== 'assistant') continue;

          // Case 1: DB says the message is finished but we still have an active
          // WS stream for it — we missed the done token.  Finalize from DB.
          if (!dbMsg.streaming && activeStream && activeStream.messageId === dbMsg.id) {
            set((state) => {
              const existingMessages = state.messages[sessionId] || [];
              const alreadyExists = existingMessages.some((m) => m.id === dbMsg.id);
              const updatedMessages = alreadyExists
                ? existingMessages.map((m) =>
                    m.id === dbMsg.id
                      ? { ...m, content: dbMsg.content, toolCalls: dbMsg.toolCalls, streaming: false }
                      : m,
                  )
                : [...existingMessages, { ...dbMsg, streaming: false }];
              return {
                messages: { ...state.messages, [sessionId]: updatedMessages },
                streaming: { ...state.streaming, [sessionId]: null },
                waiting: { ...state.waiting, [sessionId]: false },
              };
            });
            return; // handled — only one stream can be active per session
          }

          // Case 2: DB has a finished message that the store doesn't know about
          // at all (all WS tokens were missed entirely).
          if (!dbMsg.streaming && !activeStream) {
            const current = get().messages[sessionId] || [];
            if (!current.some((m) => m.id === dbMsg.id)) {
              set((state) => ({
                messages: {
                  ...state.messages,
                  [sessionId]: [...(state.messages[sessionId] || []), { ...dbMsg, streaming: false }],
                },
                waiting: { ...state.waiting, [sessionId]: false },
              }));
            }
          }
        }
      },

      streaming: {},
      startStream: (sessionId, messageId) =>
        set((s) => ({
          streaming: { ...s.streaming, [sessionId]: { messageId, content: '' } },
          waiting: { ...s.waiting, [sessionId]: false },
        })),
      appendToken: (sessionId, messageId, delta, toolCalls) =>
        set((s) => {
          const current = s.streaming[sessionId];
          if (!current || current.messageId !== messageId) {
            // First token for a new message
            return {
              streaming: {
                ...s.streaming,
                [sessionId]: { messageId, content: delta, toolCalls },
              },
              waiting: { ...s.waiting, [sessionId]: false },
            };
          }
          return {
            streaming: {
              ...s.streaming,
              [sessionId]: {
                messageId,
                content: current.content + delta,
                toolCalls: toolCalls ?? current.toolCalls,
              },
            },
          };
        }),
      finalizeStream: (sessionId, messageId) => {
        set((s) => {
          // Read streaming state from within the setter so we always see the
          // latest value, even if appendToken() was called just before us.
          const stream = s.streaming[sessionId];
          // Persist the streamed content into the messages array
          const finalContent = stream?.content ?? '';
          const finalToolCalls = stream?.toolCalls;
          const existingMessages = s.messages[sessionId] || [];
          const alreadyExists = existingMessages.some((m) => m.id === messageId);

          const updatedMessages = alreadyExists
            ? existingMessages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      content: finalContent,
                      toolCalls: finalToolCalls ? JSON.stringify(finalToolCalls) : m.toolCalls,
                      streaming: false,
                    }
                  : m,
              )
            : [
                ...existingMessages,
                {
                  id: messageId,
                  sessionId,
                  role: 'assistant' as const,
                  content: finalContent,
                  toolCalls: finalToolCalls ? JSON.stringify(finalToolCalls) : null,
                  streaming: false,
                  createdAt: new Date().toISOString(),
                },
              ];

          return {
            messages: { ...s.messages, [sessionId]: updatedMessages },
            streaming: { ...s.streaming, [sessionId]: null },
            waiting: { ...s.waiting, [sessionId]: false },
          };
        });
      },

      errors: {},
      setError: (sessionId, error) =>
        set((s) => ({ errors: { ...s.errors, [sessionId]: error } })),

      waiting: {},
      setWaiting: (sessionId, waiting) =>
        set((s) => ({ waiting: { ...s.waiting, [sessionId]: waiting } })),
    }),
    {
      name: 'conduit-ai-chat',
      storage: createJSONStorage(() => localStorage),
      // Only persist the data that is meaningful to restore across reloads.
      // Transient UI state (streaming, errors, waiting) is intentionally excluded.
      partialize: (s) => ({
        activeId: s.activeId,
        sessions: s.sessions,
        messages: s.messages,
      }),
    },
  ),
);
