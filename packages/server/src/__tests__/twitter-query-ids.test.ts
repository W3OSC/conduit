/**
 * Self-healing X GraphQL query-ID resolution: bundle scanning, community-doc
 * fallback, and the stale-ID refresh flow that un-breaks reads when X rotates
 * its client (the Nov 2026 rotation 404'd every hardcoded-ID scraper).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QUERY_IDS,
  QueryIdResolver,
  collectBundleUrls,
  collectRelativeAssetUrls,
  extractQueryIdsFromCommunityDoc,
  extractQueryIdsFromJs,
  parseMissingFeatures,
} from '../sync/twitter-query-ids.js';

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBB_bbbbbbbbbb-';

describe('extractQueryIdsFromJs', () => {
  it('reads pairs in both minifier orders', () => {
    const js = `e.exports={queryId:"${ID_A}",operationName:"Followers",operationType:"query"};` +
      `t.exports={operationName:"UserByScreenName",queryId:"${ID_B}"}`;
    expect(extractQueryIdsFromJs(js)).toEqual({ Followers: ID_A, UserByScreenName: ID_B });
  });

  it('ignores short or malformed ids', () => {
    expect(extractQueryIdsFromJs('queryId:"short",operationName:"Followers"')).toEqual({});
  });
});

describe('extractQueryIdsFromCommunityDoc', () => {
  it('finds pairs at any nesting depth', () => {
    const doc = JSON.stringify({
      graphql: { get: [{ queryId: ID_A, operationName: 'Followers' }] },
      other: { deep: { queryId: ID_B, operationName: 'SearchTimeline' } },
    });
    expect(extractQueryIdsFromCommunityDoc(doc)).toEqual({ Followers: ID_A, SearchTimeline: ID_B });
  });

  it('returns empty on invalid JSON', () => {
    expect(extractQueryIdsFromCommunityDoc('not json')).toEqual({});
  });
});

describe('collectBundleUrls', () => {
  it('collects both client layouts and ranks main/entry bundles first', () => {
    const html = `
      <script src="https://abs.twimg.com/x-web/x-web/chunk-abc.js"></script>
      <script src="https://abs.twimg.com/responsive-web/client-web/main.123abc.js"></script>
      <script src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-_18.js"></script>`;
    const urls = collectBundleUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toMatch(/\/(main|entry)/);
    expect(urls[1]).toMatch(/\/(main|entry)/);
  });
});

describe('collectRelativeAssetUrls', () => {
  it('resolves lazy chunk refs against the entry bundle directory', () => {
    const urls = collectRelativeAssetUrls(
      'import("./assets/BPbj-EJA.js");x("assets/KWCqqJ3h.js")',
      'https://abs.twimg.com/x-web/x-web/entry-client.js',
    );
    expect(urls).toContain('https://abs.twimg.com/x-web/x-web/assets/BPbj-EJA.js');
    expect(urls).toContain('https://abs.twimg.com/x-web/x-web/assets/KWCqqJ3h.js');
  });
});

describe('parseMissingFeatures', () => {
  it('parses the names X lists in a 400 body', () => {
    const body = JSON.stringify({ errors: [{ message: 'The following features cannot be null: foo_enabled, bar_enabled' }] });
    expect(parseMissingFeatures(body)).toEqual(['foo_enabled', 'bar_enabled']);
  });

  it('returns empty for unrelated errors', () => {
    expect(parseMissingFeatures('{"errors":[{"message":"Rate limit exceeded"}]}')).toEqual([]);
  });
});

function makeResolver(overrides: {
  html?: string;
  bundles?: Record<string, string>;
  communityDoc?: string;
  load?: () => Record<string, string> | null;
  save?: (ids: Record<string, string>) => void;
}) {
  const sessionFetch = vi.fn(async () => new Response(overrides.html ?? '', { status: overrides.html === undefined ? 500 : 200 }));
  const plainFetch = vi.fn(async (url: string) => {
    if (overrides.bundles && url in overrides.bundles) return new Response(overrides.bundles[url]);
    if (overrides.communityDoc !== undefined && url.includes('TwitterInternalAPIDocument')) return new Response(overrides.communityDoc);
    return new Response('', { status: 404 });
  });
  const resolver = new QueryIdResolver({
    sessionFetch,
    plainFetch,
    load: overrides.load ?? (() => null),
    save: overrides.save ?? (() => {}),
    log: () => {},
  });
  return { resolver, sessionFetch, plainFetch };
}

describe('QueryIdResolver', () => {
  it('falls back default → persisted → discovered', async () => {
    const { resolver } = makeResolver({ load: () => ({ Followers: ID_B }) });
    expect(resolver.get('Followers')).toBe(ID_B);
    expect(resolver.get('Following')).toBe(DEFAULT_QUERY_IDS['Following']);
  });

  it('reportStale discovers a fresh id from X bundles and persists it', async () => {
    const bundleUrl = 'https://abs.twimg.com/responsive-web/client-web/main.1.js';
    const saved: Record<string, string>[] = [];
    const { resolver } = makeResolver({
      html: `<script src="${bundleUrl}"></script>`,
      bundles: { [bundleUrl]: `{queryId:"${ID_A}",operationName:"Followers",operationType:"query"}` },
      save: (ids) => saved.push(ids),
    });
    const fresh = await resolver.reportStale('Followers', DEFAULT_QUERY_IDS['Followers']!);
    expect(fresh).toBe(ID_A);
    expect(resolver.get('Followers')).toBe(ID_A);
    expect(saved.at(-1)).toMatchObject({ Followers: ID_A });
  });

  it('falls back to the community doc when X bundles yield nothing', async () => {
    const { resolver } = makeResolver({
      html: '<html>no bundles here</html>',
      communityDoc: JSON.stringify([{ queryId: ID_B, operationName: 'UserByScreenName' }]),
    });
    const fresh = await resolver.reportStale('UserByScreenName', DEFAULT_QUERY_IDS['UserByScreenName']!);
    expect(fresh).toBe(ID_B);
  });

  it('returns null when the rotated id matches what we already had', async () => {
    const bundleUrl = 'https://abs.twimg.com/responsive-web/client-web/main.1.js';
    const staleId = DEFAULT_QUERY_IDS['Followers']!;
    const { resolver } = makeResolver({
      html: `<script src="${bundleUrl}"></script>`,
      bundles: { [bundleUrl]: `{queryId:"${staleId}",operationName:"Followers"}` },
    });
    expect(await resolver.reportStale('Followers', staleId)).toBeNull();
  });

  it('cooldown blocks back-to-back discovery attempts', async () => {
    const { resolver, sessionFetch } = makeResolver({ html: '<html></html>', communityDoc: '{}' });
    await resolver.refresh();
    const second = await resolver.refresh();
    expect(second).toBeNull();
    expect(sessionFetch).toHaveBeenCalledTimes(1);
  });

  it('follows lazy chunks referenced by entry bundles', async () => {
    const entryUrl = 'https://abs.twimg.com/x-web/x-web/entry-client.js';
    const chunkUrl = 'https://abs.twimg.com/x-web/x-web/assets/Chunk1.js';
    const { resolver } = makeResolver({
      html: `<script src="${entryUrl}"></script>`,
      bundles: {
        [entryUrl]: 'import("./assets/Chunk1.js")',
        [chunkUrl]: `{queryId:"${ID_A}",operationName:"SearchTimeline"}`,
      },
    });
    const fresh = await resolver.reportStale('SearchTimeline', DEFAULT_QUERY_IDS['SearchTimeline']!);
    expect(fresh).toBe(ID_A);
  });
});
