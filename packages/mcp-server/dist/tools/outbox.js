/**
 * The write path — which is not really a write path.
 *
 * Everything an agent "sends" is queued as a pending outbox item and executes
 * only after the user approves it in the Conduit UI. Each POST carries a fresh
 * Idempotency-Key so a retry after a timeout returns the original item instead
 * of queueing a duplicate.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { QUEUES_WRITE, READ_ONLY, run } from './shared.js';
const SOURCES = [
    'slack',
    'discord',
    'telegram',
    'twitter',
    'gmail',
    'calendar',
    'notion',
    'obsidian',
    'smb',
    'gdrive',
];
export function registerOutboxTools(server, client) {
    server.registerTool('conduit_queue_action', {
        title: 'Queue an action for approval',
        description: 'QUEUES an action for the user to approve. It does NOT send, post, email or modify anything. ' +
            'The item is created `pending` and only executes after the user approves it in the Conduit UI, so never tell ' +
            'the user you sent/posted/emailed something — say you queued it for their approval, and say what it was. ' +
            '\n\n' +
            '`content` format depends on `source`:\n' +
            '- slack / discord / telegram: plain message text.\n' +
            '- everything else (gmail, calendar, twitter, notion, obsidian, smb, gdrive): a JSON-ENCODED STRING of the action payload.\n' +
            '\n' +
            'Payload shapes (JSON-encode these into `content`):\n' +
            '- gmail reply: {"action":"reply","messageId":"…","threadId":"…","to":["a@x.io"],"subject":"Re: …","body":"…"}; ' +
            'compose: {"action":"compose","to":["a@x.io"],"subject":"…","body":"…"}; ' +
            'one-field actions with messageId: archive, trash, spam, mark_read, mark_unread, star, unstar, unsubscribe.\n' +
            '- calendar: {"action":"rsvp","calendarId":"primary","eventId":"…","rsvpStatus":"accepted|declined|tentative"}, ' +
            'or action create/update/delete with calendarId, title, start, end, attendees.\n' +
            '- twitter: tweet {text} | reply {text,replyToId} | quote {text,quotedId} | retweet {tweetId} | like {tweetId} | follow {handle} | dm {text,conversationId}.\n' +
            '- obsidian / smb / gdrive files: patch_file (ALWAYS prefer for existing files), create_file, write_file (full overwrite), ' +
            'rename_file, delete_file, and create_directory for smb. obsidian uses path (+vaultId if multiple vaults); ' +
            'smb uses path + shareId; gdrive uses folderId + fileId. ' +
            'patch_file takes edits[] applied in order: {"search":"anchor","replace":"new"} or {"search":"anchor","position":"after|before","content":"…"}. ' +
            'Read the file with conduit_read_file first and copy the shortest unique anchor character-for-character (<~80 chars).\n' +
            '\n' +
            '`recipient_id` is the channel/DM id (from conduit_list_chats or conduit_digest), email address, file path, or file id. ' +
            '`recipient_name` is the human label shown in the approval UI — always set something the user will recognise. ' +
            'After queueing, report the returned id and status; poll with conduit_outbox_status.',
        inputSchema: {
            source: z
                .enum(SOURCES)
                .describe('Target service: slack | discord | telegram | twitter | gmail | calendar | notion | obsidian | smb | gdrive.'),
            recipient_id: z
                .string()
                .min(1)
                .describe('Channel/DM id, email address, file path or file id — see the per-service notes in this tool\'s description.'),
            recipient_name: z
                .string()
                .optional()
                .describe('Human-readable label shown to the user in the approval UI, e.g. "#general" or "Priya (DM)". Defaults to recipient_id — always set it.'),
            content: z
                .string()
                .min(1)
                .describe('Plain text for slack/discord/telegram; a JSON-encoded string of the action payload for every other source.'),
        },
        annotations: QUEUES_WRITE,
    }, async ({ source, recipient_id, recipient_name, content }) => run(() => client.post('/api/outbox', { source, recipient_id, recipient_name, content }, 
    // A fresh key per call: retrying a timed-out request returns the
    // original item rather than queueing the same action twice.
    { 'Idempotency-Key': randomUUID() })));
    server.registerTool('conduit_outbox_status', {
        title: 'Check queued actions',
        description: 'Check what you have queued and where it got to: pending (waiting for the user) -> sent | rejected | failed. ' +
            'Pass `id` for one item, or filter with status/source for a list. ' +
            'You only ever see items queued by this API key. ' +
            'Use it after conduit_queue_action to confirm the item was created, or when the user asks what is waiting for ' +
            'their approval. A `failed` item carries an errorMessage explaining why dispatch failed after approval.',
        inputSchema: {
            id: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Fetch a single outbox item by id. When set, the other parameters are ignored.'),
            status: z
                .enum(['pending', 'approved', 'sent', 'rejected', 'failed'])
                .optional()
                .describe('Filter by status. Use "pending" for "what is awaiting the user\'s approval".'),
            source: z.enum(SOURCES).optional().describe('Filter by target service.'),
            limit: z
                .number()
                .int()
                .positive()
                .max(200)
                .optional()
                .describe('Max items. Default 50, hard max 200.'),
            offset: z.number().int().min(0).optional().describe('Paging offset. Default 0.'),
        },
        annotations: READ_ONLY,
    }, async ({ id, status, source, limit, offset }) => run(() => id !== undefined
        ? client.get(`/api/outbox/${id}`)
        : client.get('/api/outbox', { status, source, limit, offset })));
}
//# sourceMappingURL=outbox.js.map