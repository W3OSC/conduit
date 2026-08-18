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
export declare class ConduitApiError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare class ConduitClient {
    private readonly config;
    constructor(config: Config);
    /** Build an absolute URL. `path` segments must already be encoded. */
    private url;
    request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
    get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T>;
    /** GET an endpoint that returns raw bytes/text rather than JSON. */
    getText(path: string, query?: Record<string, QueryValue>): Promise<string>;
    post<T = unknown>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>;
}
//# sourceMappingURL=client.d.ts.map