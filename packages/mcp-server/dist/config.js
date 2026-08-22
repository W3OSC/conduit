/**
 * Environment-derived configuration for the Conduit MCP server.
 *
 * Everything is read once at startup so a misconfigured environment fails
 * immediately with an actionable message rather than surfacing as a confusing
 * 401 on the agent's first tool call.
 */
import { randomUUID } from 'node:crypto';
/** Thrown for configuration problems the user must fix before we can start. */
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}
const DEFAULT_BASE_URL = 'http://localhost:3101';
const DEFAULT_TIMEOUT_MS = 30_000;
function readTimeout(raw) {
    if (!raw)
        return DEFAULT_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ConfigError(`CONDUIT_TIMEOUT_MS must be a positive number of milliseconds (got "${raw}").`);
    }
    return parsed;
}
function readBaseUrl(raw) {
    const value = (raw ?? DEFAULT_BASE_URL).trim();
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new ConfigError(`CONDUIT_URL must be an absolute URL such as ${DEFAULT_BASE_URL} (got "${value}").`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ConfigError(`CONDUIT_URL must use http or https (got "${parsed.protocol}//").`);
    }
    return value.replace(/\/+$/, '');
}
/**
 * Build the config from `env`, throwing {@link ConfigError} when a required
 * value is missing or malformed.
 */
export function loadConfig(env = process.env) {
    const apiKey = env['CONDUIT_API_KEY']?.trim();
    if (!apiKey) {
        throw new ConfigError('CONDUIT_API_KEY is not set.\n' +
            '\n' +
            'The Conduit MCP server needs an API key to talk to your Conduit hub.\n' +
            'Create one in the Conduit UI under Settings -> API Keys (grant it only\n' +
            'the services and permissions this agent should have), then expose it to\n' +
            'this server, e.g. in your MCP client config:\n' +
            '\n' +
            '  "env": {\n' +
            `    "CONDUIT_URL": "${DEFAULT_BASE_URL}",\n` +
            '    "CONDUIT_API_KEY": "<your-key>"\n' +
            '  }\n');
    }
    return {
        baseUrl: readBaseUrl(env['CONDUIT_URL']),
        apiKey,
        sessionId: env['CONDUIT_SESSION_ID']?.trim() || `mcp-${randomUUID()}`,
        timeoutMs: readTimeout(env['CONDUIT_TIMEOUT_MS']),
    };
}
//# sourceMappingURL=config.js.map