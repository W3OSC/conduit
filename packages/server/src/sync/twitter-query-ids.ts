/**
 * Self-healing GraphQL query-ID resolution for the X/Twitter web API.
 *
 * X ships its web client with per-operation GraphQL "query IDs" baked into the
 * JS bundles and rotates them at every client release. A stale ID gets a plain
 * HTTP 404 from `/i/api/graphql/<id>/<operation>` — which is how every
 * hardcoded-ID scraper (including agent-twitter-client) dies between releases.
 *
 * Instead of pinning IDs, this module discovers the current ones at runtime:
 *
 *   1. Fetch x.com/home with the user's session, collect the client JS bundle
 *      URLs (both the legacy `responsive-web/client-web` layout and the 2026
 *      `x-web` Vite-style layout), and scan them for
 *      `queryId:"...",operationName:"..."` pairs.
 *   2. If X's bundles yield nothing (layout changed again), fall back to the
 *      community-maintained TwitterInternalAPIDocument JSON, which publishes
 *      the same pairs.
 *
 * Discovered IDs are persisted (via injected load/save hooks) so a restart
 * doesn't re-scrape, and refreshed on demand when a call 404s — rate-limited
 * by a cooldown so a hard outage can't turn into a scrape loop.
 */

export type QueryIdMap = Record<string, string>;

/**
 * Last-known IDs, used only until the first successful discovery. All of
 * these were observed stale as of 2026-11-24 (X rebuilt its web client);
 * they exist so the resolver has something to try — and 404 on — before
 * the first refresh.
 */
export const DEFAULT_QUERY_IDS: QueryIdMap = {
  UserByScreenName: 'G3KGOASz96M-Qu0nwmGXNg',
  UserByRestId: 'xf3jd90KKBCUxdlI_tNHZw',
  Followers: '_wt2xR9Ozi8ZI7agzWf_bw',
  Following: 'j4s0ZOO_DvhECpS-2U-SUA',
  SearchTimeline: 'gkjsKepM6gl_HmFWoWKfgg',
  HomeTimeline: 'Fb7fyZ9MMCzvf_bNtwNdXA',
  UserTweets: 'V7H0Ap3_Hh2FyS75OCDO3Q',
  TweetDetail: 'xOhkmRac04YFZmOzU9PJHg',
};

const COMMUNITY_DOC_URL =
  'https://raw.githubusercontent.com/fa0311/TwitterInternalAPIDocument/master/docs/json/API.json';

/** Bundles to scan per refresh — X's client is split across many chunks. */
const MAX_BUNDLES = 24;
/** Minimum gap between two discovery attempts. */
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

// Both orders appear in X's bundles depending on the minifier's mood.
const PAIR_RE_A = /queryId\s*:\s*"([A-Za-z0-9_-]{15,30})"\s*,\s*operationName\s*:\s*"([A-Za-z0-9_]+)"/g;
const PAIR_RE_B = /operationName\s*:\s*"([A-Za-z0-9_]+)"\s*,\s*queryId\s*:\s*"([A-Za-z0-9_-]{15,30})"/g;

/** Scan one JS bundle's source for queryId/operationName pairs. */
export function extractQueryIdsFromJs(js: string): QueryIdMap {
  const ids: QueryIdMap = {};
  for (const m of js.matchAll(PAIR_RE_A)) ids[m[2]!] = m[1]!;
  for (const m of js.matchAll(PAIR_RE_B)) ids[m[1]!] = m[2]!;
  return ids;
}

/**
 * Pull queryId/operationName pairs out of the community API document. The
 * document's exact nesting has changed over time, so walk the whole tree for
 * any object carrying both keys rather than assuming a path.
 */
export function extractQueryIdsFromCommunityDoc(jsonText: string): QueryIdMap {
  const ids: QueryIdMap = {};
  let doc: unknown;
  try { doc = JSON.parse(jsonText); } catch { return ids; }
  const stack: unknown[] = [doc];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) { stack.push(...node); continue; }
    if (!node || typeof node !== 'object') continue;
    const rec = node as Record<string, unknown>;
    if (typeof rec['queryId'] === 'string' && typeof rec['operationName'] === 'string') {
      ids[rec['operationName']] = rec['queryId'];
    }
    stack.push(...Object.values(rec));
  }
  return ids;
}

/**
 * Collect client JS bundle URLs referenced by an x.com HTML page. Handles the
 * legacy responsive-web layout and the 2026 x-web layout.
 */
export function collectBundleUrls(html: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9_.~-]+\.js/g,
    /https:\/\/abs\.twimg\.com\/x-web\/[A-Za-z0-9/_.-]+\.js/g,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) urls.add(m[0]);
  }
  // main/entry bundles carry the bulk of the queryIds — scan them first.
  return [...urls].sort((a, b) => {
    const rank = (u: string) => (/\/(main|entry)[^/]*\.js$/.test(u) ? 0 : 1);
    return rank(a) - rank(b);
  });
}

/**
 * x-web entry bundles lazy-load hashed chunks via relative `assets/<id>.js`
 * imports; resolve them against the entry's directory so they can be scanned.
 */
export function collectRelativeAssetUrls(js: string, bundleUrl: string): string[] {
  const base = bundleUrl.slice(0, bundleUrl.lastIndexOf('/') + 1);
  const urls = new Set<string>();
  for (const m of js.matchAll(/"((?:\.\/)?assets\/[A-Za-z0-9_-]+\.js)"/g)) {
    urls.add(new URL(m[1]!.replace(/^\.\//, ''), base).toString());
  }
  return [...urls];
}

export interface QueryIdResolverOptions {
  /** Session-authenticated fetch for x.com pages (cookies improve what the HTML references). */
  sessionFetch: (url: string) => Promise<Response>;
  /** Plain fetch for public assets (abs.twimg.com, community doc). */
  plainFetch?: (url: string) => Promise<Response>;
  /** Load persisted IDs (e.g. from the settings table). */
  load?: () => QueryIdMap | null;
  /** Persist discovered IDs. */
  save?: (ids: QueryIdMap) => void;
  log?: (msg: string) => void;
}

export class QueryIdResolver {
  private overrides: QueryIdMap | null = null;
  private lastAttemptAt = 0;
  private inFlight: Promise<QueryIdMap | null> | null = null;
  private readonly opts: QueryIdResolverOptions;

  constructor(opts: QueryIdResolverOptions) {
    this.opts = opts;
  }

  /** Current best ID for an operation: discovered > persisted > built-in default. */
  get(operation: string): string {
    if (!this.overrides) this.overrides = this.opts.load?.() ?? {};
    return this.overrides[operation] ?? DEFAULT_QUERY_IDS[operation] ?? '';
  }

  /**
   * Called when a request with `get(operation)`'s ID came back 404. Runs a
   * discovery pass (cooldown-limited, single-flight) and returns the fresh ID
   * if one different from `staleId` was found, else null.
   */
  async reportStale(operation: string, staleId: string): Promise<string | null> {
    const refreshed = await this.refresh();
    if (!refreshed) return null;
    const next = this.get(operation);
    return next && next !== staleId ? next : null;
  }

  /** Run a discovery pass unless one ran recently. Returns the merged map or null. */
  async refresh(): Promise<QueryIdMap | null> {
    if (this.inFlight) return this.inFlight;
    if (Date.now() - this.lastAttemptAt < REFRESH_COOLDOWN_MS) return null;
    this.lastAttemptAt = Date.now();
    this.inFlight = this.discover().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.log(m)))(`[twitter] query-ids: ${msg}`);
  }

  private async discover(): Promise<QueryIdMap | null> {
    let found: QueryIdMap = {};
    try {
      found = await this.discoverFromXBundles();
    } catch (e) {
      this.log(`bundle scan failed: ${e instanceof Error ? e.message : e}`);
    }
    if (Object.keys(found).length === 0) {
      this.log('no IDs in X bundles, trying community API document');
      try {
        found = await this.discoverFromCommunityDoc();
      } catch (e) {
        this.log(`community doc fetch failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (Object.keys(found).length === 0) {
      this.log('discovery found nothing — keeping existing IDs');
      return null;
    }
    if (!this.overrides) this.overrides = this.opts.load?.() ?? {};
    this.overrides = { ...this.overrides, ...found };
    try { this.opts.save?.(this.overrides); } catch { /* persistence is best-effort */ }
    const known = Object.keys(DEFAULT_QUERY_IDS).filter((op) => found[op]);
    this.log(`discovered ${Object.keys(found).length} operation IDs (${known.length}/${Object.keys(DEFAULT_QUERY_IDS).length} known ops: ${known.join(', ') || 'none'})`);
    return this.overrides;
  }

  private async discoverFromXBundles(): Promise<QueryIdMap> {
    const plain = this.opts.plainFetch ?? fetch;
    const htmlRes = await this.opts.sessionFetch('https://x.com/home');
    if (!htmlRes.ok) throw new Error(`x.com/home returned ${htmlRes.status}`);
    const html = await htmlRes.text();

    const queue = collectBundleUrls(html);
    const ids: QueryIdMap = {};
    const seen = new Set<string>();
    let fetched = 0;
    while (queue.length > 0 && fetched < MAX_BUNDLES) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      let js: string;
      try {
        const res = await plain(url);
        if (!res.ok) continue;
        js = await res.text();
      } catch { continue; }
      fetched++;
      Object.assign(ids, extractQueryIdsFromJs(js));
      // Follow one level of lazy-loaded chunks from entry bundles.
      if (/\/(main|entry)[^/]*\.js$/.test(url)) {
        for (const child of collectRelativeAssetUrls(js, url)) {
          if (!seen.has(child)) queue.push(child);
        }
      }
    }
    return ids;
  }

  private async discoverFromCommunityDoc(): Promise<QueryIdMap> {
    const plain = this.opts.plainFetch ?? fetch;
    const res = await plain(COMMUNITY_DOC_URL);
    if (!res.ok) throw new Error(`community doc returned ${res.status}`);
    return extractQueryIdsFromCommunityDoc(await res.text());
  }
}

/**
 * X rejects GraphQL calls whose `features` map is missing newly-required
 * flags, with a 400 naming them. Parse the names so the caller can retry.
 */
export function parseMissingFeatures(body: string): string[] {
  const names = new Set<string>();
  // e.g. {"errors":[{"message":"The following features cannot be null: a, b, c"}]}
  for (const m of body.matchAll(/features cannot be null:\s*([A-Za-z0-9_,\s]+)/g)) {
    for (const name of m[1]!.split(',')) {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return [...names];
}
