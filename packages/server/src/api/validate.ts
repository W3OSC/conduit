/**
 * Zod-backed request validation for the Conduit API.
 *
 * Three middleware factories — `validateQuery`, `validateBody`, `validateParams`
 * — parse the corresponding part of the request, replace it with the parsed
 * (typed, coerced, defaulted) value, and on failure respond `400` with the
 * codebase's existing error shape: `{ error: string }`.
 *
 *   router.get('/messages',
 *     validateQuery(MessagesQuery),
 *     (req, res) => {
 *       const q = queryOf(MessagesQuery, req);   // fully typed, already coerced
 *     });
 *
 * The same schema objects feed `openapi-registry.ts`, so a route's parameter
 * documentation is generated from the code that actually validates it — that is
 * what stops the spec drifting away from the implementation.
 *
 * ── Permissiveness ───────────────────────────────────────────────────────────
 * This module is hardening, not a behaviour change. Where a handler previously
 * coerced garbage into a default (`Math.min(parseInt(limit) || 50, 200)`), the
 * schema does exactly the same thing rather than rejecting the request. Only
 * input the handler would genuinely have mishandled (an unparseable `since`
 * that used to reach raw SQL, an unknown `source` that used to silently return
 * an empty list) is hard-rejected.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// Must run before any `.openapi()` call anywhere in the codebase.
extendZodWithOpenApi(z);

export { z };

/** Any schema usable as a query/body/params validator. */
export type RequestSchema = z.ZodType;

// ── Error formatting ─────────────────────────────────────────────────────────

/**
 * Zod's own default messages ("Invalid input: expected number, received NaN")
 * read badly in an API error. When a schema author has NOT supplied a custom
 * message we synthesise a short human phrase from the issue instead.
 */
const ZOD_DEFAULT_MESSAGE = /^(Invalid input|Invalid option|Invalid key|Invalid value|Too small|Too big|Unrecognized key|Invalid string)/;

function phraseFor(issue: z.core.$ZodIssue): string {
  if (issue.message && !ZOD_DEFAULT_MESSAGE.test(issue.message)) return issue.message;

  switch (issue.code) {
    case 'invalid_type':
      return `must be a ${String(issue.expected)}`;
    case 'too_small':
      return (issue as { inclusive?: boolean }).inclusive === false
        ? `must be greater than ${String(issue.minimum)}`
        : `must be at least ${String(issue.minimum)}`;
    case 'too_big':
      return (issue as { inclusive?: boolean }).inclusive === false
        ? `must be less than ${String(issue.maximum)}`
        : `must be at most ${String(issue.maximum)}`;
    case 'invalid_value': {
      const values = (issue as { values?: readonly unknown[] }).values ?? [];
      return values.length
        ? `must be one of: ${values.map(String).join(', ')}`
        : 'is not an allowed value';
    }
    case 'invalid_format':
      return `must be a valid ${String((issue as { format?: string }).format ?? 'value')}`;
    case 'unrecognized_keys': {
      const keys = (issue as { keys?: string[] }).keys ?? [];
      return keys.length
        ? `unknown field${keys.length > 1 ? 's' : ''}: ${keys.join(', ')}`
        : 'is not a recognised field';
    }
    default:
      return issue.message || 'is invalid';
  }
}

/**
 * Render a zod error as the one-line readable summary the API returns, e.g.
 * `Invalid query: limit must be a number, since must be an ISO-8601 datetime`.
 */
export function formatZodError(part: 'query' | 'body' | 'params', error: z.ZodError): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    const text = path ? `${path} ${phraseFor(issue)}` : phraseFor(issue);
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return `Invalid ${part}: ${parts.join(', ') || 'request could not be parsed'}`;
}

// ── Middleware factories ─────────────────────────────────────────────────────

/**
 * `req.query` is a prototype getter in Express 5 and cannot be plainly
 * assigned; `req.params` is re-assigned by the router per layer but is stable
 * for the duration of a single route's handler chain. `defineProperty` works
 * for all three.
 */
function replace(req: Request, key: 'query' | 'body' | 'params', value: unknown): void {
  Object.defineProperty(req, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function makeValidator(part: 'query' | 'body' | 'params') {
  return <S extends RequestSchema>(schema: S): RequestHandler =>
    (req: Request, res: Response, next: NextFunction): void => {
      const input = part === 'body' ? (req.body ?? {}) : req[part];
      const result = schema.safeParse(input);
      if (!result.success) {
        res.status(400).json({ error: formatZodError(part, result.error) });
        return;
      }
      replace(req, part, result.data);
      next();
    };
}

/** Validate + coerce `req.query`, replacing it with the parsed result. */
export const validateQuery = makeValidator('query');
/** Validate + coerce `req.body`, replacing it with the parsed result. */
export const validateBody = makeValidator('body');
/** Validate + coerce `req.params`, replacing it with the parsed result. */
export const validateParams = makeValidator('params');

// ── Typed accessors ──────────────────────────────────────────────────────────
//
// Express's own types cannot carry a per-middleware generic through
// `router.get(path, mw, handler)`, so handlers read the validated value back
// through these one-line helpers. They are pure casts — the middleware has
// already produced exactly this value — but they give full inference from the
// schema with no hand-written interfaces to drift.

/** Typed view of `req.query` after `validateQuery(schema)`. */
export function queryOf<S extends RequestSchema>(_schema: S, req: Request): z.infer<S> {
  return req.query as z.infer<S>;
}

/** Typed view of `req.body` after `validateBody(schema)`. */
export function bodyOf<S extends RequestSchema>(_schema: S, req: Request): z.infer<S> {
  return req.body as z.infer<S>;
}

/** Typed view of `req.params` after `validateParams(schema)`. */
export function paramsOf<S extends RequestSchema>(_schema: S, req: Request): z.infer<S> {
  return req.params as unknown as z.infer<S>;
}

// ── Shared reusable schemas ──────────────────────────────────────────────────

/**
 * An ISO-8601 datetime string, validated with the same `Date.parse` the
 * handlers already used so no previously-accepted timestamp starts failing.
 * The value stays a **string** (never a Date) because several handlers compare
 * it directly against ISO columns and one interpolates it into `sql.raw`.
 */
export const isoDateTime = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)), { error: 'must be an ISO-8601 datetime' })
  .openapi({ type: 'string', format: 'date-time', example: '2024-01-01T00:00:00.000Z' });

/**
 * Lenient integer coercion that reproduces the `Math.min(parseInt(x) || D, M)`
 * idiom this codebase repeats ~12 times: unparseable (or zero) input falls back
 * to the default rather than 400ing, and the result is clamped into
 * `[min, max]`. Clamping is the one deviation — a negative `limit` previously
 * reached SQLite as "no limit at all".
 */
function clampedInt(opts: { fallback: number; min: number; max: number; description: string }) {
  const { fallback, min, max, description } = opts;
  return z
    .unknown()
    .optional()
    .transform((raw) => {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
      const base = Number.isFinite(n) && n !== 0 ? Math.trunc(n) : fallback;
      return Math.min(Math.max(base, min), max);
    })
    .openapi({
      type: 'integer',
      default: fallback,
      minimum: min,
      // UNBOUNDED routes have no documented ceiling — emitting
      // `maximum: 9007199254740991` would be noise in the spec.
      ...(max === UNBOUNDED ? {} : { maximum: max }),
      description,
    });
}

/** Sentinel for "this route never capped the value". */
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * The same lenient-coerce-and-clamp behaviour for any bounded integer query
 * param that is not a page size (e.g. digest's `meetings_days`).
 */
export function boundedInt(opts: {
  default: number;
  min?: number;
  max: number;
  description: string;
}) {
  return clampedInt({
    fallback: opts.default,
    min: opts.min ?? 1,
    max: opts.max,
    description: opts.description,
  });
}

/** `limit` alone, with this route's own default and cap. */
export function limitSchema(defaultLimit: number, maxLimit: number) {
  return clampedInt({
    fallback: defaultLimit,
    min: 1,
    max: maxLimit,
    description: `Maximum number of items to return (default ${defaultLimit}, max ${maxLimit}).`,
  });
}

/** `offset` alone. */
export function offsetSchema() {
  return clampedInt({
    fallback: 0,
    min: 0,
    max: UNBOUNDED,
    description: 'Number of items to skip (default 0).',
  });
}

/**
 * The `limit` / `offset` pair. Every call site passes the cap that route
 * already enforced, so pagination behaviour is unchanged — only centralised.
 */
export function paginationSchema(defaultLimit: number, maxLimit: number) {
  return { limit: limitSchema(defaultLimit, maxLimit), offset: offsetSchema() };
}

/**
 * An optional enum query filter. An absent OR empty (`?source=`) value means
 * "no filter", which is what `if (source)` did before — only a non-empty value
 * that is not a member is rejected.
 */
export function optionalEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  meta: { description?: string } = {},
) {
  return z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.enum(values).optional(),
    )
    .openapi({ type: 'string', enum: [...values], ...meta });
}

/** Sources that carry messages — the enum used across /messages, /search, /activity. */
export const MESSAGE_SOURCES = ['slack', 'discord', 'telegram', 'twitter', 'gmail'] as const;
export type MessageSource = typeof MESSAGE_SOURCES[number];

export const messageSourceSchema = z
  .enum(MESSAGE_SOURCES)
  .openapi({ description: 'Which connected platform to read from.' });

/** `messageSourceSchema` as an optional, empty-string-tolerant query filter. */
export const optionalMessageSource = optionalEnum(MESSAGE_SOURCES, {
  description: 'Which connected platform to read from. Omit for all platforms.',
});

/** Every service Conduit can be granted permissions for. */
export const SERVICE_SOURCES = [
  'slack', 'discord', 'telegram', 'gmail', 'calendar',
  'twitter', 'notion', 'obsidian', 'smb', 'gdrive',
] as const;
export type ServiceSource = typeof SERVICE_SOURCES[number];

export const serviceSourceSchema = z
  .enum(SERVICE_SOURCES)
  .openapi({ description: 'A connected Conduit service.' });

/**
 * A `?flag=true` style query switch. Anything other than the literal string
 * `true` is false — exactly what `req.query.x === 'true'` did.
 */
export const booleanFlag = z
  .unknown()
  .optional()
  .transform((v) => v === true || v === 'true')
  .openapi({ type: 'boolean', default: false });

/**
 * A numeric path parameter. Rejects non-numeric ids, which every affected
 * handler already did by hand (`isNaN(id)` → 400 "Invalid … id").
 */
export function intParam(name: string) {
  return z
    .string()
    .regex(/^-?\d+$/, { error: `must be an integer ${name} id` })
    .transform((v) => parseInt(v, 10))
    .openapi({ type: 'integer' });
}

/**
 * An optional integer query param with no default — absent or unparseable
 * yields `undefined`, which is what `x ? parseInt(x) : undefined` produced
 * (minus the NaN that used to leak through).
 */
export function optionalInt(description?: string) {
  return z
    .unknown()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw === null || raw === '') return undefined;
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      return Number.isFinite(n) ? Math.trunc(n) : undefined;
    })
    .openapi({ type: 'integer', ...(description ? { description } : {}) });
}

/**
 * A `*name` wildcard path segment.
 *
 * Express 5 (path-to-regexp v8) exposes a wildcard capture as a **string[] of
 * decoded segments**, not a string. Every consumer in this codebase read it as
 * a string, so `GET /…/files/dir/sub/note.md` silently became the literal path
 * `"dir,sub,note.md"` via array→string coercion. Joining on `/` restores the
 * intended path and is a no-op for the single-segment, percent-encoded form
 * (`dir%2Fsub%2Fnote.md`) the UI sends.
 */
export const wildcardPath = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (Array.isArray(v) ? v.join('/') : v ?? ''))
  .openapi({ type: 'string' });

/**
 * A non-empty string field. Deliberately does NOT trim — outbox `content` and
 * search `q` were never trimmed, and silently eating leading whitespace from a
 * queued message would be a real behaviour change. Use `trimmedString` for the
 * fields whose handlers already called `.trim()`.
 */
export function requiredString(_field: string) {
  return z
    .string({ error: 'is required' })
    .min(1, { error: 'is required' });
}

/** A non-empty string that is trimmed first — for handlers that already did. */
export function trimmedString(_field: string) {
  return z
    .string({ error: 'is required' })
    .trim()
    .min(1, { error: 'is required' });
}
