/**
 * CSRF protection — double-submit cookie pattern.
 *
 * How it works:
 *   1. On every request, if no `conduit-csrf` cookie exists, the server sets one
 *      containing a random 32-byte hex token (non-httpOnly so the browser JS can read it).
 *   2. On state-changing requests (POST, PUT, PATCH, DELETE) that are authenticated
 *      via a UI session (not an API key), the server reads the `X-CSRF-Token` request
 *      header and verifies it matches the cookie value.
 *   3. API key–authenticated requests are exempt — they cannot be triggered by a
 *      cross-site form or fetch since the API key is not a cookie.
 *   4. The /api/ui-auth/* routes are exempt (needed to obtain a session in the first
 *      place, and they do not perform sensitive state mutations beyond login).
 *
 * This prevents Cross-Site Request Forgery because:
 *   - A malicious cross-origin site can set cookies but cannot READ them (same-origin
 *     policy), so it cannot know the token value to include in the header.
 *   - Browsers will not automatically include the header on cross-origin requests.
 */

import { randomBytes } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AuthedRequest } from './middleware.js';

const CSRF_COOKIE = 'conduit-csrf';
const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Generates or refreshes the CSRF cookie and enforces the double-submit check
 * on state-changing requests authenticated by a UI session.
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Ensure the CSRF cookie exists on every response
  const existingToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[CSRF_COOKIE];
  const token = existingToken || randomBytes(32).toString('hex');

  if (!existingToken) {
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,   // must be readable by JS so the client can send it back
      sameSite: 'lax',
      path: '/',
      // No maxAge → session cookie; refreshed on every request automatically
    });
  }

  // Only enforce on state-changing methods
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // API key requests are exempt — they're not cookie-based and can't be CSRF'd
  const authedReq = req as AuthedRequest;
  if (authedReq.actor === 'api') {
    next();
    return;
  }

  // UI auth routes are exempt (login/logout/setup — not sensitive mutations once logged in)
  if (req.path.startsWith('/api/ui-auth')) {
    next();
    return;
  }

  // When UI auth is disabled, all requests are treated as trusted (same as HTTP auth model)
  // The actor will be 'ui' — we still want CSRF protection here because the CORS is wide open.
  // However, if there's no session cookie at all (login is off), we skip: there's nothing to steal.
  // The meaningful protection is for users who have login enabled.
  const sessionCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.['conduit-session'];
  const sessionHeader = req.headers['x-ui-session'] as string | undefined;
  const hasUiSession = !!(sessionCookie || sessionHeader);

  if (!hasUiSession) {
    // No UI session — CSRF not applicable (unauthenticated or API-key path already handled)
    next();
    return;
  }

  // Enforce double-submit: the X-CSRF-Token header must match the cookie
  const headerToken = req.headers[CSRF_HEADER] as string | undefined;
  if (!headerToken || headerToken !== token) {
    res.status(403).json({ error: 'CSRF token missing or invalid' });
    return;
  }

  next();
}
