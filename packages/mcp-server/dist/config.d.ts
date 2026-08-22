/**
 * Environment-derived configuration for the Conduit MCP server.
 *
 * Everything is read once at startup so a misconfigured environment fails
 * immediately with an actionable message rather than surfacing as a confusing
 * 401 on the agent's first tool call.
 */
export interface Config {
    /** Base URL of the Conduit hub, without a trailing slash. */
    baseUrl: string;
    /** API key sent as `X-API-Key` on every request. */
    apiKey: string;
    /**
     * Stable per-process id sent as `X-Session-Id`. Conduit records the calls
     * made under it so the user can see, in the Outbox provenance view, exactly
     * which agent session produced a queued action and what it read first.
     */
    sessionId: string;
    /** Per-request timeout in milliseconds. */
    timeoutMs: number;
}
/** Thrown for configuration problems the user must fix before we can start. */
export declare class ConfigError extends Error {
    constructor(message: string);
}
/**
 * Build the config from `env`, throwing {@link ConfigError} when a required
 * value is missing or malformed.
 */
export declare function loadConfig(env?: NodeJS.ProcessEnv): Config;
//# sourceMappingURL=config.d.ts.map