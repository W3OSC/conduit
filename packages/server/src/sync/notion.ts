/**
 * NotionSync — @notionhq/client integration.
 *
 * Passthrough only: no local data sync. All operations are live Notion API
 * calls. Reads bypass the outbox (executed directly). Writes go through the
 * outbox and are executed on approval.
 *
 * Auth: Internal integration token stored in settings under `credentials.notion`.
 *
 * SDK note: this uses @notionhq/client v3+. The v3 SDK renamed `databases.query`
 * to `dataSources.query` and the search filter value `'database'` to `'data_source'`.
 */

import { Client, APIErrorCode, isNotionClientError } from '@notionhq/client';
import type {
  CreatePageParameters,
  UpdatePageParameters,
  AppendBlockChildrenParameters,
  QueryDataSourceParameters,
  SearchParameters,
} from '@notionhq/client/build/src/api-endpoints.js';

export interface NotionCreds {
  token: string;
  workspaceName?: string;
  botId?: string;
}

// ── Write actions (go through outbox) ────────────────────────────────────────

export type NotionWriteAction =
  | {
      action: 'create_page';
      /** ID of the parent data source (database) or page */
      parentId: string;
      parentType: 'data_source' | 'page';
      /** Notion page properties as per the API spec (plain objects) */
      properties: Record<string, unknown>;
      /** Optional array of block children */
      children?: unknown[];
    }
  | {
      action: 'update_page';
      pageId: string;
      /** Properties to update */
      properties: Record<string, unknown>;
      /** Set to true to move to trash */
      in_trash?: boolean;
    }
  | {
      action: 'append_blocks';
      /** Page or block ID to append children to */
      blockId: string;
      /** Array of block objects */
      children: unknown[];
    }
  | {
      action: 'archive_page';
      pageId: string;
    };

// ── Read actions (bypass outbox, executed directly) ───────────────────────────

export type NotionReadAction =
  | { action: 'retrieve_page'; pageId: string }
  | {
      action: 'query_database';
      /** The data source (database) ID to query */
      databaseId: string;
      filter?: unknown;
      sorts?: unknown[];
      pageSize?: number;
      startCursor?: string;
    }
  | {
      action: 'search';
      query: string;
      filter?: { property: 'object'; value: 'page' | 'data_source' };
      sort?: { timestamp: 'last_edited_time'; direction: 'ascending' | 'descending' };
      pageSize?: number;
      startCursor?: string;
    }
  | { action: 'list_databases' }
  | { action: 'retrieve_block'; blockId: string }
  | { action: 'retrieve_block_children'; blockId: string; pageSize?: number; startCursor?: string };

// ── NotionSync class ──────────────────────────────────────────────────────────

export class NotionSync {
  private client: Client | null = null;
  public connected = false;
  public accountInfo: { userId: string; displayName: string; workspaceName?: string } | null = null;

  async connect(creds: NotionCreds): Promise<boolean> {
    if (!creds.token) return false;
    try {
      const client = new Client({ auth: creds.token });

      // Verify token by fetching the bot user
      const me = await client.users.me({});
      const userId = me.id;
      const displayName = ('name' in me && me.name) ? me.name : 'Notion Bot';
      const workspaceName = creds.workspaceName
        || ('workspace_name' in me ? (me as unknown as { workspace_name?: string }).workspace_name : undefined);

      this.client = client;
      this.accountInfo = { userId, displayName, workspaceName };
      this.connected = true;
      console.log(`[notion] Connected as "${displayName}" (${userId})`);
      return true;
    } catch (e) {
      this.connected = false;
      this.client = null;
      this.accountInfo = null;
      console.error('[notion] Connection failed:', e);
      return false;
    }
  }

  disconnect(): void {
    this.client = null;
    this.connected = false;
    this.accountInfo = null;
  }

  private assertConnected(): Client {
    if (!this.client) throw new Error('Notion not connected');
    return this.client;
  }

  // ── Write actions (called on outbox approval) ─────────────────────────────

  async executeAction(action: NotionWriteAction): Promise<string> {
    const client = this.assertConnected();

    switch (action.action) {
      case 'create_page': {
        const parent = action.parentType === 'data_source'
          ? { database_id: action.parentId }
          : { page_id: action.parentId };
        const params: CreatePageParameters = {
          parent: parent as CreatePageParameters['parent'],
          properties: action.properties as CreatePageParameters['properties'],
        };
        if (action.children) {
          params.children = action.children as CreatePageParameters['children'];
        }
        const result = await client.pages.create(params);
        return JSON.stringify({ pageId: result.id, url: ('url' in result) ? result.url : undefined });
      }

      case 'update_page': {
        const params: UpdatePageParameters = {
          page_id: action.pageId,
          properties: action.properties as UpdatePageParameters['properties'],
        };
        if (action.in_trash !== undefined) {
          params.in_trash = action.in_trash;
        }
        const result = await client.pages.update(params);
        const inTrash = ('in_trash' in result) ? result.in_trash : undefined;
        return JSON.stringify({ pageId: result.id, in_trash: inTrash });
      }

      case 'append_blocks': {
        const params: AppendBlockChildrenParameters = {
          block_id: action.blockId,
          children: action.children as AppendBlockChildrenParameters['children'],
        };
        const result = await client.blocks.children.append(params);
        return JSON.stringify({ results: (result.results || []).map((b) => b.id) });
      }

      case 'archive_page': {
        const result = await client.pages.update({
          page_id: action.pageId,
          in_trash: true,
        });
        const inTrash = ('in_trash' in result) ? result.in_trash : true;
        return JSON.stringify({ pageId: result.id, in_trash: inTrash });
      }

      default: {
        const _exhaustive: never = action;
        throw new Error(`Unknown Notion action: ${(_exhaustive as NotionWriteAction).action}`);
      }
    }
  }

  // ── Read operations (direct, bypass outbox) ───────────────────────────────

  async executeRead(action: NotionReadAction): Promise<unknown> {
    const client = this.assertConnected();

    switch (action.action) {
      case 'retrieve_page':
        return client.pages.retrieve({ page_id: action.pageId });

      case 'query_database': {
        // In SDK v3, database querying is via dataSources.query
        const params: QueryDataSourceParameters = {
          data_source_id: action.databaseId,
        };
        if (action.filter) params.filter = action.filter as QueryDataSourceParameters['filter'];
        if (action.sorts) params.sorts = action.sorts as QueryDataSourceParameters['sorts'];
        if (action.pageSize) params.page_size = action.pageSize;
        if (action.startCursor) params.start_cursor = action.startCursor;
        return client.dataSources.query(params);
      }

      case 'search': {
        const params: SearchParameters = {};
        if (action.query) params.query = action.query;
        if (action.filter) params.filter = action.filter;
        if (action.sort) params.sort = action.sort;
        if (action.pageSize) params.page_size = action.pageSize;
        if (action.startCursor) params.start_cursor = action.startCursor;
        return client.search(params);
      }

      case 'list_databases':
        // In SDK v3, databases show up as data_sources in search
        return client.search({ filter: { value: 'data_source', property: 'object' } });

      case 'retrieve_block':
        return client.blocks.retrieve({ block_id: action.blockId });

      case 'retrieve_block_children': {
        const params: Parameters<typeof client.blocks.children.list>[0] = {
          block_id: action.blockId,
        };
        if (action.pageSize) params.page_size = action.pageSize;
        if (action.startCursor) params.start_cursor = action.startCursor;
        return client.blocks.children.list(params);
      }

      default: {
        const _exhaustive: never = action;
        throw new Error(`Unknown Notion read action: ${(_exhaustive as NotionReadAction).action}`);
      }
    }
  }

  // ── Connection test steps ─────────────────────────────────────────────────

  async* runTest(): AsyncGenerator<{ step: number; name: string; status: 'running' | 'success' | 'error'; detail?: string }> {
    const steps: Array<{ name: string; run: () => Promise<string> }> = [
      {
        name: 'Verify token',
        run: async () => {
          const client = this.assertConnected();
          const me = await client.users.me({});
          const name = ('name' in me && me.name) ? me.name : me.id;
          const workspaceName = (me as unknown as { workspace_name?: string }).workspace_name;
          return workspaceName ? `${name} @ ${workspaceName}` : name;
        },
      },
      {
        name: 'List accessible databases',
        run: async () => {
          const client = this.assertConnected();
          // In SDK v3, databases are data_sources
          const res = await client.search({
            filter: { value: 'data_source', property: 'object' },
            page_size: 5,
          });
          const count = res.results.length;
          const hasMore = res.has_more;
          if (count === 0) return 'No databases accessible — share databases with the integration in Notion';
          const names = res.results
            .slice(0, 3)
            .map((r) => {
              if ('title' in r && Array.isArray(r.title) && r.title.length > 0) {
                return (r.title[0] as { plain_text?: string }).plain_text || 'Untitled';
              }
              return 'Untitled';
            })
            .join(', ');
          return `${count}${hasMore ? '+' : ''} databases: ${names}`;
        },
      },
      {
        name: 'List accessible pages',
        run: async () => {
          const client = this.assertConnected();
          const res = await client.search({
            filter: { value: 'page', property: 'object' },
            page_size: 5,
          });
          const count = res.results.length;
          const hasMore = res.has_more;
          if (count === 0) return 'No pages accessible — share pages with the integration in Notion';
          return `${count}${hasMore ? '+' : ''} pages accessible`;
        },
      },
    ];

    for (let i = 0; i < steps.length; i++) {
      yield { step: i + 1, name: steps[i].name, status: 'running' };
      try {
        const detail = await steps[i].run();
        yield { step: i + 1, name: steps[i].name, status: 'success', detail };
      } catch (e) {
        let message = e instanceof Error ? e.message : String(e);
        // Provide friendlier messages for common Notion API errors
        if (isNotionClientError(e)) {
          if (e.code === APIErrorCode.Unauthorized) message = 'Invalid token — check your Notion integration secret';
          else if (e.code === APIErrorCode.RestrictedResource) message = 'Access restricted — share the resource with the integration';
        }
        yield { step: i + 1, name: steps[i].name, status: 'error', detail: message };
      }
    }
  }
}
