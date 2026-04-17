import { create } from 'zustand';
import type { AiSession, AiMessage } from '../lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamingMessage {
  messageId: string;
  content: string;
  toolCalls?: Array<{ name: string; input: unknown; output?: unknown }>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AiChatStore {
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

  // Active streaming state per session
  streaming: Record<string, StreamingMessage | null>;
  startStream: (sessionId: string, messageId: string) => void;
  appendToken: (sessionId: string, messageId: string, delta: string, toolCalls?: StreamingMessage['toolCalls']) => void;
  finalizeStream: (sessionId: string, messageId: string) => void;

  // Error state per session
  errors: Record<string, string | null>;
  setError: (sessionId: string, error: string | null) => void;

  // Waiting-for-first-token state (shows thinking indicator)
  waiting: Record<string, boolean>;
  setWaiting: (sessionId: string, waiting: boolean) => void;
}

export const useAiChatStore = create<AiChatStore>((set) => ({
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
      // Drop any in-flight (streaming: true) rows coming from the REST snapshot —
      // those are owned by the ai:token WebSocket stream.  Merging them would
      // produce a blank duplicate bubble alongside the live streaming bubble.
      const settled = messages.filter((m) => !m.streaming);
      // Preserve any finalized messages that are already in the store but not
      // yet in the DB snapshot (e.g. just written by finalizeStream before the
      // query re-ran).
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
}));
