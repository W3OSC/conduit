import { Router } from 'express';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { getDb } from '../db/client.js';
import { outbox, permissions, apiKeyPermissions, aiToolCalls } from '../db/schema.js';
import type {
  SlackFineGrained, DiscordFineGrained, TelegramFineGrained,
  GmailFineGrained, CalendarFineGrained, NotionFineGrained, ObsidianFineGrained, SmbFineGrained, GdriveFineGrained,
  ServiceFineGrained,
} from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { isSendEnabled, isApprovalRequired } from './permissions-utils.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import { fuzzyFind, type FuzzyMatchInfo } from '../util/fuzzy-search.js';
import type { Request } from 'express';
import {
  z, intParam, optionalEnum, paginationSchema, requiredString, SERVICE_SOURCES,
  bodyOf, paramsOf, queryOf, validateBody, validateParams, validateQuery,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';

const router = Router();

// ── Request schemas ───────────────────────────────────────────────────────────

const OUTBOX_STATUSES = ['pending', 'approved', 'sent', 'failed', 'rejected'] as const;

const ListQuery = z.object({
  status: optionalEnum(OUTBOX_STATUSES, { description: 'Filter by outbox item status.' }),
  source: optionalEnum(SERVICE_SOURCES, { description: 'Filter by target service.' }),
  ...paginationSchema(50, 200),
});

const IdParam = z.object({ id: intParam('outbox') });
const BatchParam = z.object({ batchId: z.string().min(1) });

const BatchActionBody = z.object({
  action: z.enum(['approve', 'reject'], { error: 'must be "approve" or "reject"' }),
});

const ItemActionBody = z.object({
  action: z.enum(['approve', 'reject', 'edit'], { error: 'must be "approve", "reject" or "edit"' }),
  content: z.string().optional().openapi({ description: 'Replacement text (action=edit only).' }),
});

/** Shared shape of a single queued operation. */
const OperationBody = z.object({
  source: requiredString('source').openapi({ description: 'Target service, e.g. slack, gmail, obsidian.' }),
  recipient_id: requiredString('recipient_id')
    .openapi({ description: 'Channel/chat/thread/file id the action targets.' }),
  recipient_name: z.string().optional(),
  content: requiredString('content')
    .openapi({ description: 'Plain text for messaging services; a JSON action payload for structured services.' }),
});

const CreateBody = OperationBody;

const BatchCreateBody = z.object({
  source: requiredString('source'),
  recipient_ids: z.array(z.object({ id: requiredString('id'), name: z.string().optional() }))
    .min(1, { error: 'must contain at least one recipient' }),
  content: requiredString('content'),
});

const MultiBatchBody = z.object({
  operations: z.array(OperationBody).min(1, { error: 'must be a non-empty array' }),
});

documentRoute({ method: 'get', path: '/outbox', query: ListQuery });
documentRoute({ method: 'post', path: '/outbox', body: CreateBody });
documentRoute({ method: 'post', path: '/outbox/batch', body: BatchCreateBody });
documentRoute({ method: 'post', path: '/outbox/batch/multi', body: MultiBatchBody });
documentRoute({
  method: 'get',
  path: '/outbox/batch/{batchId}',
  params: BatchParam,
  summary: 'Read every item in an outbox batch',
  description: 'Returns all outbox items sharing a batchId, in creation order.',
});
documentRoute({
  method: 'patch',
  path: '/outbox/batch/{batchId}',
  params: BatchParam,
  body: BatchActionBody,
  summary: 'Approve or reject an entire outbox batch',
  description: 'Approving dispatches each pending item sequentially; a failure on one item marks it failed and the rest continue.',
});
documentRoute({ method: 'get', path: '/outbox/{id}', params: IdParam });
documentRoute({ method: 'patch', path: '/outbox/{id}', params: IdParam, body: ItemActionBody });
documentRoute({ method: 'post', path: '/outbox/{id}/retry', params: IdParam });
documentRoute({ method: 'delete', path: '/outbox/{id}', params: IdParam });

// ── Auto-batching: group single POST /outbox requests by service ──────────────

interface PendingBatchSlot {
  batchId: string;
  slotKey: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * In-memory map of `source:actor → PendingBatchSlot`.
 *
 * When a single-item POST /outbox request arrives we look up whether there is
 * already an open slot for the same service AND the same actor.  If so we join
 * that batch.  If not we open a new slot and schedule a timer to close it after
 * the window expires.  This means any number of individual outbox requests for
 * the same service from the same actor that arrive within BATCH_WINDOW_MS of
 * each other end up sharing a batchId and are presented to the user as a single
 * grouped card.
 *
 * Slots are keyed by `service:apiKeyId` (or `service:ui` for the UI actor) so
 * two different API keys posting to the same service within the window never
 * share a batch — otherwise a batch approve/reject would act on both keys'
 * items at once.
 */
const pendingBatchSlots = new Map<string, PendingBatchSlot>();

/** How long (ms) to keep a batch slot open waiting for additional items. */
const BATCH_WINDOW_MS = 3_000;

/**
 * Return an existing open batchId for `source` + `actorKey` (and refresh the
 * close timer), or create a new one. `actorKey` is the API key id as a string,
 * or 'ui' for the UI actor.
 */
function getOrCreateBatchSlot(source: string, actorKey: string): string {
  const slotKey = `${source}:${actorKey}`;
  const existing = pendingBatchSlots.get(slotKey);
  if (existing) {
    // Refresh the timer so the window extends from the latest item
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => pendingBatchSlots.delete(slotKey), BATCH_WINDOW_MS);
    return existing.batchId;
  }
  const batchId = randomUUID();
  const timer = setTimeout(() => pendingBatchSlots.delete(slotKey), BATCH_WINDOW_MS);
  pendingBatchSlots.set(slotKey, { batchId, slotKey, timer });
  return batchId;
}

// ── AI tool call logging ──────────────────────────────────────────────────────

/**
 * If the request was made by the AI agent (API key + X-Session-Id), record an
 * aiToolCalls row capturing the raw request body and return its ID so it can be
 * linked to the resulting outbox item.  Returns null for non-AI or UI requests.
 */
function recordAiOutboxToolCall(
  authedReq: AuthedRequest,
  source: string,
  recipientId: string,
  content: string,
): string | null {
  if (authedReq.actor !== 'api' || !authedReq.aiSessionId) return null;
  const db = getDb();
  const id = nanoid();
  try {
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(content); } catch { parsedBody = content; }
    db.insert(aiToolCalls).values({
      id,
      sessionId: authedReq.aiSessionId,
      name: 'createOutboxItem',
      input: JSON.stringify({ method: 'POST', path: '/outbox', body: parsedBody }),
      output: `outbox item for ${source} → ${recipientId}`,
      createdAt: new Date().toISOString(),
    }).run();
    return id;
  } catch {
    return null;
  }
}

// ── Fine-grained write enforcement ───────────────────────────────────────────

function parseFgConfig(raw: string | null | undefined): ServiceFineGrained | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as ServiceFineGrained; } catch { return null; }
}

/**
 * Resolve effective fine-grained config for an actor:
 *  - UI actor → global permissions row
 *  - API actor → override ?? global
 */
function resolveWriteFineGrained(service: string, apiKeyId: number | null | undefined): ServiceFineGrained | null {
  const db = getDb();
  const global = db.select().from(permissions).where(eq(permissions.service, service)).get();
  const globalFg = parseFgConfig(global?.fineGrainedConfig);
  if (!apiKeyId) return globalFg;

  const override = db.select().from(apiKeyPermissions)
    .where(and(eq(apiKeyPermissions.apiKeyId, apiKeyId), eq(apiKeyPermissions.service, service)))
    .get();
  if (!override) return globalFg;
  const overrideFg = parseFgConfig(override.fineGrainedConfig);
  return overrideFg ?? globalFg;
}

/**
 * Check whether `recipientId` is permitted for a write operation on `service`.
 * Returns null if allowed, or an error message string if denied.
 *
 * Only enforced for API key actors. UI actors are unrestricted on write.
 * An empty allowlist (null / empty array) means "all recipients allowed".
 */
function checkWriteAllowlist(
  service: string,
  recipientId: string,
  apiKeyId: number | null | undefined,
): string | null {
  if (!apiKeyId) return null; // UI actor — unrestricted

  const fg = resolveWriteFineGrained(service, apiKeyId);
  if (!fg) return null; // no fine-grained config — unrestricted

  // Extract the write allowlist for this service
  let allowList: string[] | undefined;

  switch (service) {
    case 'slack':
      allowList = (fg as SlackFineGrained).writeChannelIds;
      break;
    case 'discord':
      // Permit if recipient matches either an allowed channel or allowed guild
      // For Discord, recipientId is the channelId
      allowList = (fg as DiscordFineGrained).writeChannelIds;
      if (allowList && allowList.length > 0 && allowList.includes(recipientId)) return null;
      allowList = (fg as DiscordFineGrained).writeGuildIds;
      break;
    case 'telegram':
      allowList = (fg as TelegramFineGrained).writeChatIds;
      break;
    case 'gmail':
      allowList = (fg as GmailFineGrained).writeLabelIds;
      break;
    case 'calendar':
      allowList = (fg as CalendarFineGrained).writeCalendarIds;
      break;
    case 'notion': {
      // For Notion, parse the content to get db/page ids
      allowList = [
        ...((fg as NotionFineGrained).writeDatabaseIds ?? []),
        ...((fg as NotionFineGrained).writePageIds ?? []),
      ];
      break;
    }
    case 'obsidian':
      // For Obsidian, check path prefix allowlist
      allowList = (fg as ObsidianFineGrained).writePaths;
      if (allowList && allowList.length > 0) {
        const allowed = allowList.some((prefix) => recipientId.startsWith(prefix));
        return allowed ? null : `Write to path "${recipientId}" is not permitted for this API key`;
      }
      return null;
    case 'smb': {
      // For SMB, check both writeEnabled toggle and path prefix allowlist
      const smbFg = fg as SmbFineGrained;
      if (smbFg.writeEnabled === false) {
        return `Write access to SMB is disabled for this API key`;
      }
      const smbWritePaths = smbFg.writePaths;
      if (smbWritePaths && smbWritePaths.length > 0) {
        const allowed = smbWritePaths.some((prefix) => recipientId.startsWith(prefix));
        return allowed ? null : `Write to path "${recipientId}" is not permitted for this API key on smb`;
      }
      return null;
    }
    case 'gdrive': {
      // For Drive, check per-folder write permission
      const gdriveFg = fg as GdriveFineGrained;
      if (!gdriveFg.folderPermissions) return null; // no fine-grained config = unrestricted
      const folderPerm = gdriveFg.folderPermissions[recipientId];
      if (!folderPerm) return null; // folder not specifically listed = use global
      if (!folderPerm.write) {
        return `Write access to Google Drive folder "${recipientId}" is not permitted for this API key`;
      }
      return null;
    }
    default:
      return null;
  }

  if (!allowList || allowList.length === 0) return null; // empty list = unrestricted
  if (!allowList.includes(recipientId)) {
    return `Sending to "${recipientId}" is not permitted for this API key on ${service}`;
  }
  return null;
}

// ── Obsidian patch_file pre-flight validation ─────────────────────────────────

/**
 * Result from validateObsidianPatchFile. When fuzzy matching resolved one or
 * more search strings, `rewrittenContent` contains the corrected JSON (with
 * exact matched text substituted in) and `fuzzyMatches` describes each
 * substitution so it can be stored on the outbox item for user review.
 */
interface ObsidianValidationResult {
  /** The content string to store — may be rewritten if fuzzy matching occurred. */
  content: string;
  /** Non-empty only when at least one search string was resolved via fuzzy matching. */
  fuzzyMatches: FuzzyMatchInfo[];
}

/**
 * For `patch_file` outbox items targeting an Obsidian vault, validate every
 * search string against the current on-disk file content before we commit the
 * item to the database.  This surfaces stale-search-string problems immediately
 * at creation time rather than after the item has been sitting in pending state
 * and the user clicks Approve.
 *
 * When an exact match is not found, falls back to fuzzy matching (≥90%
 * similarity, must be unique). If a fuzzy match is accepted the search string
 * in the returned content is rewritten to the actual matched text so that
 * execution at approval time performs a guaranteed exact match.
 *
 * Throws a descriptive Error (suitable for a 400 response) if:
 *  - the content JSON cannot be parsed
 *  - the targeted vault is not connected
 *  - the target file does not exist
 *  - any search string is not found exactly or via fuzzy matching
 *  - any search string (exact or fuzzy) matches more than one location
 */
async function validateObsidianPatchFile(content: string): Promise<ObsidianValidationResult> {
  let action: { action?: string; path?: string; edits?: Array<{ search?: string; position?: string; replace?: string; content?: string }>; vaultId?: number };
  try {
    action = JSON.parse(content);
  } catch {
    return { content, fuzzyMatches: [] }; // not JSON — nothing to validate
  }

  const manager = getConnectionManager();

  // For non-patch actions, still inject vaultId if missing so the client diff preview works
  if (action.action !== 'patch_file') {
    if (action.vaultId === undefined) {
      const all = manager.getAllObsidianVaults();
      if (all.size > 0) {
        const [firstId] = [...all.entries()][0];
        return { content: JSON.stringify({ ...action, vaultId: firstId }), fuzzyMatches: [] };
      }
    }
    return { content, fuzzyMatches: [] };
  }

  // Resolve the vault (same logic as executeObsidianAction).
  // Also capture the resolved vaultId so we can inject it into the stored content
  // when the AI omitted it — the client needs it to fetch the correct file for diff preview.
  let vault: import('../sync/obsidian.js').ObsidianVaultSync | null = null;
  let resolvedVaultId: number | undefined = action.vaultId;
  if (action.vaultId !== undefined) {
    vault = manager.getObsidian(action.vaultId);
    if (!vault) {
      throw new Error(`Obsidian vault ${action.vaultId} is not connected.`);
    }
  } else {
    const all = manager.getAllObsidianVaults();
    if (all.size === 0) {
      throw new Error('No Obsidian vault is connected.');
    }
    const [firstId, firstVault] = [...all.entries()][0];
    vault = firstVault;
    resolvedVaultId = firstId;
  }

  if (!action.path) {
    throw new Error('patch_file action is missing required field: path');
  }
  if (!action.edits || action.edits.length === 0) {
    throw new Error('patch_file action requires at least one edit.');
  }

  // Read the current file content (triggers a sync if stale, same as execution path)
  let fileContent: string;
  try {
    fileContent = await vault.readFile(action.path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`patch_file pre-flight: ${msg}`);
  }

  const fuzzyMatches: FuzzyMatchInfo[] = [];
  // Track whether any edits were rewritten so we know if we need to re-serialise
  let anyRewritten = false;
  const rewrittenEdits = action.edits.map(e => ({ ...e }));

  // Validate each search string by simulating the sequential edit application,
  // exactly mirroring the logic in ObsidianVaultSync.executeAction so that what
  // passes here will also pass at execution time (and vice-versa).
  let current = fileContent;
  for (let i = 0; i < action.edits.length; i++) {
    const edit = action.edits[i] as { search?: string; position?: string; replace?: string; content?: string };
    const { position = 'replace', replace = '', content: insertContent = '' } = edit;
    let { search } = edit;

    if (!search) {
      throw new Error(
        `patch_file validation failed for "${action.path}":\n\n` +
        `Edit ${i + 1}: search string must not be empty.`
      );
    }

    // ── Exact match check ────────────────────────────────────────────────────
    let count = 0;
    let pos = current.indexOf(search);
    const firstPos = pos;
    while (pos !== -1) {
      count++;
      if (count > 1) break;
      pos = current.indexOf(search, pos + 1);
    }

    if (count > 1) {
      const preview = search.length > 120
        ? search.slice(0, 120).replace(/\n/g, '↵') + '…'
        : search.replace(/\n/g, '↵');
      throw new Error(
        `patch_file validation failed for "${action.path}":\n\n` +
        `Edit ${i + 1}: search string matches more than one location in the file.\n` +
        `Search string (${search.length} chars): "${preview}"\n` +
        `Make it more specific by including more surrounding context.`
      );
    }

    if (count === 0) {
      // ── Fuzzy fallback ───────────────────────────────────────────────────
      const fuzzyResult = fuzzyFind(search, current);

      if (!fuzzyResult) {
        const preview = search.length > 120
          ? search.slice(0, 120).replace(/\n/g, '↵') + '…'
          : search.replace(/\n/g, '↵');
        throw new Error(
          `patch_file validation failed for "${action.path}":\n\n` +
          `Edit ${i + 1}: search string not found in current file content (exact or fuzzy).\n` +
          `Search string (${search.length} chars): "${preview}"\n` +
          `Make sure it matches the file content exactly (including whitespace and line endings).`
        );
      }

      // Record the fuzzy substitution for user display
      fuzzyMatches.push({
        editIndex: i,
        searchedFor: search,
        matchedTo: fuzzyResult.matchedText,
        similarity: fuzzyResult.similarity,
      });

      // Rewrite this edit's search string to the exact matched text so that
      // execution at approval time does a guaranteed exact match.
      rewrittenEdits[i] = { ...rewrittenEdits[i], search: fuzzyResult.matchedText };
      search = fuzzyResult.matchedText;
      anyRewritten = true;
    }

    // Apply the edit (using the possibly-rewritten search string) to keep
    // `current` in sync for subsequent edit validation.
    const matchPos = current.indexOf(search);
    if (position === 'before') {
      current = current.slice(0, matchPos) + insertContent + current.slice(matchPos);
    } else if (position === 'after') {
      const afterPos = matchPos + search.length;
      current = current.slice(0, afterPos) + insertContent + current.slice(afterPos);
    } else {
      // 'replace' (default)
      current = current.slice(0, matchPos) + replace + current.slice(matchPos + search.length);
    }
  }

  // Re-serialise content if:
  // - any search strings were rewritten by fuzzy matching, OR
  // - vaultId was missing and we resolved it (so the client can fetch the right vault for diff preview)
  const needsRewrite = anyRewritten || action.vaultId === undefined;
  const finalContent = needsRewrite
    ? JSON.stringify({ ...action, vaultId: resolvedVaultId, edits: rewrittenEdits })
    : content;

  return { content: finalContent, fuzzyMatches };
}

// ── Google Drive patch_file pre-flight validation ─────────────────────────────

/**
 * For `patch_file` outbox items targeting a Google Drive file, validate each
 * search string against the current file content before committing.
 * Only applies to plain-text files — Google Workspace docs are skipped
 * (the Docs/Sheets API handles reporting at execution time).
 */
async function validateGdrivePatchFile(content: string): Promise<void> {
  let action: { action?: string; fileId?: string; folderId?: number; edits?: Array<{ search?: string; replace?: string }> };
  try {
    action = JSON.parse(content);
  } catch {
    return;
  }
  if (action.action !== 'patch_file') return;
  if (!action.fileId || !action.folderId) return;
  if (!action.edits?.length) return;

  const manager = getConnectionManager();
  const { getDb } = await import('../db/client.js');
  const { googleDriveFolderConfig } = await import('../db/schema.js');
  const { eq: eqFn } = await import('drizzle-orm');
  const db = getDb();
  const row = db.select().from(googleDriveFolderConfig).where(eqFn(googleDriveFolderConfig.id, action.folderId)).get();
  if (!row) throw new Error(`Drive folder config ${action.folderId} not found`);

  const gdrive = manager.getGdrive(row.email);
  if (!gdrive) throw new Error(`No Google Drive connection for ${row.email}`);

  await gdrive.validatePatchFile({ action: 'patch_file', folderId: action.folderId, fileId: action.fileId, edits: action.edits as Array<{ search: string; replace: string }> });
}

// ── Shared dispatch helper ────────────────────────────────────────────────────

/**
 * Execute a single outbox item against the appropriate platform connection.
 * Used by both the auto-send path (POST /) and the approval path (PATCH /:id).
 */
async function dispatchOutboxItem(
  source: string,
  recipientId: string,
  content: string,
): Promise<void> {
  const manager = getConnectionManager();
  if (source === 'gmail') {
    await manager.executeGmailAction(JSON.parse(content) as Parameters<typeof manager.executeGmailAction>[0]);
  } else if (source === 'calendar') {
    await manager.executeCalendarAction(JSON.parse(content) as Parameters<typeof manager.executeCalendarAction>[0]);
  } else if (source === 'twitter') {
    await manager.executeTwitterAction(JSON.parse(content) as Parameters<typeof manager.executeTwitterAction>[0]);
  } else if (source === 'notion') {
    await manager.executeNotionAction(JSON.parse(content) as Parameters<typeof manager.executeNotionAction>[0]);
  } else if (source === 'obsidian') {
    await manager.executeObsidianAction(JSON.parse(content) as Parameters<typeof manager.executeObsidianAction>[0]);
  } else if (source === 'smb') {
    await manager.executeSmbAction(JSON.parse(content) as Parameters<typeof manager.executeSmbAction>[0]);
  } else if (source === 'gdrive') {
    await manager.executeGdriveAction(JSON.parse(content) as Parameters<typeof manager.executeGdriveAction>[0]);
  } else {
    await manager.sendMessage(source as 'slack' | 'discord' | 'telegram', recipientId, content);
  }
}

// ── Atomic status transitions ─────────────────────────────────────────────────

/**
 * Atomically transition an outbox row out of `fromStatus`.
 *
 * The status guard in the WHERE clause is what makes concurrent
 * approve/reject/retry race-safe: better-sqlite3 executes the UPDATE
 * atomically, so exactly one caller observes `changes === 1` and proceeds to
 * dispatch; every other concurrent caller gets `false` and must treat the item
 * as already handled.
 */
export function atomicStatusFlip(
  id: number,
  fromStatus: 'pending' | 'failed',
  set: { status: string; approvedAt?: string | null; errorMessage?: string | null },
): boolean {
  const db = getDb();
  const result = db.update(outbox)
    .set(set)
    .where(and(eq(outbox.id, id), eq(outbox.status, fromStatus)))
    .run();
  return result.changes === 1;
}

// ── Idempotency ───────────────────────────────────────────────────────────────

/** Extract a non-empty Idempotency-Key header value, or null. */
function getIdempotencyKeyHeader(req: Request): string | null {
  const raw = req.headers['idempotency-key'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

/** Look up an existing outbox row by client-supplied idempotency key. */
export function findByIdempotencyKey(key: string): typeof outbox.$inferSelect | null {
  const db = getDb();
  return db.select().from(outbox).where(eq(outbox.idempotencyKey, key)).get() ?? null;
}

/** True when `e` is a SQLite unique-constraint violation (idempotency-key race). */
function isUniqueConstraintError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') return true;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('UNIQUE constraint failed');
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', optionalAuth, validateQuery(ListQuery), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { status, source, limit, offset } = queryOf(ListQuery, req);

  // API key actors only ever see their own items; the UI actor sees everything.
  const scope = [];
  if (authedReq.apiKey?.id) scope.push(eq(outbox.apiKeyId, authedReq.apiKey.id));

  const conditions = [...scope];
  if (status) conditions.push(eq(outbox.status, status));
  if (source) conditions.push(eq(outbox.source, source));
  const whereExpr = conditions.length ? and(...conditions) : undefined;

  const items = db.select().from(outbox)
    .where(whereExpr)
    .orderBy(desc(outbox.createdAt), desc(outbox.id))
    .limit(limit)
    .offset(offset)
    .all();

  const total = (db.select({ count: sql<number>`count(*)` }).from(outbox)
    .where(whereExpr).get()?.count) ?? 0;

  // pendingCount is key-scoped but NOT affected by the status/source filters —
  // the UI badge relies on it being the global pending total for the actor.
  const pendingCount = (db.select({ count: sql<number>`count(*)` }).from(outbox)
    .where(and(...scope, eq(outbox.status, 'pending'))).get()?.count) ?? 0;

  res.json({ items, total, pendingCount, limit, offset });
});

// ── Batch-level read ──────────────────────────────────────────────────────────
// IMPORTANT: must be registered BEFORE /:id so Express doesn't treat "batch" as an id.

router.get('/batch/:batchId', optionalAuth, validateParams(BatchParam), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { batchId } = paramsOf(BatchParam, req);

  // API key actors only ever see their own items; the UI actor sees everything.
  const conditions = [eq(outbox.batchId, batchId)];
  if (authedReq.apiKey?.id) conditions.push(eq(outbox.apiKeyId, authedReq.apiKey.id));

  const items = db.select().from(outbox)
    .where(and(...conditions))
    .orderBy(outbox.id)
    .all();
  if (items.length === 0) { res.status(404).json({ error: 'Batch not found' }); return; }
  res.json({ batchId, items });
});

// ── Batch-level approve / reject ──────────────────────────────────────────────

router.patch(
  '/batch/:batchId',
  optionalAuth,
  validateParams(BatchParam),
  validateBody(BatchActionBody),
  async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { batchId } = paramsOf(BatchParam, req);
  const { action } = bodyOf(BatchActionBody, req);

  const items = db.select().from(outbox)
    .where(and(eq(outbox.batchId, batchId), eq(outbox.status, 'pending')))
    .orderBy(outbox.id)
    .all();

  if (items.length === 0) {
    res.status(404).json({ error: 'No pending items found for this batch' });
    return;
  }

  // For approve: block if any item in the batch has a validation error
  if (action === 'approve') {
    const failedItem = items.find((i) => i.errorMessage);
    if (failedItem) {
      res.status(400).json({
        error: `Batch contains a failed item (id=${failedItem.id}). Reject or fix it before approving the batch.`,
        failedItemId: failedItem.id,
      });
      return;
    }
  }

  if (action === 'reject') {
    let count = 0;
    for (const item of items) {
      // Atomic guard: only reject items that are still pending at UPDATE time.
      if (!atomicStatusFlip(item.id, 'pending', { status: 'rejected' })) continue;
      count++;
      writeAuditLog('reject', authedReq.actor, { service: item.source, targetId: String(item.id), detail: { batch_id: batchId } });
      broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'rejected' } });
    }
    res.json({ success: true, status: 'rejected', count });
    return;
  }

  // approve — dispatch each item sequentially (rate-limit friendly); a failure
  // on one item marks it failed and continues with the rest.
  const results: Array<{ id: number; status: string; error?: string }> = [];
  let approved = 0;
  let failed = 0;

  for (const item of items) {
    // Atomic guard: skip items a concurrent request already handled.
    if (!atomicStatusFlip(item.id, 'pending', { status: 'approved', approvedAt: new Date().toISOString() })) {
      results.push({ id: item.id, status: 'skipped', error: 'Item is not pending (already handled?)' });
      continue;
    }
    writeAuditLog('approve', authedReq.actor, { service: item.source, targetId: String(item.id), detail: { batch_id: batchId } });

    try {
      const textToSend = item.editedContent || item.content;
      await dispatchOutboxItem(item.source, item.recipientId, textToSend);
      db.update(outbox).set({ status: 'sent', sentAt: new Date().toISOString() }).where(eq(outbox.id, item.id)).run();
      writeAuditLog('send', authedReq.actor, {
        service: item.source,
        targetId: String(item.id),
        detail: { batch_id: batchId, recipient_id: item.recipientId },
      });
      broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'sent' } });
      results.push({ id: item.id, status: 'sent' });
      approved++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, item.id)).run();
      broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'failed', error: errMsg } });
      results.push({ id: item.id, status: 'failed', error: errMsg });
      failed++;
    }
  }

  const allSent = results.every((r) => r.status === 'sent');
  res.json({ success: allSent, approved, failed, results });
});

router.get('/:id', optionalAuth, validateParams(IdParam), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const item = db.select().from(outbox).where(eq(outbox.id, paramsOf(IdParam, req).id)).get();
  // API key actors only ever see their own items (404 rather than 403 so the
  // existence of other keys' items is not leaked).
  if (!item || (authedReq.apiKey?.id && item.apiKeyId !== authedReq.apiKey.id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(item);
});

router.post('/', optionalAuth, validateBody(CreateBody), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, recipient_id, recipient_name, content } = bodyOf(CreateBody, req);

  // Idempotent replay: a retried POST carrying the same Idempotency-Key
  // returns the original row instead of double-queueing.
  const idempotencyKey = getIdempotencyKeyHeader(req);
  if (idempotencyKey) {
    const existing = findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (authedReq.apiKey?.id && existing.apiKeyId !== authedReq.apiKey.id) {
        res.status(409).json({ error: 'Idempotency-Key is already in use' });
        return;
      }
      res.status(200).json({ ...existing, idempotent: true });
      return;
    }
  }

  const perm = db.select().from(permissions).where(eq(permissions.service, source)).get();
  if (!perm?.sendEnabled) {
    res.status(403).json({ error: `Sending is not enabled for ${source}` });
    return;
  }

  // Fine-grained write allowlist check (API key actors only)
  const writeErr = checkWriteAllowlist(source, recipient_id, authedReq.apiKey?.id);
  if (writeErr) {
    res.status(403).json({ error: writeErr });
    return;
  }

  // Pre-flight validation: ensure patch_file search strings match current file
  let finalContent = content;
  let fuzzyMatchInfo: string | null = null;

  if (source === 'obsidian') {
    try {
      const result = await validateObsidianPatchFile(content);
      finalContent = result.content;
      if (result.fuzzyMatches.length > 0) {
        fuzzyMatchInfo = JSON.stringify(result.fuzzyMatches);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
      return;
    }
  }
  if (source === 'gdrive') {
    try {
      await validateGdrivePatchFile(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
      return;
    }
  }

  const aiToolCallId = recordAiOutboxToolCall(authedReq, source, recipient_id, finalContent);

  // Assign to an auto-batch slot so rapid sequential requests for the same
  // service from the same actor are grouped into one batch card in the UI.
  const autoBatchId = getOrCreateBatchSlot(
    source,
    authedReq.apiKey?.id != null ? String(authedReq.apiKey.id) : 'ui',
  );

  // requireApproval unification: when the actor's effective requireApproval is
  // off, the item is created pre-approved and dispatched immediately (mirroring
  // /gmail/actions and /calendar/actions). UI actors additionally require the
  // directSendFromUi toggle, preserving prior behaviour.
  const approvalRequired = isApprovalRequired(source, authedReq.apiKey?.id);
  const autoSend = authedReq.actor === 'ui'
    ? Boolean(perm.directSendFromUi) && !approvalRequired
    : !approvalRequired;

  let item: typeof outbox.$inferSelect;
  try {
    item = db.insert(outbox).values({
      batchId: autoBatchId,
      source,
      recipientId: recipient_id,
      recipientName: recipient_name || recipient_id,
      content: finalContent,
      status: autoSend ? 'approved' : 'pending',
      approvedAt: autoSend ? new Date().toISOString() : null,
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
      aiToolCallId,
      fuzzyMatchInfo,
      idempotencyKey,
    }).returning().get();
  } catch (e) {
    // Unique-constraint race: a concurrent request with the same
    // Idempotency-Key won the insert. Return its row.
    if (idempotencyKey && isUniqueConstraintError(e)) {
      const existing = findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (authedReq.apiKey?.id && existing.apiKeyId !== authedReq.apiKey.id) {
          res.status(409).json({ error: 'Idempotency-Key is already in use' });
          return;
        }
        res.status(200).json({ ...existing, idempotent: true });
        return;
      }
    }
    throw e;
  }

  writeAuditLog('send_request', authedReq.actor, {
    service: source,
    apiKeyId: authedReq.apiKey?.id,
    targetId: String(item.id),
    detail: { recipient_id, content: content.slice(0, 100) },
  });

  broadcast({ type: 'outbox:new', data: item });

  if (autoSend) {
    try {
      // Dispatch what was stored (finalContent) — never the raw request
      // content, which may lack the fuzzy-match rewrite / injected vaultId.
      const textToSend = item.editedContent || item.content;
      await dispatchOutboxItem(source, recipient_id, textToSend);
      db.update(outbox).set({
        status: 'sent',
        sentAt: new Date().toISOString(),
      }).where(eq(outbox.id, item.id)).run();
      writeAuditLog('send', authedReq.actor, {
        service: source,
        apiKeyId: authedReq.apiKey?.id,
        targetId: String(item.id),
        detail: { recipient_id, auto_sent: true },
      });
      broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'sent' } });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, item.id)).run();
      broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'failed', error: errMsg } });
    }
  }

  res.json(db.select().from(outbox).where(eq(outbox.id, item.id)).get());
});

router.post('/batch', optionalAuth, validateBody(BatchCreateBody), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, recipient_ids, content } = bodyOf(BatchCreateBody, req);

  const perm = db.select().from(permissions).where(eq(permissions.service, source)).get();
  if (!perm?.sendEnabled) {
    res.status(403).json({ error: `Sending is not enabled for ${source}` });
    return;
  }

  // Fine-grained write allowlist check for batch (check all recipients)
  for (const recipient of recipient_ids) {
    const writeErr = checkWriteAllowlist(source, recipient.id, authedReq.apiKey?.id);
    if (writeErr) {
      res.status(403).json({ error: writeErr });
      return;
    }
  }

  // Pre-flight validation: ensure patch_file search strings match current file
  let batchFinalContent = content;
  let batchFuzzyMatchInfo: string | null = null;

  if (source === 'obsidian') {
    try {
      const result = await validateObsidianPatchFile(content);
      batchFinalContent = result.content;
      if (result.fuzzyMatches.length > 0) {
        batchFuzzyMatchInfo = JSON.stringify(result.fuzzyMatches);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
      return;
    }
  }
  if (source === 'gdrive') {
    try {
      await validateGdrivePatchFile(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
      return;
    }
  }

  const batchId = randomUUID();
  const items = [];

  for (const recipient of recipient_ids) {
    const aiToolCallId = recordAiOutboxToolCall(authedReq, source, recipient.id, batchFinalContent);
    const item = db.insert(outbox).values({
      batchId,
      source,
      recipientId: recipient.id,
      recipientName: recipient.name || recipient.id,
      content: batchFinalContent,
      status: 'pending',
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
      aiToolCallId,
      fuzzyMatchInfo: batchFuzzyMatchInfo,
    }).returning().get();
    items.push(item);
  }

  broadcast({ type: 'outbox:new', data: { batchId, count: items.length, items } });

  res.json({ batchId, items });
});

/**
 * POST /api/outbox/batch/multi
 *
 * Queue a heterogeneous batch of outbox operations across any combination of
 * services. All operations share a single batchId so they can be reviewed and
 * acted on as a logical bundle. Per-operation permission checks are applied.
 *
 * Body:
 * {
 *   operations: Array<{
 *     source: string;
 *     recipient_id: string;
 *     recipient_name?: string;
 *     content: string;       // plain text for messaging services; JSON payload for structured services
 *   }>
 * }
 *
 * Response:
 * { batchId: string, items: Array<{ id: number, source: string, status: string }> }
 */
router.post('/batch/multi', optionalAuth, validateBody(MultiBatchBody), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();

  const { operations } = bodyOf(MultiBatchBody, req);

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const perm = db.select().from(permissions).where(eq(permissions.service, op.source)).get();
    if (!perm?.sendEnabled) {
      res.status(403).json({ error: `Sending is not enabled for ${op.source} (operations[${i}])` });
      return;
    }
    // Fine-grained write allowlist check (API key actors only)
    const writeErr = checkWriteAllowlist(op.source, op.recipient_id, authedReq.apiKey?.id);
    if (writeErr) {
      res.status(403).json({ error: `${writeErr} (operations[${i}])` });
      return;
    }
    // Pre-flight validation for Obsidian patch_file operations
    if (op.source === 'obsidian') {
      try {
        const result = await validateObsidianPatchFile(op.content);
        op.content = result.content;
        (op as typeof op & { _fuzzyMatchInfo?: string | null })._fuzzyMatchInfo =
          result.fuzzyMatches.length > 0 ? JSON.stringify(result.fuzzyMatches) : null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(400).json({ error: `${msg} (operations[${i}])` });
        return;
      }
    }
    if (op.source === 'gdrive') {
      try {
        await validateGdrivePatchFile(op.content);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(400).json({ error: `${msg} (operations[${i}])` });
        return;
      }
    }
  }

  const batchId = randomUUID();
  const items = [];

  for (const op of operations) {
    const perm = db.select().from(permissions).where(eq(permissions.service, op.source)).get()!;
    const opFuzzyMatchInfo =
      (op as typeof op & { _fuzzyMatchInfo?: string | null })._fuzzyMatchInfo ?? null;

    const aiToolCallId = recordAiOutboxToolCall(authedReq, op.source, op.recipient_id, op.content);
    const item = db.insert(outbox).values({
      batchId,
      source: op.source,
      recipientId: op.recipient_id,
      recipientName: op.recipient_name || op.recipient_id,
      content: op.content,
      status: 'pending',
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
      aiToolCallId,
      fuzzyMatchInfo: opFuzzyMatchInfo,
    }).returning().get();

    writeAuditLog('send_request', authedReq.actor, {
      service: op.source,
      apiKeyId: authedReq.apiKey?.id,
      targetId: String(item.id),
      detail: { batch_id: batchId, recipient_id: op.recipient_id, content: op.content.slice(0, 100) },
    });

    if (authedReq.actor === 'ui' && perm.directSendFromUi && !perm.requireApproval) {
      try {
        await dispatchOutboxItem(op.source, op.recipient_id, op.content);
        db.update(outbox).set({
          status: 'sent',
          approvedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
        }).where(eq(outbox.id, item.id)).run();
        writeAuditLog('send', authedReq.actor, {
          service: op.source,
          apiKeyId: authedReq.apiKey?.id,
          targetId: String(item.id),
          detail: { batch_id: batchId, recipient_id: op.recipient_id, auto_sent: true },
        });
        items.push({ ...item, status: 'sent' });
        broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'sent' } });
        continue;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, item.id)).run();
        items.push({ ...item, status: 'failed', errorMessage: errMsg });
        broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'failed', error: errMsg } });
        continue;
      }
    }

    items.push(item);
  }

  broadcast({ type: 'outbox:new', data: { batchId, count: items.length, items } });
  res.json({ batchId, items });
});

router.patch(
  '/:id',
  optionalAuth,
  validateParams(IdParam),
  validateBody(ItemActionBody),
  async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { id } = paramsOf(IdParam, req);
  const { action, content } = bodyOf(ItemActionBody, req);

  const item = db.select().from(outbox).where(eq(outbox.id, id)).get();
  // API key actors only ever touch their own items (404, not 403, so other
  // keys' item ids are not enumerable).
  if (!item || (authedReq.apiKey?.id && item.apiKeyId !== authedReq.apiKey.id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (item.status !== 'pending' && action !== 'edit') {
    res.status(409).json({ error: 'Item is not pending (already handled?)' });
    return;
  }

  if (action === 'edit') {
    db.update(outbox).set({ editedContent: content || item.content }).where(eq(outbox.id, id)).run();
    res.json(db.select().from(outbox).where(eq(outbox.id, id)).get());
    return;
  }

  if (action === 'reject') {
    // Atomic guard — a concurrent approve/reject that got there first wins.
    if (!atomicStatusFlip(id, 'pending', { status: 'rejected' })) {
      res.status(409).json({ error: 'Item is not pending (already handled?)' });
      return;
    }
    writeAuditLog('reject', authedReq.actor, { service: item.source, targetId: String(id) });
    broadcast({ type: 'outbox:updated', data: { id, status: 'rejected' } });
    res.json({ success: true, status: 'rejected' });
    return;
  }

  if (action === 'approve') {
    // Atomic guard: exactly one concurrent approver wins the flip and
    // dispatches — this is what prevents double-sending.
    if (!atomicStatusFlip(id, 'pending', { status: 'approved', approvedAt: new Date().toISOString() })) {
      res.status(409).json({ error: 'Item is not pending (already handled?)' });
      return;
    }
    writeAuditLog('approve', authedReq.actor, { service: item.source, targetId: String(id) });

    try {
      const textToSend = item.editedContent || item.content;
      await dispatchOutboxItem(item.source, item.recipientId, textToSend);
      db.update(outbox).set({ status: 'sent', sentAt: new Date().toISOString() }).where(eq(outbox.id, id)).run();
      writeAuditLog('send', authedReq.actor, {
        service: item.source,
        targetId: String(id),
        detail: { recipient_id: item.recipientId },
      });
      broadcast({ type: 'outbox:updated', data: { id, status: 'sent' } });
      res.json({ success: true, status: 'sent' });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, id)).run();
      broadcast({ type: 'outbox:updated', data: { id, status: 'failed', error: errMsg } });
      res.status(500).json({ error: errMsg });
    }
  }
});

// ── POST /outbox/:id/retry — re-dispatch a failed item ───────────────────────

router.post('/:id/retry', optionalAuth, validateParams(IdParam), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { id } = paramsOf(IdParam, req);

  const item = db.select().from(outbox).where(eq(outbox.id, id)).get();
  if (!item || (authedReq.apiKey?.id && item.apiKeyId !== authedReq.apiKey.id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (item.status !== 'failed') {
    res.status(409).json({ error: 'Only failed items can be retried' });
    return;
  }
  if (authedReq.apiKey?.id && !isSendEnabled(item.source, authedReq.apiKey.id)) {
    res.status(403).json({ error: `Sending is not enabled for ${item.source}` });
    return;
  }

  // Atomic guard against concurrent retries.
  if (!atomicStatusFlip(id, 'failed', { status: 'approved', approvedAt: new Date().toISOString(), errorMessage: null })) {
    res.status(409).json({ error: 'Item is no longer failed (concurrent retry?)' });
    return;
  }
  writeAuditLog('retry', authedReq.actor, { service: item.source, targetId: String(id), apiKeyId: authedReq.apiKey?.id });
  broadcast({ type: 'outbox:updated', data: { id, status: 'approved' } });

  try {
    const textToSend = item.editedContent || item.content;
    await dispatchOutboxItem(item.source, item.recipientId, textToSend);
    db.update(outbox).set({ status: 'sent', sentAt: new Date().toISOString() }).where(eq(outbox.id, id)).run();
    writeAuditLog('send', authedReq.actor, {
      service: item.source,
      targetId: String(id),
      detail: { recipient_id: item.recipientId, retried: true },
    });
    broadcast({ type: 'outbox:updated', data: { id, status: 'sent' } });
    res.json({ success: true, status: 'sent' });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, id)).run();
    broadcast({ type: 'outbox:updated', data: { id, status: 'failed', error: errMsg } });
    res.status(500).json({ error: errMsg });
  }
});

router.delete('/:id', optionalAuth, validateParams(IdParam), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { id } = paramsOf(IdParam, req);

  const item = db.select().from(outbox).where(eq(outbox.id, id)).get();
  if (!item || (authedReq.apiKey?.id && item.apiKeyId !== authedReq.apiKey.id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  // Sent items are history and in-flight approvals must not vanish mid-send.
  if (item.status === 'sent' || item.status === 'approved') {
    res.status(409).json({ error: `Cannot delete an item with status "${item.status}"` });
    return;
  }

  db.delete(outbox).where(eq(outbox.id, id)).run();
  writeAuditLog('outbox_deleted', authedReq.actor, {
    service: item.source,
    targetId: String(id),
    apiKeyId: authedReq.apiKey?.id,
    detail: { status: item.status, recipient_id: item.recipientId },
  });
  broadcast({ type: 'outbox:updated', data: { id, status: 'deleted' } });
  res.json({ success: true });
});

export default router;
