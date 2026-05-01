/**
 * Shared fine-grained permissions utilities used by both read and write routes.
 *
 * Fine-grained configs are stored as JSON in the `fine_grained_config` column on
 * the `permissions` (global/UI) and `api_key_permissions` (per-key override) tables.
 *
 * - UI actor: uses global permissions row only.
 * - API key actor: override ?? global (null stored override = "inherit from global").
 */

import { getDb } from '../db/client.js';
import { permissions, apiKeyPermissions } from '../db/schema.js';
import type {
  ServiceFineGrained,
  SlackFineGrained,
  DiscordFineGrained,
  TelegramFineGrained,
  GmailFineGrained,
  CalendarFineGrained,
  TwitterFineGrained,
  NotionFineGrained,
  ObsidianFineGrained,
  SmbFineGrained,
} from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

export type { ServiceFineGrained };

// ── Parse helpers ─────────────────────────────────────────────────────────────

export function parseFgConfig(raw: string | null | undefined): ServiceFineGrained | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as ServiceFineGrained; } catch { return null; }
}

// ── Resolution ────────────────────────────────────────────────────────────────

export function resolveEffectiveFineGrained(
  service: string,
  apiKeyId: number | null | undefined,
): ServiceFineGrained | null {
  const db = getDb();
  const global = db.select().from(permissions).where(eq(permissions.service, service)).get();
  const globalFg = parseFgConfig(global?.fineGrainedConfig);

  if (!apiKeyId) return globalFg; // UI actor

  const override = db.select().from(apiKeyPermissions)
    .where(and(eq(apiKeyPermissions.apiKeyId, apiKeyId), eq(apiKeyPermissions.service, service)))
    .get();
  if (!override) return globalFg;
  const overrideFg = parseFgConfig(override.fineGrainedConfig);
  return overrideFg ?? globalFg;
}

// ── Read enforcement ──────────────────────────────────────────────────────────

/**
 * Filter a list of chat/resource IDs to only those permitted for the actor.
 * An empty allowlist = unrestricted = all IDs pass.
 * Always returns all IDs for UI actors (apiKeyId = null/undefined).
 */
export function filterReadIds(
  service: string,
  ids: string[],
  apiKeyId: number | null | undefined,
): string[] {
  if (!apiKeyId) return ids; // UI actor — unrestricted

  const fg = resolveEffectiveFineGrained(service, apiKeyId);
  if (!fg) return ids;

  let allowList: string[] | undefined;

  switch (service) {
    case 'slack':
      allowList = (fg as SlackFineGrained).readChannelIds;
      break;
    case 'discord':
      // For Discord, messages are keyed by channelId. Check channel list first.
      allowList = (fg as DiscordFineGrained).readChannelIds;
      if (allowList && allowList.length > 0) {
        return ids.filter((id) => allowList!.includes(id));
      }
      // Fall through to guild-level filter
      allowList = (fg as DiscordFineGrained).readGuildIds;
      // Guild filtering is done separately via guildId; here just pass through
      return ids;
    case 'telegram':
      allowList = (fg as TelegramFineGrained).readChatIds;
      break;
    case 'gmail':
      // Gmail filter is label-based, not thread-based; handled separately
      return ids;
    case 'calendar':
      allowList = (fg as CalendarFineGrained).readCalendarIds;
      break;
    case 'twitter':
      // Twitter filtering is boolean-based (readDms), handled at the route level
      return ids;
    case 'notion':
      allowList = [
        ...((fg as NotionFineGrained).readDatabaseIds ?? []),
        ...((fg as NotionFineGrained).readPageIds ?? []),
      ];
      break;
    case 'obsidian': {
      // Obsidian filter is path-prefix based
      const readPaths = (fg as ObsidianFineGrained).readPaths;
      if (!readPaths || readPaths.length === 0) return ids;
      return ids.filter((id) => readPaths.some((prefix) => id.startsWith(prefix)));
    }
    case 'smb': {
      // SMB filter is path-prefix based; also honours the boolean readEnabled toggle
      const smbFg = fg as SmbFineGrained;
      if (smbFg.readEnabled === false) return []; // explicitly disabled
      const readPaths = smbFg.readPaths;
      if (!readPaths || readPaths.length === 0) return ids;
      return ids.filter((id) => readPaths.some((prefix) => id.startsWith(prefix)));
    }
    default:
      return ids;
  }

  if (!allowList || allowList.length === 0) return ids;
  return ids.filter((id) => allowList!.includes(id));
}

/**
 * Check if a single resource ID is readable by the actor.
 * Returns false only for API key actors with an explicit restrictive allowlist.
 */
export function isReadPermitted(
  service: string,
  resourceId: string,
  apiKeyId: number | null | undefined,
): boolean {
  const filtered = filterReadIds(service, [resourceId], apiKeyId);
  return filtered.length > 0;
}

/**
 * For Twitter: check if the actor can read DMs / timeline based on TwitterFineGrained.
 * Returns { readDms, readTimeline } — true when not restricted.
 */
export function resolveTwitterReadPerms(apiKeyId: number | null | undefined): {
  readDms: boolean;
  readTimeline: boolean;
} {
  if (!apiKeyId) return { readDms: true, readTimeline: true };
  const fg = resolveEffectiveFineGrained('twitter', apiKeyId) as TwitterFineGrained | null;
  return {
    readDms:      fg?.readDms      !== false,  // default true unless explicitly false
    readTimeline: fg?.readTimeline !== false,
  };
}

/**
 * For SMB: check if a path is readable/writable by the actor given SmbFineGrained config.
 * Returns false only when the actor has an explicit restrictive config.
 */
export function resolveSmbPathPermission(
  filePath: string,
  operation: 'read' | 'write',
  apiKeyId: number | null | undefined,
): boolean {
  if (!apiKeyId) return true; // UI actor — unrestricted
  const fg = resolveEffectiveFineGrained('smb', apiKeyId) as SmbFineGrained | null;
  if (!fg) return true;

  if (operation === 'read') {
    if (fg.readEnabled === false) return false;
    const readPaths = fg.readPaths;
    if (!readPaths || readPaths.length === 0) return true;
    return readPaths.some((prefix) => filePath.startsWith(prefix));
  } else {
    if (fg.writeEnabled === false) return false;
    const writePaths = fg.writePaths;
    if (!writePaths || writePaths.length === 0) return true;
    return writePaths.some((prefix) => filePath.startsWith(prefix));
  }
}

/**
 * For Gmail: filter messages to only those that include at least one label from the allowlist.
 * If no label allowlist is configured, all messages pass.
 * `messageLabelsFn` receives a message and returns its array of label IDs.
 */
export function filterGmailByLabels<T>(
  messages: T[],
  messageLabelsFn: (msg: T) => string[],
  apiKeyId: number | null | undefined,
): T[] {
  if (!apiKeyId) return messages;
  const fg = resolveEffectiveFineGrained('gmail', apiKeyId) as GmailFineGrained | null;
  const allowList = fg?.readLabelIds;
  if (!allowList || allowList.length === 0) return messages;
  return messages.filter((msg) => {
    const labels = messageLabelsFn(msg);
    return labels.some((l) => allowList.includes(l));
  });
}
