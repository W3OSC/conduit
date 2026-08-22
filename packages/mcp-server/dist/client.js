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
/** An error carrying the HTTP status Conduit responded with, when there was one. */
export class ConduitApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'ConduitApiError';
    }
}
/** Pull a human-readable message out of whatever Conduit returned. */
function messageFromBody(body, fallback) {
    if (typeof body === 'string' && body.trim())
        return body.trim();
    if (body && typeof body === 'object') {
        const err = body['error'];
        if (typeof err === 'string' && err.trim())
            return err.trim();
        if (err && typeof err === 'object') {
            const nested = err['message'];
            if (typeof nested === 'string' && nested.trim())
                return nested.trim();
        }
        const msg = body['message'];
        if (typeof msg === 'string' && msg.trim())
            return msg.trim();
    }
    return fallback;
}
export class ConduitClient {
    config;
    constructor(config) {
        this.config = config;
    }
    /** Build an absolute URL. `path` segments must already be encoded. */
    url(path, query) {
        const url = new URL(`${this.config.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value === undefined || value === null || value === '')
                continue;
            url.searchParams.set(key, String(value));
        }
        return url.toString();
    }
    async request(path, options = {}) {
        const { method = 'GET', query, body, headers = {}, expect = 'json' } = options;
        const url = this.url(path, query);
        let response;
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
        }
        catch (e) {
            if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
                throw new ConduitApiError(`Conduit did not respond within ${this.config.timeoutMs}ms (${method} ${path}). ` +
                    'The hub may be syncing or unreachable; narrow the query (smaller limit, tighter time window) or retry.');
            }
            const reason = e instanceof Error ? e.message : String(e);
            throw new ConduitApiError(`Cannot reach Conduit at ${this.config.baseUrl} (${reason}). ` +
                'Check that the hub is running and that CONDUIT_URL is correct.');
        }
        const text = await response.text();
        let parsed = undefined;
        if (text) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = text;
            }
        }
        if (!response.ok) {
            const detail = messageFromBody(parsed, `${response.status} ${response.statusText}`);
            if (response.status === 401) {
                throw new ConduitApiError(`Conduit rejected the API key (401): ${detail}. ` +
                    'Check CONDUIT_API_KEY — it may be revoked or belong to a different hub.', 401);
            }
            if (response.status === 403) {
                throw new ConduitApiError(`Permission denied by Conduit (403): ${detail}. ` +
                    'The user has not granted this API key access to that service, channel, label or action. ' +
                    'Do not retry — tell the user what access is missing so they can grant it in the Conduit UI.', 403);
            }
            if (response.status === 404) {
                throw new ConduitApiError(`Not found (404): ${detail}.`, 404);
            }
            throw new ConduitApiError(`Conduit request failed (${response.status}): ${detail}`, response.status);
        }
        return (expect === 'text' ? text : parsed);
    }
    get(path, query) {
        return this.request(path, { query });
    }
    /** GET an endpoint that returns raw bytes/text rather than JSON. */
    getText(path, query) {
        return this.request(path, { query, expect: 'text' });
    }
    post(path, body, headers) {
        return this.request(path, { method: 'POST', body, ...(headers ? { headers } : {}) });
    }
}
//# sourceMappingURL=client.js.map