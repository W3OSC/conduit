/**
 * `http` job execution — the workhorse of the M5 protocol. The cloud agent
 * dispatches a `job {jobId, kind:"http", method, path, body?}` frame; we
 * execute it against this same server's own REST API over localhost HTTP
 * (with the dedicated cloud-agent key from key.ts) and reply with
 * `job_result`. This carries the entire existing API surface with no
 * per-endpoint protocol work.
 */

export const API_PATH_PREFIX = '/api/';

/** Path allowlist: only this server's own /api/* routes are reachable. */
export function isAllowedJobPath(path: string | undefined): path is string {
  return typeof path === 'string' && path.startsWith(API_PATH_PREFIX);
}

export interface HttpJob {
  jobId: string;
  kind: 'http';
  method?: string;
  path: string;
  body?: unknown;
  /**
   * `"none"` executes the local fetch without the X-API-Key header. Conduit's
   * `uiOnlyAuth` endpoints (e.g. `chats/:source/:chatId/read`) reject any
   * request carrying an API key outright, so Meridian's bridge marks those
   * jobs keyless rather than failing every call through it. Absent (the
   * default) keeps the key attached, unchanged from before this field existed.
   */
  auth?: 'none';
}

export interface JobResultOk {
  jobId: string;
  ok: true;
  status: number;
  body: unknown;
}

export interface JobResultErr {
  jobId: string;
  ok: false;
  error: string;
}

export type JobResult = JobResultOk | JobResultErr;

export const JOB_TIMEOUT_MS = 60_000;

/** True for "application/json", "application/vnd.api+json", etc. */
export function isJsonContentType(contentType: string): boolean {
  return /json/i.test(contentType);
}

/** True for "text/plain", "text/html; charset=utf-8", etc. */
export function isTextContentType(contentType: string): boolean {
  return /^text\//i.test(contentType.trim());
}

/**
 * Run one `http` job against `http://127.0.0.1:<port><path>` and return its
 * job_result. Never throws — all failure modes (bad path, network error,
 * timeout) resolve to a `{ok: false, error}` result so the caller can always
 * reply to the cloud.
 *
 * JSON and text/* responses are parsed/passed through as before. Anything
 * else (e.g. the gdrive download endpoint returning a file) is binary —
 * reading it as text would mangle the bytes — so it comes back as
 * `{bodyBase64, contentType}` instead.
 */
export async function executeHttpJob(job: HttpJob, port: number, apiKey: string): Promise<JobResult> {
  if (!isAllowedJobPath(job.path)) {
    return { jobId: job.jobId, ok: false, error: `Rejected: path must start with ${API_PATH_PREFIX} (got "${job.path ?? ''}")` };
  }

  const method = (job.method || 'GET').toUpperCase();
  const url = `http://127.0.0.1:${port}${job.path}`;

  // `body: null` on the wire means "no body" (clouds predating the omit-body
  // fix send it on every GET), and fetch rejects ANY body on GET/HEAD
  // ("Request with GET/HEAD method cannot have body") — so a body is only
  // ever attached when it is both present and legal for the method.
  const hasBody = job.body !== undefined && job.body !== null && method !== 'GET' && method !== 'HEAD';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(job.auth === 'none' ? {} : { 'X-API-Key': apiKey }),
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(job.body) } : {}),
      signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
    });

    const contentType = res.headers.get('content-type') || '';
    let body: unknown;
    if (contentType && !isJsonContentType(contentType) && !isTextContentType(contentType)) {
      const bytes = Buffer.from(await res.arrayBuffer());
      body = { bodyBase64: bytes.toString('base64'), contentType };
    } else {
      const text = await res.text();
      body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    }

    return { jobId: job.jobId, ok: true, status: res.status, body };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const error = timedOut
      ? `Job timed out after ${JOB_TIMEOUT_MS}ms (${method} ${job.path})`
      : e instanceof Error
        ? e.message
        : String(e);
    return { jobId: job.jobId, ok: false, error };
  }
}
