import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { apiKeys, auditLog } from '../db/schema.js';

export interface AuthedRequest extends Request {
  apiKey?: {
    id: number;
    name: string;
  };
  actor: 'ui' | 'api';
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
