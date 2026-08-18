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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
export declare function registerFileTools(server: McpServer, client: ConduitClient): void;
//# sourceMappingURL=files.d.ts.map