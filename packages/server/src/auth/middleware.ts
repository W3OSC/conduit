import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { apiKeys, auditLog, aiToolCalls } from '../db/schema.js';
import { broadcast } from '../websocket/hub.js';

export interface AuthedRequest extends Request {
  apiKey?: {
    id: number;
    name: string;
  };
  actor: 'ui' | 'api';
  aiSessionId?: string; // from X-Session-Id header, only when actor='api'
}

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function apiKeyAuth(required = true) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authedReq = req as AuthedRequest;
    const rawKey = req.headers['x-api-key'] as string | undefined;

    if (!rawKey) {
      if (required) {
        res.status(401).json({ error: 'Missing X-API-Key header' });
        return;
      }
      authedReq.actor = 'ui';
      next();
      return;
    }

    const db = getDb();
    const hash = hashKey(rawKey);
    const key = db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .get();

    if (!key || key.revokedAt) {
      res.status(401).json({ error: 'Invalid or revoked API key' });
      return;
    }

    // Update last used
    db.update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, key.id))
      .run();

    authedReq.apiKey = { id: key.id, name: key.name };
    authedReq.actor = 'api';

    // Attach AI session ID if provided by the AI agent
    const sessionId = req.headers['x-session-id'];
    if (typeof sessionId === 'string' && sessionId) {
      authedReq.aiSessionId = sessionId;
    }

    next();
  };
}

// uiOnlyAuth — blocks API key requests entirely; credentials endpoints must only be
// accessible by the UI user (session cookie). Falls through to uiAuthMiddleware upstream
// for session enforcement when login is enabled.
export function uiOnlyAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-api-key']) {
    res.status(403).json({ error: 'Credentials endpoints are not accessible via API key' });
    return;
  }
  (req as AuthedRequest).actor = 'ui';
  next();
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const authedReq = req as AuthedRequest;
  const rawKey = req.headers['x-api-key'] as string | undefined;

  if (rawKey) {
    const db = getDb();
    const hash = hashKey(rawKey);
    const key = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).get();
    if (key && !key.revokedAt) {
      authedReq.apiKey = { id: key.id, name: key.name };
      authedReq.actor = 'api';
      db.update(apiKeys)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiKeys.id, key.id))
        .run();

      // Attach AI session ID if provided
      const sessionId = req.headers['x-session-id'];
      if (typeof sessionId === 'string' && sessionId) {
        authedReq.aiSessionId = sessionId;
      }

      next();
      return;
    }
  }

  authedReq.actor = 'ui';
  next();
}

export function writeAuditLog(
  action: string,
  actor: 'ui' | 'api',
  opts: {
    service?: string;
    apiKeyId?: number;
    targetId?: string;
    detail?: Record<string, unknown>;
  } = {},
): void {
  const db = getDb();
  db.insert(auditLog)
    .values({
      action,
      actor,
      service: opts.service,
      apiKeyId: opts.apiKeyId,
      targetId: opts.targetId,
      detail: opts.detail ? JSON.stringify(opts.detail) : undefined,
      timestamp: new Date().toISOString(),
    })
    .run();
}

// ── Tool name + service derivation ────────────────────────────────────────────

interface ToolMeta {
  name: string;
  service?: string;
}

function deriveToolMeta(req: Request): ToolMeta {
  const path = req.path; // e.g. '/messages', '/gmail/messages', '/chats'
  const query = req.query as Record<string, string>;

  // Messages / chats / activity / search
  if (path === '/chats')    return { name: 'getChats' };
  if (path === '/activity') return { name: 'getActivity' };
  if (path === '/search')   return { name: 'searchMessages', service: query['source'] };
  if (path === '/messages') return { name: 'getMessages',   service: query['source'] };

  // Contacts
  if (path === '/contacts') return { name: 'getContacts', service: query['source'] };
  if (/^\/contacts\/[^/]+\/[^/]+\/history$/.test(path)) {
    const parts = path.split('/');
    return { name: 'getContactHistory', service: parts[2] };
  }
  if (/^\/contacts\/[^/]+\/[^/]+$/.test(path)) {
    const parts = path.split('/');
    return { name: 'getContact', service: parts[2] };
  }

  // Gmail
  if (path === '/gmail/messages')              return { name: 'getEmails',      service: 'gmail' };
  if (path === '/gmail/labels')                return { name: 'getEmailLabels', service: 'gmail' };
  if (/^\/gmail\/messages\/[^/]+\/body$/.test(path)) return { name: 'getEmailBody',  service: 'gmail' };
  if (/^\/gmail\/messages\/[^/]+$/.test(path))       return { name: 'getEmail',      service: 'gmail' };
  if (/^\/gmail\/threads\/[^/]+$/.test(path))        return { name: 'getEmailThread', service: 'gmail' };

  // Calendar
  if (path === '/calendar/calendars')            return { name: 'getCalendars',      service: 'calendar' };
  if (path === '/calendar/events')               return { name: 'getCalendarEvents', service: 'calendar' };
  if (/^\/calendar\/events\/[^/]+$/.test(path)) return { name: 'getCalendarEvent',  service: 'calendar' };

  // Obsidian
  if (/^\/obsidian\/vaults\/\d+\/files$/.test(path))   return { name: 'listVaultFiles', service: 'obsidian' };
  if (/^\/obsidian\/vaults\/\d+\/files\/.+$/.test(path)) return { name: 'readVaultFile', service: 'obsidian' };

  // Fallback
  return { name: req.method.toLowerCase() + path.replace(/\//g, '_').replace(/[^a-z0-9_]/gi, '') };
}

// Build a compact human-readable summary of the response for the output field.
function buildOutputSummary(name: string, body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;

  switch (name) {
    case 'getMessages': {
      const count = Array.isArray(b['messages']) ? b['messages'].length : b['total'];
      const src = (b['messages'] as Array<Record<string, unknown>> | undefined)?.[0]?.['source'];
      return src ? `${count} messages from ${src}` : `${count} messages`;
    }
    case 'getChats': {
      const total = Object.values(b).reduce((acc: number, v) => {
        if (v && typeof v === 'object' && 'sections' in (v as object)) {
          const sections = (v as { sections: Array<{ chats: unknown[] }> }).sections;
          return acc + sections.reduce((s, sec) => s + (sec.chats?.length ?? 0), 0);
        }
        return acc;
      }, 0);
      return `${total} chats`;
    }
    case 'getActivity': {
      const count = Array.isArray(b['items']) ? b['items'].length : b['total'];
      return `${count} activity items`;
    }
    case 'searchMessages': {
      const count = Array.isArray(b['results']) ? b['results'].length : 0;
      return `${count} results`;
    }
    case 'getContacts': {
      const count = b['total'] ?? (Array.isArray(b['contacts']) ? b['contacts'].length : 0);
      return `${count} contacts`;
    }
    case 'getContactHistory': {
      const count = b['total'] ?? (Array.isArray(b['messages']) ? b['messages'].length : 0);
      return `${count} messages`;
    }
    case 'getContact':
      return (b['displayName'] as string | undefined) ?? 'contact';
    case 'getEmails': {
      const count = b['total'] ?? (Array.isArray(b['messages']) ? b['messages'].length : 0);
      return `${count} emails`;
    }
    case 'getEmail':
      return (b['subject'] as string | undefined) ?? 'email';
    case 'getEmailBody':
      return 'email body';
    case 'getEmailThread': {
      const count = Array.isArray(b['messages']) ? b['messages'].length : 0;
      return `thread with ${count} messages`;
    }
    case 'getEmailLabels': {
      const count = Array.isArray(b['labels']) ? b['labels'].length : 0;
      return `${count} labels`;
    }
    case 'getCalendarEvents': {
      const count = b['total'] ?? (Array.isArray(b['events']) ? b['events'].length : 0);
      return `${count} events`;
    }
    case 'getCalendarEvent':
      return (b['title'] as string | undefined) ?? 'event';
    case 'getCalendars': {
      const count = Array.isArray(b['calendars']) ? b['calendars'].length : 0;
      return `${count} calendars`;
    }
    case 'listVaultFiles': {
      const count = Array.isArray(b['files']) ? b['files'].length : 0;
      return `${count} files`;
    }
    case 'readVaultFile':
      return (b['path'] as string | undefined) ?? 'vault file';
    default:
      return '';
  }
}

// Build compact input object — method, path, and key query params only.
function buildInputParams(req: Request): Record<string, unknown> {
  const query = req.query as Record<string, string>;
  const params: Record<string, unknown> = {
    method: req.method,
    path:   req.path,
  };
  // Include relevant query params (exclude internal/pagination noise)
  const keep = ['source', 'chat_id', 'q', 'limit', 'from', 'to', 'since', 'until',
                 'sources', 'label', 'unread', 'starred', 'thread_id', 'calendarId'];
  for (const k of keep) {
    if (query[k] !== undefined) params[k] = query[k];
  }
  // Include route params (e.g. contact platformId, vault id)
  if (Object.keys(req.params).length > 0) {
    params['routeParams'] = req.params;
  }
  return params;
}

/**
 * Middleware that records AI API accesses as tool call rows.
 *
 * Applied to read routes accessible to the AI agent. Is a no-op when:
 *   - actor is not 'api', or
 *   - no X-Session-Id header was provided.
 *
 * When active, it wraps res.json() to capture the response body, then after
 * the handler finishes it writes:
 *   1. A row to ai_tool_calls
 *   2. An audit_log entry
 *   3. An ai:toolcall WebSocket broadcast
 */
export function trackAiCall(req: Request, res: Response, next: NextFunction): void {
  const authedReq = req as AuthedRequest;

  // Only track authenticated API-key requests that include a session ID
  if (authedReq.actor !== 'api' || !authedReq.aiSessionId) {
    next();
    return;
  }

  const sessionId  = authedReq.aiSessionId;
  const apiKeyId   = authedReq.apiKey?.id;
  const { name, service } = deriveToolMeta(req);
  const input      = buildInputParams(req);

  // Intercept res.json to capture the outgoing body
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    // Restore immediately to avoid infinite loops
    res.json = originalJson;
    const result = originalJson(body);

    // Fire-and-forget: write the tool call record after the response is sent
    try {
      const output  = buildOutputSummary(name, body);
      const db      = getDb();
      const id      = nanoid();
      const createdAt = new Date().toISOString();

      db.insert(aiToolCalls).values({
        id,
        sessionId,
        name,
        input:  JSON.stringify(input),
        output: output || null,
        createdAt,
      }).run();

      writeAuditLog('read', 'api', {
        service,
        apiKeyId,
        detail: { name, ...input },
      });

      broadcast({
        type: 'ai:toolcall',
        data: {
          sessionId,
          toolCall: { id, sessionId, name, input, output: output || null, createdAt },
        },
      });
    } catch (err) {
      console.error('[trackAiCall] Failed to record tool call:', err);
    }

    return result;
  };

  next();
}
