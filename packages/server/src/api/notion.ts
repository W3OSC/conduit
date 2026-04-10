/**
 * Notion API router — direct read-only passthrough endpoints.
 *
 * These endpoints execute immediately against the Notion API (no outbox). They
 * are always written to the audit log.
 *
 * Write operations (create page, update page, append blocks, archive) are NOT
 * served here — they go through POST /api/outbox or POST /api/outbox/batch/multi
 * and are only executed after approval (unless directSendFromUi is enabled).
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { permissions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import type { NotionReadAction } from '../sync/notion.js';

const router = Router();

/** Resolve the connection manager and assert that Notion is configured and connected. */
function getNotion(res: ReturnType<Router['get']> extends never ? never : Parameters<Parameters<Router['get']>[1]>[1]) {
  const manager = getConnectionManager();
  const notion = manager.getNotion();
  if (!notion?.connected) {
    res.status(503).json({ error: 'Notion not connected' });
    return null;
  }
  return notion;
}

/** Check readEnabled permission for the notion service. */
function checkReadPermission(res: Parameters<Parameters<Router['get']>[1]>[1]): boolean {
  const db = getDb();
  const perm = db.select().from(permissions).where(eq(permissions.service, 'notion')).get();
  if (!perm?.readEnabled) {
    res.status(403).json({ error: 'Notion read access is not enabled' });
    return false;
  }
  return true;
}

// ── GET /api/notion/pages/:pageId ─────────────────────────────────────────────
//   Retrieve a single Notion page by ID.

router.get('/pages/:pageId', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  if (!checkReadPermission(res)) return;
  const notion = getNotion(res);
  if (!notion) return;

  const { pageId } = req.params as { pageId: string };

  writeAuditLog('notion_read', authedReq.actor, {
    service: 'notion',
    apiKeyId: authedReq.apiKey?.id,
    targetId: pageId,
    detail: { action: 'retrieve_page' },
  });

  try {
    const action: NotionReadAction = { action: 'retrieve_page', pageId };
    const result = await notion.executeRead(action);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/notion/databases/:databaseId/query ──────────────────────────────
//   Query a Notion database with optional filter, sorts, and pagination.

router.post('/databases/:databaseId/query', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  if (!checkReadPermission(res)) return;
  const notion = getNotion(res);
  if (!notion) return;

  const { databaseId } = req.params as { databaseId: string };
  const { filter, sorts, page_size, start_cursor } = req.body as {
    filter?: unknown;
    sorts?: unknown[];
    page_size?: number;
    start_cursor?: string;
  };

  writeAuditLog('notion_read', authedReq.actor, {
    service: 'notion',
    apiKeyId: authedReq.apiKey?.id,
    targetId: databaseId,
    detail: { action: 'query_database', hasFilter: !!filter, hasSorts: !!sorts?.length },
  });

  try {
    const action: NotionReadAction = {
      action: 'query_database',
      databaseId,
      filter,
      sorts,
      pageSize: page_size,
      startCursor: start_cursor,
    };
    const result = await notion.executeRead(action);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/notion/databases ─────────────────────────────────────────────────
//   List all databases accessible to the integration.

router.get('/databases', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  if (!checkReadPermission(res)) return;
  const notion = getNotion(res);
  if (!notion) return;

  writeAuditLog('notion_read', authedReq.actor, {
    service: 'notion',
    apiKeyId: authedReq.apiKey?.id,
    detail: { action: 'list_databases' },
  });

  try {
    // In Notion SDK v3, databases are represented as data_sources
    const action: NotionReadAction = { action: 'list_databases' };
    const result = await notion.executeRead(action);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/notion/search ───────────────────────────────────────────────────
//   Search the Notion workspace for pages and databases.

router.post('/search', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  if (!checkReadPermission(res)) return;
  const notion = getNotion(res);
  if (!notion) return;

  const { query, filter, sort, page_size, start_cursor } = req.body as {
    query?: string;
    filter?: unknown;
    sort?: unknown;
    page_size?: number;
    start_cursor?: string;
  };

  writeAuditLog('notion_read', authedReq.actor, {
    service: 'notion',
    apiKeyId: authedReq.apiKey?.id,
    detail: { action: 'search', query: (query || '').slice(0, 100) },
  });

  try {
    type SearchAction = Extract<NotionReadAction, { action: 'search' }>;
    const action: NotionReadAction = {
      action: 'search',
      query: query || '',
      filter: filter as SearchAction['filter'],
      sort: sort as SearchAction['sort'],
      pageSize: page_size,
      startCursor: start_cursor,
    };
    const result = await notion.executeRead(action);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/notion/blocks/:blockId ──────────────────────────────────────────
//   Retrieve a single block by ID.

router.get('/blocks/:blockId', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  if (!checkReadPermission(res)) return;
  const notion = getNotion(res);
  if (!notion) return;

  const { blockId } = req.params as { blockId: string };

  writeAuditLog('notion_read', authedReq.actor, {
    service: 'notion',
    apiKeyId: authedReq.apiKey?.id,
    targetId: blockId,
    detail: { action: 'retrieve_block' },
  });

  try {
    const action: NotionReadAction = { action: 'retrieve_block', blockId };
    const result = await notion.executeRead(action);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/notion/blocks/:blockId/children ──────────────────────────────────
//   Retrieve the children of a block (e.g. the content of a page).

router.get('/blocks/:blockId/children', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  if (!checkReadPermission(res)) return;
  const notion = getNotion(res);
  if (!notion) return;

  const { blockId } = req.params as { blockId: string };
  const { page_size, start_cursor } = req.query as { page_size?: string; start_cursor?: string };

  writeAuditLog('notion_read', authedReq.actor, {
    service: 'notion',
    apiKeyId: authedReq.apiKey?.id,
    targetId: blockId,
    detail: { action: 'retrieve_block_children' },
  });

  try {
    const action: NotionReadAction = {
      action: 'retrieve_block_children',
      blockId,
      pageSize: page_size ? parseInt(page_size) : undefined,
      startCursor: start_cursor,
    };
    const result = await notion.executeRead(action);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
