/**
 * OpenAPI generation from the zod schemas the routes actually validate with.
 *
 * Every route that has been migrated to `validate.ts` also calls
 * `documentRoute(...)` next to its handler. Those registrations are collected
 * here and rendered to OpenAPI 3 path items by `@asteasolutions/zod-to-openapi`.
 *
 * `openapi.ts` then MERGES the generated entries over its hand-written `paths`
 * object rather than replacing it:
 *
 *   • a path/method present in both  → the hand-written prose (summary,
 *     description, responses, operationId) is kept, and the generated
 *     `parameters` / `requestBody` win, because those are derived from the code
 *     that runs;
 *   • a path/method only in the registry → added wholesale;
 *   • a path/method only hand-written  → left untouched (not yet migrated).
 *
 * This is incremental by design: migrating a route to zod automatically
 * upgrades its documentation, and `src/__tests__/openapi-drift.test.ts` fails
 * the build if the two sides ever disagree about which endpoints exist.
 */

import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import type { z } from './validate.js';

export const registry = new OpenAPIRegistry();

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Anything zod-to-openapi accepts as a parameter container. */
type ParameterObjectSchema = Parameters<typeof registry.registerPath>[0] extends {
  request?: { query?: infer Q };
}
  ? Q
  : never;

export interface RouteDoc {
  method: Method;
  /** OpenAPI-style path relative to the /api base, e.g. `/gmail/messages/{id}`. */
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  query?: ParameterObjectSchema;
  params?: ParameterObjectSchema;
  /** Request body schema (JSON). */
  body?: z.ZodType;
  bodyDescription?: string;
  bodyRequired?: boolean;
  responses?: RouteConfig['responses'];
}

const DEFAULT_RESPONSES: RouteConfig['responses'] = {
  200: { description: 'Successful response' },
};

/**
 * Register a route's parameter/body schemas so they appear in the served spec.
 * Called from the route module itself, right where the middleware is wired up,
 * so the two can never drift apart.
 */
export function documentRoute(doc: RouteDoc): void {
  const request: RouteConfig['request'] = {};
  if (doc.query) request.query = doc.query;
  if (doc.params) request.params = doc.params;
  if (doc.body) {
    request.body = {
      description: doc.bodyDescription,
      required: doc.bodyRequired ?? true,
      content: { 'application/json': { schema: doc.body } },
    };
  }

  registry.registerPath({
    method: doc.method,
    path: doc.path,
    ...(doc.summary ? { summary: doc.summary } : {}),
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.operationId ? { operationId: doc.operationId } : {}),
    ...(doc.tags ? { tags: doc.tags } : {}),
    ...(Object.keys(request).length ? { request } : {}),
    responses: doc.responses ?? DEFAULT_RESPONSES,
  });
}

// ── Generation ───────────────────────────────────────────────────────────────

type PathItem = Record<string, unknown>;
type Paths = Record<string, PathItem>;

interface Generated {
  paths: Paths;
  schemas: Record<string, unknown>;
}

let cache: Generated | null = null;

/**
 * Render the registry to OpenAPI 3 path items. Memoised: the registry is
 * populated at module-load time and never changes afterwards.
 */
export function generateFromRegistry(): Generated {
  if (cache) return cache;
  const generator = new OpenApiGeneratorV3(registry.definitions);
  // info/openapi here are throwaway — only `paths` and `components` are used;
  // the served document keeps its own hand-written metadata.
  const doc = generator.generateDocument({
    openapi: '3.0.0',
    info: { title: 'Conduit', version: '1.0.0' },
  }) as unknown as { paths?: Paths; components?: { schemas?: Record<string, unknown> } };

  const paths = doc.paths ?? {};

  // OpenAPI 3 requires every path parameter to be `required: true`. Schemas
  // like `wildcardPath` are optional in zod terms (Express may hand us an empty
  // capture), which the generator faithfully reports as `required: false` —
  // valid zod, invalid OpenAPI. Normalise it here rather than distorting the
  // runtime schema.
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      const parameters = (op as { parameters?: Array<{ in?: string; required?: boolean }> })?.parameters;
      if (!Array.isArray(parameters)) continue;
      for (const parameter of parameters) {
        if (parameter?.in === 'path') parameter.required = true;
      }
    }
  }

  cache = {
    paths,
    schemas: doc.components?.schemas ?? {},
  };
  return cache;
}

/**
 * Merge generated path items over a hand-written `paths` object.
 *
 * Generated `parameters` / `requestBody` replace the hand-written ones (they
 * are derived from the validator that actually runs). Everything else on an
 * existing operation — summary, description, operationId, responses — is
 * preserved, because that prose is what makes the spec useful to agents and
 * cannot be derived from a schema.
 */
export function mergeGeneratedPaths(handwritten: Paths): Paths {
  const { paths: generated } = generateFromRegistry();
  const merged: Paths = { ...handwritten };

  for (const [path, generatedItem] of Object.entries(generated)) {
    const existingItem = merged[path];
    if (!existingItem) {
      merged[path] = { ...generatedItem };
      continue;
    }

    const item: PathItem = { ...existingItem };
    for (const [method, generatedOp] of Object.entries(generatedItem)) {
      const existingOp = item[method] as Record<string, unknown> | undefined;
      if (!existingOp) {
        item[method] = generatedOp;
        continue;
      }
      const op = generatedOp as Record<string, unknown>;
      const next: Record<string, unknown> = { ...existingOp };
      if (op['parameters'] !== undefined) next['parameters'] = op['parameters'];
      if (op['requestBody'] !== undefined) next['requestBody'] = op['requestBody'];
      // Fill in prose the hand-written entry never had.
      for (const key of ['summary', 'description', 'operationId', 'tags'] as const) {
        if (next[key] === undefined && op[key] !== undefined) next[key] = op[key];
      }
      item[method] = next;
    }
    merged[path] = item;
  }

  return merged;
}

/** Component schemas produced by the registry, merged over the hand-written ones. */
export function mergeGeneratedSchemas(
  handwritten: Record<string, unknown>,
): Record<string, unknown> {
  const { schemas } = generateFromRegistry();
  return { ...handwritten, ...schemas };
}
