/**
 * One tool over the three file backends (Obsidian vaults, Google Drive folders,
 * SMB shares), which each expose a differently-shaped REST surface:
 *
 *   obsidian  list -> GET /api/obsidian/vaults/{id}/files          (recursive tree)
 *             read -> GET /api/obsidian/vaults/{id}/files/{path}   -> { path, content }
 *   gdrive    list -> GET /api/gdrive/folders/{id}/files           (flat node list)
 *             read -> GET /api/gdrive/folders/{id}/files/{fileId}  -> DriveFileContent
 *   smb       list -> GET /api/smb/shares/{id}/files?path=         (one level)
 *             read -> GET /api/smb/shares/{id}/files/{path}        -> raw bytes, NOT JSON
 *
 * Path encoding: the wildcard route segment must be encoded as a WHOLE with
 * encodeURIComponent (slashes included). Express hands the handler an array of
 * decoded segments, so a per-segment encoding of "a/b.md" arrives as
 * ["a","b.md"] and stringifies to "a,b.md"; encoding the whole path yields the
 * single element ["a/b.md"], which is what the server expects.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
import { READ_ONLY, run } from './shared.js';

type Backend = 'obsidian' | 'gdrive' | 'smb';

/** Encode a file path for a wildcard route segment (see module note). */
function encodePath(path: string): string {
  return encodeURIComponent(path.replace(/^\/+/, ''));
}

/** Heuristic: NUL bytes or replacement chars mean we were handed binary, not text. */
function looksBinary(text: string): boolean {
  return text.includes('\u0000') || text.includes('\uFFFD');
}

/** List the containers (vaults / folders / shares) available on a backend. */
function listContainers(client: ConduitClient, backend: Backend): Promise<unknown> {
  switch (backend) {
    case 'obsidian':
      return client.get('/api/obsidian/vaults');
    case 'gdrive':
      return client.get('/api/gdrive/folders');
    case 'smb':
      return client.get('/api/smb/shares');
  }
}

async function listFiles(
  client: ConduitClient,
  backend: Backend,
  id: string,
  path: string | undefined,
): Promise<unknown> {
  switch (backend) {
    case 'obsidian':
      // Returns the whole vault tree; `path` is not supported server-side.
      return client.get(`/api/obsidian/vaults/${encodeURIComponent(id)}/files`);
    case 'gdrive':
      return client.get(`/api/gdrive/folders/${encodeURIComponent(id)}/files`);
    case 'smb':
      // The only backend where the directory is a query param, not a path segment.
      return client.get(`/api/smb/shares/${encodeURIComponent(id)}/files`, { path });
  }
}

async function readFile(
  client: ConduitClient,
  backend: Backend,
  id: string,
  path: string,
): Promise<unknown> {
  switch (backend) {
    case 'obsidian':
      return client.get(`/api/obsidian/vaults/${encodeURIComponent(id)}/files/${encodePath(path)}`);
    case 'gdrive':
      // `path` is a Drive file id here, taken verbatim from a list call.
      return client.get(
        `/api/gdrive/folders/${encodeURIComponent(id)}/files/${encodeURIComponent(path)}`,
      );
    case 'smb': {
      const content = await client.getText(
        `/api/smb/shares/${encodeURIComponent(id)}/files/${encodePath(path)}`,
      );
      if (looksBinary(content)) {
        return {
          backend,
          shareId: id,
          path,
          error:
            'This file is binary, not text — it cannot be read as content. Ask the user to open it from the Conduit UI instead.',
        };
      }
      return { backend, shareId: id, path, content };
    }
  }
}

export function registerFileTools(server: McpServer, client: ConduitClient): void {
  server.registerTool(
    'conduit_read_file',
    {
      title: 'Read or list files',
      description:
        'Read a file, or list what is available, across the user\'s three file backends: ' +
        'obsidian (Markdown vaults), gdrive (Google Drive folders — Docs arrive as Markdown, Sheets as CSV), ' +
        'and smb (network shares). ' +
        'Typical flow: call with only `backend` to list the configured vaults/folders/shares and get their ids, ' +
        'then mode="list" with that id to see the files, then mode="read" with the file\'s path/id. ' +
        'ALWAYS read a file before proposing an edit to it, and copy anchor text for patches character-for-character. ' +
        'Writes do not happen here — queue them with conduit_queue_action. ' +
        'For gdrive, note each file\'s `editability` (direct | find-replace | read-only) before planning a change.',
      inputSchema: {
        backend: z
          .enum(['obsidian', 'gdrive', 'smb'])
          .describe('Which file backend to use: obsidian | gdrive | smb.'),
        id: z
          .string()
          .optional()
          .describe(
            'Vault id (obsidian), folder config id (gdrive) or share id (smb) — all integers as strings. ' +
              'Omit it to list the configured vaults/folders/shares for this backend and discover the ids.',
          ),
        mode: z
          .enum(['read', 'list'])
          .optional()
          .describe(
            'read (default) fetches one file; list enumerates files. Ignored when `id` is omitted, which always lists containers.',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'For mode="read": obsidian = vault-relative file path ("Notes/Standup.md"); ' +
              'gdrive = the Drive fileId from a list call (NOT a path); smb = share-relative file path. ' +
              'For mode="list": smb uses it as the directory to list (default: share root); obsidian and gdrive ignore it and return the whole tree.',
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ backend, id, mode = 'read', path }) =>
      run(async () => {
        if (!id) return listContainers(client, backend);
        if (mode === 'list') return listFiles(client, backend, id, path);
        if (!path) {
          throw new Error(
            backend === 'gdrive'
              ? 'path is required for mode="read" on gdrive — pass the Drive fileId from a mode="list" call.'
              : 'path is required for mode="read". Use mode="list" first to find the file path.',
          );
        }
        return readFile(client, backend, id, path);
      }),
  );
}
