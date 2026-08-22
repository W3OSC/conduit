/**
 * Thin HTTP client for the Conduit REST API.
 *
 * Responsibilities kept deliberately small:
 *   - attach auth (`X-API-Key`) and provenance (`X-Session-Id`) to every call
 *   - bound every request with a timeout
 *   - unwrap Conduit's `{ "error": "..." }` bodies into thrown Errors so tool
 *     handlers never have to inspect status codes
 *   - turn 403 into an explicit "the user has not granted this" message, since
 *     that is a permission decision to report back, never something to retry
 */

import type { Config } from './config.js';

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * `'json'` (default) parses the success body, falling back to the raw string
   * when it is not JSON. `'text'` is for endpoints that stream file bytes
   * rather than JSON (SMB file reads), where JSON parsing would corrupt the
   * content of a file that happens to look like JSON.
   */
  expect?: 'json' | 'text';
}

/** An error carrying the HTTP status Conduit responded with, when there was one. */
export class ConduitApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConduitApiError';
  }
}

/** Pull a human-readable message out of whatever Conduit returned. */
function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const err = (body as Record<string, unknown>)['error'];
    if (typeof err === 'string' && err.trim()) return err.trim();
    if (err && typeof err === 'object') {
      const nested = (err as Record<string, unknown>)['message'];
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
    const msg = (body as Record<string, unknown>)['message'];
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  }
  return fallback;
}

export class ConduitClient {
  constructor(private readonly config: Config) {}

  /** Build an absolute URL. `path` segments must already be encoded. */
  private url(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', query, body, headers = {}, expect = 'json' } = options;
    const url = this.url(path, query);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'X-API-Key': this.config.apiKey,
          'X-Session-Id': this.config.sessionId,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new ConduitApiError(
          `Conduit did not respond within ${this.config.timeoutMs}ms (${method} ${path}). ` +
            'The hub may be syncing or unreachable; narrow the query (smaller limit, tighter time window) or retry.',
        );
      }
      const reason = e instanceof Error ? e.message : String(e);
      throw new ConduitApiError(
        `Cannot reach Conduit at ${this.config.baseUrl} (${reason}). ` +
          'Check that the hub is running and that CONDUIT_URL is correct.',
      );
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const detail = messageFromBody(parsed, `${response.status} ${response.statusText}`);
      if (response.status === 401) {
        throw new ConduitApiError(
          `Conduit rejected the API key (401): ${detail}. ` +
            'Check CONDUIT_API_KEY — it may be revoked or belong to a different hub.',
          401,
        );
      }
      if (response.status === 403) {
        throw new ConduitApiError(
          `Permission denied by Conduit (403): ${detail}. ` +
            'The user has not granted this API key access to that service, channel, label or action. ' +
            'Do not retry — tell the user what access is missing so they can grant it in the Conduit UI.',
          403,
        );
      }
      if (response.status === 404) {
        throw new ConduitApiError(`Not found (404): ${detail}.`, 404);
      }
      throw new ConduitApiError(`Conduit request failed (${response.status}): ${detail}`, response.status);
    }

    return (expect === 'text' ? text : parsed) as T;
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(path, { query });
  }

  /** GET an endpoint that returns raw bytes/text rather than JSON. */
  getText(path: string, query?: Record<string, QueryValue>): Promise<string> {
    return this.request<string>(path, { query, expect: 'text' });
  }

  post<T = unknown>(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, ...(headers ? { headers } : {}) });
  }
}
