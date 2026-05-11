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
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';

const router = Router();

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
 * For `patch_file` outbox items targeting an Obsidian vault, validate every
 * search string against the current on-disk file content before we commit the
 * item to the database.  This surfaces stale-search-string problems immediately
 * at creation time rather than after the item has been sitting in pending state
 * and the user clicks Approve.
 *
 * Throws a descriptive Error (suitable for a 400 response) if:
 *  - the content JSON cannot be parsed
 *  - the targeted vault is not connected
 *  - the target file does not exist
 *  - any search string is not found, or matches more than once
 */
async function validateObsidianPatchFile(content: string): Promise<void> {
  let action: { action?: string; path?: string; edits?: Array<{ search?: string }>; vaultId?: number };
  try {
    action = JSON.parse(content);
  } catch {
    return; // not JSON — nothing to validate here
  }

  if (action.action !== 'patch_file') return; // only validate patch_file

  const manager = getConnectionManager();

  // Resolve the vault (same logic as executeObsidianAction)
  let vault: import('../sync/obsidian.js').ObsidianVaultSync | null = null;
  if (action.vaultId !== undefined) {
    vault = manager.getObsidian(action.vaultId);
    if (!vault) {
      throw new Error(`Obsidian vault ${action.vaultId} is not connected.`);
    }
  } else {
    const all = manager.getAllObsidianVaults();
    vault = all.size > 0 ? [...all.values()][0] : null;
    if (!vault) {
      throw new Error('No Obsidian vault is connected.');
    }
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

  // Validate each search string by simulating the sequential edit application,
  // exactly mirroring the logic in ObsidianVaultSync.executeAction so that what
  // passes here will also pass at execution time (and vice-versa).
  let current = fileContent;
  for (let i = 0; i < action.edits.length; i++) {
    const { search, position = 'replace', replace = '', content: insertContent = '' } = action.edits[i] as {
      search?: string; position?: string; replace?: string; content?: string;
    };

    if (!search) {
      throw new Error(
        `patch_file validation failed for "${action.path}":\n\n` +
        `Edit ${i + 1}: search string must not be empty.`
      );
    }

    let count = 0;
    let pos = current.indexOf(search);
    const firstPos = pos;
    while (pos !== -1) {
      count++;
      if (count > 1) break;
      pos = current.indexOf(search, pos + 1);
    }

    if (count === 0) {
      const preview = search.length > 120
        ? search.slice(0, 120).replace(/\n/g, '↵') + '…'
        : search.replace(/\n/g, '↵');
      throw new Error(
        `patch_file validation failed for "${action.path}":\n\n` +
        `Edit ${i + 1}: search string not found in current file content.\n` +
        `Search string (${search.length} chars): "${preview}"\n` +
        `Make sure it matches the file content exactly (including whitespace and line endings).`
      );
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

    // Apply the edit to keep `current` in sync with what executeAction would produce,
    // so subsequent search strings are validated against the correct intermediate state.
    if (position === 'before') {
      current = current.slice(0, firstPos) + insertContent + current.slice(firstPos);
    } else if (position === 'after') {
      const afterPos = firstPos + search.length;
      current = current.slice(0, afterPos) + insertContent + current.slice(afterPos);
    } else {
      // 'replace' (default)
      current = current.slice(0, firstPos) + replace + current.slice(firstPos + search.length);
    }
  }
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

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const { status, source } = req.query as Record<string, string>;

  const conditions = [];
  if (status) conditions.push(eq(outbox.status, status));
  if (source) conditions.push(eq(outbox.source, source));

  const items = db.select().from(outbox)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(outbox.createdAt))
    .all();

  const pendingCount = (db.select({ count: sql<number>`count(*)` }).from(outbox)
    .where(eq(outbox.status, 'pending')).get()?.count) ?? 0;

  res.json({ items, pendingCount });
});

router.get('/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const item = db.select().from(outbox).where(eq(outbox.id, parseInt(req.params['id'] as string))).get();
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(item);
});

router.post('/', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, recipient_id, recipient_name, content } = req.body as {
    source: string;
    recipient_id: string;
    recipient_name?: string;
    content: string;
  };

  if (!source || !recipient_id || !content) {
    res.status(400).json({ error: 'source, recipient_id, content are required' });
    return;
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
  if (source === 'obsidian') {
    try {
      await validateObsidianPatchFile(content);
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

  const aiToolCallId = recordAiOutboxToolCall(authedReq, source, recipient_id, content);

  const item = db.insert(outbox).values({
    source,
    recipientId: recipient_id,
    recipientName: recipient_name || recipient_id,
    content,
    status: 'pending',
    requester: authedReq.actor,
    apiKeyId: authedReq.apiKey?.id || null,
    aiToolCallId,
  }).returning().get();

  writeAuditLog('send_request', authedReq.actor, {
    service: source,
    apiKeyId: authedReq.apiKey?.id,
    targetId: String(item.id),
    detail: { recipient_id, content: content.slice(0, 100) },
  });

  broadcast({ type: 'outbox:new', data: item });

  if (authedReq.actor === 'ui' && perm.directSendFromUi && !perm.requireApproval) {
    try {
      await dispatchOutboxItem(source, recipient_id, content);
      db.update(outbox).set({
        status: 'sent',
        approvedAt: new Date().toISOString(),
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
    }
  }

  res.json(db.select().from(outbox).where(eq(outbox.id, item.id)).get());
});

router.post('/batch', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, recipient_ids, content } = req.body as {
    source: string;
    recipient_ids: Array<{ id: string; name?: string }>;
    content: string;
  };

  if (!source || !recipient_ids?.length || !content) {
    res.status(400).json({ error: 'source, recipient_ids, content are required' });
    return;
  }

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
  if (source === 'obsidian') {
    try {
      await validateObsidianPatchFile(content);
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
    const aiToolCallId = recordAiOutboxToolCall(authedReq, source, recipient.id, content);
    const item = db.insert(outbox).values({
      batchId,
      source,
      recipientId: recipient.id,
      recipientName: recipient.name || recipient.id,
      content,
      status: 'pending',
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
      aiToolCallId,
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
router.post('/batch/multi', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();

  const { operations } = req.body as {
    operations: Array<{
      source: string;
      recipient_id: string;
      recipient_name?: string;
      content: string;
    }>;
  };

  if (!Array.isArray(operations) || operations.length === 0) {
    res.status(400).json({ error: 'operations must be a non-empty array' });
    return;
  }

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op.source || !op.recipient_id || !op.content) {
      res.status(400).json({ error: `operations[${i}] is missing source, recipient_id, or content` });
      return;
    }
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
        await validateObsidianPatchFile(op.content);
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

router.patch('/:id', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const id = parseInt(req.params['id'] as string);
  const { action, content } = req.body as { action: 'approve' | 'reject' | 'edit'; content?: string };

  const item = db.select().from(outbox).where(eq(outbox.id, id)).get();
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }
  if (item.status !== 'pending' && action !== 'edit') {
    res.status(400).json({ error: 'Item is not pending' });
    return;
  }

  if (action === 'edit') {
    db.update(outbox).set({ editedContent: content || item.content }).where(eq(outbox.id, id)).run();
    res.json(db.select().from(outbox).where(eq(outbox.id, id)).get());
    return;
  }

  if (action === 'reject') {
    db.update(outbox).set({ status: 'rejected' }).where(eq(outbox.id, id)).run();
    writeAuditLog('reject', authedReq.actor, { service: item.source, targetId: String(id) });
    broadcast({ type: 'outbox:updated', data: { id, status: 'rejected' } });
    res.json({ success: true, status: 'rejected' });
    return;
  }

  if (action === 'approve') {
    db.update(outbox).set({ status: 'approved', approvedAt: new Date().toISOString() }).where(eq(outbox.id, id)).run();
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

router.delete('/:id', optionalAuth, (req, res) => {
  const db = getDb();
  db.delete(outbox).where(eq(outbox.id, parseInt(req.params['id'] as string))).run();
  res.json({ success: true });
});

export default router;
