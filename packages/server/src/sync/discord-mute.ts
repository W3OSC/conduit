/**
 * discord-mute.ts
 *
 * Pure, side-effect-free functions for computing Discord mute state from
 * guild settings objects. Extracted from DiscordSync so they can be unit-tested
 * without instantiating the selfbot client.
 *
 * The discord.js-selfbot-v13 library exposes per-guild mute settings via
 * a GuildSettingManager attached to each Guild as `guild.settings`.  The
 * manager is always instantiated (never undefined), but its fields are only
 * populated after the READY event patches them via `_patch(data)`.  Fields
 * that were not present in the READY payload remain `undefined`.
 *
 * Raw shape received from Discord API (stored verbatim in channelOverrides):
 *   channel_overrides: Array<{
 *     channel_id: string;
 *     muted: boolean;             — may be absent → undefined
 *     mute_config: {
 *       end_time: string | null;  — ISO-8601 or null for permanent mute
 *       selected_time_window: number;
 *     } | null;
 *   }>
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of GuildSettingManager properties we need for mute computation.
 * Mirrors what discord.js-selfbot-v13 exposes on `guild.settings`.
 */
export interface GuildMuteSettings {
  /** true when the whole server is muted; undefined if not yet patched */
  muted?: boolean;
  /**
   * Populated when muted === true.  null means permanent mute (no end time).
   * endTime is a Date when there IS a time-limited mute.
   */
  muteConfig?: { endTime?: Date | null; selectedTimeWindow?: number } | null;
  /**
   * Raw channel_overrides array from Discord API.  Only channels that have
   * user-specific overrides appear here — not every channel in the guild.
   */
  channelOverrides?: Array<{
    channel_id: string;
    muted?: boolean;
    mute_config?: { end_time?: string | null; selected_time_window?: number } | null;
  }>;
}

// ---------------------------------------------------------------------------
// Core pure functions
// ---------------------------------------------------------------------------

/**
 * Returns true if a timed mute described by an end_time string is still active.
 * `null` or missing end_time means permanent mute → always active.
 */
export function isTimedMuteActive(endTime: Date | null | undefined, now: number): boolean {
  if (endTime == null) return true; // permanent mute
  return endTime.getTime() > now;
}

/**
 * Returns true if the guild itself (server-level) is currently muted.
 */
export function isGuildMuted(settings: GuildMuteSettings, now: number): boolean {
  if (settings.muted !== true) return false;
  // muted === true — check whether a timed mute has expired
  const cfg = settings.muteConfig;
  if (cfg === null || cfg === undefined) return true; // permanent mute
  return isTimedMuteActive(cfg.endTime ?? null, now);
}

/**
 * Returns the explicit per-channel mute override, or undefined if there is
 * no override for this channel.
 *
 * An override entry with `muted === undefined` is for other settings (e.g.
 * message notification level) and must NOT affect the mute state.
 */
export function getChannelOverride(
  settings: GuildMuteSettings,
  channelId: string,
  now: number,
): boolean | undefined {
  for (const override of settings.channelOverrides ?? []) {
    if (override.channel_id !== channelId) continue;
    if (override.muted === undefined) return undefined; // not a mute override
    if (override.muted === false) return false; // explicitly unmuted
    // muted === true — check timed mute
    const endTimeStr = override.mute_config?.end_time;
    const endTime = endTimeStr ? new Date(endTimeStr) : null;
    return isTimedMuteActive(endTime, now);
  }
  return undefined; // no override for this channel
}

/**
 * Main entry point: returns true if the channel is muted, considering both
 * guild-level mute and any per-channel override.
 *
 * Rules (matches Discord client behaviour):
 *   1. Per-channel override wins — explicit muted:true or muted:false.
 *   2. If no override exists, fall back to guild-level mute.
 *   3. DM channels (no settings object) are never muted.
 *
 * @param settings  The GuildSettingManager (guild.settings) — or null/undefined
 *                  for DMs or guilds not in cache.
 * @param channelId The channel whose mute state to compute.
 * @param now       Current timestamp in ms (injectable for testing).
 */
export function computeChannelMuted(
  settings: GuildMuteSettings | null | undefined,
  channelId: string,
  now: number = Date.now(),
): boolean {
  if (!settings) return false; // DMs or guild not cached
  const override = getChannelOverride(settings, channelId, now);
  if (override !== undefined) return override;
  return isGuildMuted(settings, now);
}

/**
 * Build a full channelId→isMuted map for all text channels across all guilds.
 * Used by fetchUnreadCounts and the on-connect mute-state broadcast.
 *
 * @param guilds  Iterable of [guildId, guild] pairs from client.guilds.cache
 * @param now     Current timestamp in ms (injectable for testing)
 */
export function buildMutedChannelsMap(
  guilds: Iterable<[string, { channels: { cache: Map<string, { id: string; type: number }> }; settings?: GuildMuteSettings }]>,
  now: number = Date.now(),
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const [, guild] of guilds) {
    const settings = guild.settings;
    for (const [, channel] of guild.channels.cache) {
      if (channel.type !== 0) continue; // GUILD_TEXT only
      result.set(channel.id, computeChannelMuted(settings, channel.id, now));
    }
  }
  return result;
}
