/**
 * discord-mute.test.ts
 *
 * Unit tests for the pure mute-computation functions in discord-mute.ts.
 * No Discord connection, no DB, no network — everything is tested with
 * plain mock objects that mirror the GuildSettingManager shape.
 */

import { describe, it, expect } from 'vitest';
import {
  computeChannelMuted,
  isGuildMuted,
  getChannelOverride,
  isTimedMuteActive,
  buildMutedChannelsMap,
  type GuildMuteSettings,
} from '../discord-mute.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed "now" for deterministic time tests
const FUTURE = new Date(NOW + 3_600_000); // 1 hour from now → active timed mute
const PAST   = new Date(NOW - 3_600_000); // 1 hour ago   → expired timed mute

function settings(overrides: Partial<GuildMuteSettings> = {}): GuildMuteSettings {
  return { channelOverrides: [], ...overrides };
}

// ---------------------------------------------------------------------------
// isTimedMuteActive
// ---------------------------------------------------------------------------

describe('isTimedMuteActive', () => {
  it('null endTime = permanent mute, always active', () => {
    expect(isTimedMuteActive(null, NOW)).toBe(true);
  });

  it('undefined endTime = permanent mute, always active', () => {
    expect(isTimedMuteActive(undefined, NOW)).toBe(true);
  });

  it('future endTime = timed mute still active', () => {
    expect(isTimedMuteActive(FUTURE, NOW)).toBe(true);
  });

  it('past endTime = timed mute expired, NOT active', () => {
    expect(isTimedMuteActive(PAST, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isGuildMuted
// ---------------------------------------------------------------------------

describe('isGuildMuted', () => {
  it('muted: undefined → not muted (settings not yet patched)', () => {
    expect(isGuildMuted(settings({ muted: undefined }), NOW)).toBe(false);
  });

  it('muted: false → not muted', () => {
    expect(isGuildMuted(settings({ muted: false }), NOW)).toBe(false);
  });

  it('muted: true, muteConfig: null → permanently muted', () => {
    expect(isGuildMuted(settings({ muted: true, muteConfig: null }), NOW)).toBe(true);
  });

  it('muted: true, muteConfig: undefined → permanently muted', () => {
    expect(isGuildMuted(settings({ muted: true, muteConfig: undefined }), NOW)).toBe(true);
  });

  it('muted: true, muteConfig with no endTime → permanently muted', () => {
    expect(isGuildMuted(settings({ muted: true, muteConfig: {} }), NOW)).toBe(true);
  });

  it('muted: true, muteConfig.endTime in future → still muted', () => {
    expect(isGuildMuted(settings({ muted: true, muteConfig: { endTime: FUTURE } }), NOW)).toBe(true);
  });

  it('muted: true, muteConfig.endTime in past → mute expired, NOT muted', () => {
    expect(isGuildMuted(settings({ muted: true, muteConfig: { endTime: PAST } }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getChannelOverride
// ---------------------------------------------------------------------------

describe('getChannelOverride', () => {
  it('no channelOverrides array → undefined (no override)', () => {
    expect(getChannelOverride(settings({ channelOverrides: undefined }), 'ch1', NOW)).toBeUndefined();
  });

  it('empty channelOverrides → undefined', () => {
    expect(getChannelOverride(settings({ channelOverrides: [] }), 'ch1', NOW)).toBeUndefined();
  });

  it('override for a different channel → undefined', () => {
    const s = settings({ channelOverrides: [{ channel_id: 'ch2', muted: true }] });
    expect(getChannelOverride(s, 'ch1', NOW)).toBeUndefined();
  });

  it('override with muted: undefined → undefined (not a mute override)', () => {
    // Discord sends overrides with muted: undefined for notification-level settings
    const s = settings({ channelOverrides: [{ channel_id: 'ch1', muted: undefined }] });
    expect(getChannelOverride(s, 'ch1', NOW)).toBeUndefined();
  });

  it('override with muted: true, no mute_config → permanently muted', () => {
    const s = settings({ channelOverrides: [{ channel_id: 'ch1', muted: true }] });
    expect(getChannelOverride(s, 'ch1', NOW)).toBe(true);
  });

  it('override with muted: true, mute_config null → permanently muted', () => {
    const s = settings({ channelOverrides: [{ channel_id: 'ch1', muted: true, mute_config: null }] });
    expect(getChannelOverride(s, 'ch1', NOW)).toBe(true);
  });

  it('override with muted: true, future end_time → still muted', () => {
    const s = settings({ channelOverrides: [{ channel_id: 'ch1', muted: true, mute_config: { end_time: FUTURE.toISOString() } }] });
    expect(getChannelOverride(s, 'ch1', NOW)).toBe(true);
  });

  it('override with muted: true, past end_time → timed mute expired, false', () => {
    const s = settings({ channelOverrides: [{ channel_id: 'ch1', muted: true, mute_config: { end_time: PAST.toISOString() } }] });
    expect(getChannelOverride(s, 'ch1', NOW)).toBe(false);
  });

  it('override with muted: false → explicitly unmuted', () => {
    const s = settings({ channelOverrides: [{ channel_id: 'ch1', muted: false }] });
    expect(getChannelOverride(s, 'ch1', NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeChannelMuted — integration of guild + channel logic
// ---------------------------------------------------------------------------

describe('computeChannelMuted', () => {
  it('null settings (DM) → never muted', () => {
    expect(computeChannelMuted(null, 'ch1', NOW)).toBe(false);
  });

  it('undefined settings (guild not cached) → never muted', () => {
    expect(computeChannelMuted(undefined, 'ch1', NOW)).toBe(false);
  });

  it('guild NOT muted, no channel override → not muted', () => {
    expect(computeChannelMuted(settings({ muted: false }), 'ch1', NOW)).toBe(false);
  });

  it('guild NOT muted (undefined), no channel override → not muted', () => {
    // This is the "settings not yet patched" scenario — must default to false
    expect(computeChannelMuted(settings({ muted: undefined }), 'ch1', NOW)).toBe(false);
  });

  it('guild muted, no channel override → channel is muted', () => {
    expect(computeChannelMuted(settings({ muted: true, muteConfig: null }), 'ch1', NOW)).toBe(true);
  });

  it('guild muted, channel override muted: false → channel is unmuted (override wins)', () => {
    const s = settings({
      muted: true,
      muteConfig: null,
      channelOverrides: [{ channel_id: 'ch1', muted: false }],
    });
    expect(computeChannelMuted(s, 'ch1', NOW)).toBe(false);
  });

  it('guild NOT muted, channel override muted: true → channel IS muted (override wins)', () => {
    const s = settings({
      muted: false,
      channelOverrides: [{ channel_id: 'ch1', muted: true }],
    });
    expect(computeChannelMuted(s, 'ch1', NOW)).toBe(true);
  });

  it('guild muted, channel override with muted: undefined → falls through to guild mute', () => {
    // Override is for a non-mute setting (e.g. notification level), must not override mute
    const s = settings({
      muted: true,
      muteConfig: null,
      channelOverrides: [{ channel_id: 'ch1', muted: undefined }],
    });
    expect(computeChannelMuted(s, 'ch1', NOW)).toBe(true);
  });

  it('guild muted with expired timed mute → not muted', () => {
    expect(computeChannelMuted(settings({ muted: true, muteConfig: { endTime: PAST } }), 'ch1', NOW)).toBe(false);
  });

  it('guild muted with active timed mute → muted', () => {
    expect(computeChannelMuted(settings({ muted: true, muteConfig: { endTime: FUTURE } }), 'ch1', NOW)).toBe(true);
  });

  it('different channel in override → falls through to guild mute', () => {
    const s = settings({
      muted: true,
      muteConfig: null,
      channelOverrides: [{ channel_id: 'ch2', muted: false }],
    });
    // ch1 has no override, guild is muted
    expect(computeChannelMuted(s, 'ch1', NOW)).toBe(true);
    // ch2 has explicit unmute override
    expect(computeChannelMuted(s, 'ch2', NOW)).toBe(false);
  });

  it('channel override with expired timed mute → override resolves to false, channel unmuted', () => {
    const s = settings({
      muted: true,
      muteConfig: null,
      channelOverrides: [{ channel_id: 'ch1', muted: true, mute_config: { end_time: PAST.toISOString() } }],
    });
    expect(computeChannelMuted(s, 'ch1', NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildMutedChannelsMap
// ---------------------------------------------------------------------------

describe('buildMutedChannelsMap', () => {
  it('empty guilds → empty map', () => {
    expect(buildMutedChannelsMap([], NOW).size).toBe(0);
  });

  it('guild with muted:true — all text channels appear as muted', () => {
    const guild = {
      settings: settings({ muted: true, muteConfig: null }),
      channels: {
        cache: new Map([
          ['ch1', { id: 'ch1', type: 0 }],
          ['ch2', { id: 'ch2', type: 0 }],
          ['voice1', { id: 'voice1', type: 2 }], // voice — should be skipped
        ]),
      },
    };
    const map = buildMutedChannelsMap([['g1', guild]], NOW);
    expect(map.get('ch1')).toBe(true);
    expect(map.get('ch2')).toBe(true);
    expect(map.has('voice1')).toBe(false); // voice channels excluded
  });

  it('guild with muted:true but one channel override unmuting it', () => {
    const guild = {
      settings: settings({
        muted: true,
        muteConfig: null,
        channelOverrides: [{ channel_id: 'ch2', muted: false }],
      }),
      channels: {
        cache: new Map([
          ['ch1', { id: 'ch1', type: 0 }],
          ['ch2', { id: 'ch2', type: 0 }],
        ]),
      },
    };
    const map = buildMutedChannelsMap([['g1', guild]], NOW);
    expect(map.get('ch1')).toBe(true);
    expect(map.get('ch2')).toBe(false);
  });

  it('guild with muted:undefined (unpatched) — all channels unmuted', () => {
    // Critical: this must NOT mark channels as muted just because settings were not patched
    const guild = {
      settings: settings({ muted: undefined }),
      channels: {
        cache: new Map([
          ['ch1', { id: 'ch1', type: 0 }],
        ]),
      },
    };
    const map = buildMutedChannelsMap([['g1', guild]], NOW);
    expect(map.get('ch1')).toBe(false);
  });

  it('guild with no settings property — channels treated as unmuted', () => {
    const guild = {
      // settings is explicitly absent
      channels: {
        cache: new Map([
          ['ch1', { id: 'ch1', type: 0 }],
        ]),
      },
    };
    const map = buildMutedChannelsMap([['g1', guild as never]], NOW);
    expect(map.get('ch1')).toBe(false);
  });

  it('multiple guilds — maps merged correctly', () => {
    const guilds: Array<[string, { channels: { cache: Map<string, { id: string; type: number }> }; settings?: GuildMuteSettings }]> = [
      ['g1', {
        settings: settings({ muted: true, muteConfig: null }),
        channels: { cache: new Map([['ch1', { id: 'ch1', type: 0 }]]) },
      }],
      ['g2', {
        settings: settings({ muted: false }),
        channels: { cache: new Map([['ch2', { id: 'ch2', type: 0 }]]) },
      }],
    ];
    const map = buildMutedChannelsMap(guilds, NOW);
    expect(map.get('ch1')).toBe(true);
    expect(map.get('ch2')).toBe(false);
  });
});
