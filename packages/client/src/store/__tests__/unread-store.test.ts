/**
 * unread-store.test.ts
 *
 * Tests for the server-authoritative UnreadStore logic.
 *
 * Architecture: the server is the sole source of truth. The store is a
 * read-through cache seeded by GET /api/unread on mount and updated by
 * unread:update WS pushes after every new message / mark-read / mute change.
 *
 * There is no client-side counting, no localStorage, no increment() action.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Pure replica of the UnreadStore state machine ────────────────────────────
// We test the algorithm as pure functions (same logic as the Zustand store)
// to avoid the localStorage / React dependency in a Node test environment.

interface StoreState {
  unreadCounts: Record<string, number>;
  mutedChats:   Record<string, boolean>;
}

interface UnreadEntry {
  source: string; chatId: string; count: number; isMuted: boolean;
}

function makeStore(): StoreState {
  return { unreadCounts: {}, mutedChats: {} };
}

/** Replace entire state with authoritative snapshot (GET /api/unread response). */
function setFromServer(state: StoreState, entries: UnreadEntry[]): StoreState {
  const nextCounts: Record<string, number> = {};
  const nextMuted:  Record<string, boolean> = {};
  for (const { source, chatId, count, isMuted } of entries) {
    const key = `${source}:${chatId}`;
    nextCounts[key] = count;
    nextMuted[key]  = isMuted;
  }
  return { unreadCounts: nextCounts, mutedChats: nextMuted };
}

/** Apply a partial push from an unread:update WS event. */
function applyUpdate(
  state: StoreState,
  entries: Array<{ source: string; chatId: string; count: number; isMuted?: boolean }>,
): StoreState {
  const nextCounts = { ...state.unreadCounts };
  const nextMuted  = { ...state.mutedChats };
  for (const { source, chatId, count, isMuted } of entries) {
    const key = `${source}:${chatId}`;
    nextCounts[key] = count;
    if (isMuted !== undefined) nextMuted[key] = isMuted;
  }
  return { unreadCounts: nextCounts, mutedChats: nextMuted };
}

/** Optimistic local zero when user opens a chat. */
function markReadOptimistic(state: StoreState, source: string, chatId: string): StoreState {
  const key = `${source}:${chatId}`;
  return { ...state, unreadCounts: { ...state.unreadCounts, [key]: 0 } };
}

function getIsMuted(state: StoreState, source: string, chatId: string): boolean {
  return state.mutedChats[`${source}:${chatId}`] ?? false;
}

function getTotalUnread(state: StoreState): number {
  return Object.entries(state.unreadCounts).reduce(
    (total, [key, count]) => total + (state.mutedChats[key] ? 0 : count),
    0,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('setFromServer — initial load from GET /api/unread', () => {
  it('populates counts and mute state from server snapshot', () => {
    const state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 5, isMuted: false },
      { source: 'discord', chatId: 'ch2', count: 3, isMuted: true },
      { source: 'slack',   chatId: 'sl1', count: 0, isMuted: false },
    ]);
    expect(state.unreadCounts['discord:ch1']).toBe(5);
    expect(state.unreadCounts['discord:ch2']).toBe(3);
    expect(state.unreadCounts['slack:sl1']).toBe(0);
    expect(state.mutedChats['discord:ch1']).toBe(false);
    expect(state.mutedChats['discord:ch2']).toBe(true);
  });

  it('replaces any previous state entirely', () => {
    let state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'old', count: 99, isMuted: false },
    ]);
    state = setFromServer(state, [
      { source: 'discord', chatId: 'new', count: 1, isMuted: false },
    ]);
    // Old key is gone
    expect(state.unreadCounts['discord:old']).toBeUndefined();
    expect(state.unreadCounts['discord:new']).toBe(1);
  });

  it('empty server response → empty store', () => {
    const state = setFromServer(makeStore(), []);
    expect(Object.keys(state.unreadCounts).length).toBe(0);
    expect(Object.keys(state.mutedChats).length).toBe(0);
  });
});

describe('applyUpdate — unread:update WS push after new message', () => {
  let state: StoreState;
  beforeEach(() => {
    state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 0, isMuted: false },
    ]);
  });

  it('sets the new count (server-computed, authoritative)', () => {
    state = applyUpdate(state, [{ source: 'discord', chatId: 'ch1', count: 3 }]);
    expect(state.unreadCounts['discord:ch1']).toBe(3);
  });

  it('updates mute state when included', () => {
    state = applyUpdate(state, [{ source: 'discord', chatId: 'ch1', count: 0, isMuted: true }]);
    expect(getIsMuted(state, 'discord', 'ch1')).toBe(true);
  });

  it('does NOT change mute state when isMuted is omitted', () => {
    state = applyUpdate(state, [{ source: 'discord', chatId: 'ch1', count: 0, isMuted: false }]);
    state = applyUpdate(state, [{ source: 'discord', chatId: 'ch1', count: 5 }]); // no isMuted
    expect(getIsMuted(state, 'discord', 'ch1')).toBe(false); // unchanged
  });

  it('can create new chats not previously in state', () => {
    state = applyUpdate(state, [{ source: 'discord', chatId: 'new-ch', count: 7, isMuted: false }]);
    expect(state.unreadCounts['discord:new-ch']).toBe(7);
  });
});

describe('getTotalUnread — sidebar badge total', () => {
  it('sums only unmuted chats', () => {
    const state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 5, isMuted: false },
      { source: 'discord', chatId: 'ch2', count: 3, isMuted: true },  // muted — excluded
      { source: 'slack',   chatId: 'sl1', count: 2, isMuted: false },
    ]);
    expect(getTotalUnread(state)).toBe(7); // 5 + 2
  });

  it('empty store → 0', () => {
    expect(getTotalUnread(makeStore())).toBe(0);
  });

  it('all muted → 0', () => {
    const state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 10, isMuted: true },
      { source: 'discord', chatId: 'ch2', count: 5,  isMuted: true },
    ]);
    expect(getTotalUnread(state)).toBe(0);
  });
});

describe('markReadOptimistic — instant badge clear on chat open', () => {
  it('zeroes the count for the chat', () => {
    let state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 8, isMuted: false },
    ]);
    state = markReadOptimistic(state, 'discord', 'ch1');
    expect(state.unreadCounts['discord:ch1']).toBe(0);
    expect(getTotalUnread(state)).toBe(0);
  });

  it('does not affect mute state', () => {
    let state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 3, isMuted: true },
    ]);
    state = markReadOptimistic(state, 'discord', 'ch1');
    expect(getIsMuted(state, 'discord', 'ch1')).toBe(true);
  });

  it('server confirms via applyUpdate after optimistic zero', () => {
    let state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 5, isMuted: false },
    ]);
    // Optimistic: zero immediately on open
    state = markReadOptimistic(state, 'discord', 'ch1');
    expect(state.unreadCounts['discord:ch1']).toBe(0);
    // Server confirms: pushes count:0 via unread:update
    state = applyUpdate(state, [{ source: 'discord', chatId: 'ch1', count: 0, isMuted: false }]);
    expect(state.unreadCounts['discord:ch1']).toBe(0);
  });
});

describe('page reload / reconnect scenario', () => {
  it('setFromServer called with real counts restores full state', () => {
    // Simulate a page reload: store starts empty
    let state = makeStore();
    expect(getTotalUnread(state)).toBe(0);

    // Client calls GET /api/unread — server returns real computed counts
    state = setFromServer(state, [
      { source: 'discord', chatId: 'ch1', count: 12, isMuted: false },
      { source: 'discord', chatId: 'ch2', count: 7,  isMuted: true  },
      { source: 'slack',   chatId: 'sl1', count: 3,  isMuted: false },
    ]);

    expect(getTotalUnread(state)).toBe(15); // 12 + 3 (ch2 muted)
    expect(getIsMuted(state, 'discord', 'ch2')).toBe(true);
  });

  it('muted channel with messages does NOT contribute to total', () => {
    const state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'muted-server-ch', count: 50, isMuted: true },
    ]);
    expect(getTotalUnread(state)).toBe(0);
  });
});

describe('mute state accuracy', () => {
  it('previously muted chat can be unmuted via applyUpdate', () => {
    let state = setFromServer(makeStore(), [
      { source: 'discord', chatId: 'ch1', count: 5, isMuted: true },
    ]);
    expect(getTotalUnread(state)).toBe(0);

    // User unmutes server — userGuildSettingsUpdate fires, server re-broadcasts
    state = applyUpdate(state, [{ source: 'discord', chatId: 'ch1', count: 5, isMuted: false }]);
    expect(getTotalUnread(state)).toBe(5);
  });

  it('getIsMuted returns false for unknown chats (safe default)', () => {
    expect(getIsMuted(makeStore(), 'discord', 'unknown')).toBe(false);
  });
});
