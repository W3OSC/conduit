/**
 * Calendar and Google Meet notes.
 *
 * Meet-note "summaries" are full meeting transcripts, so this module defaults
 * to a much smaller page size than the API's own default and requires a `from`
 * bound — an unbounded pull here is the single most expensive thing an agent
 * can do against Conduit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
import { READ_ONLY, run } from './shared.js';

/** Deliberately far below the API's default of 50 — each note can be huge. */
const MEET_NOTES_DEFAULT_LIMIT = 10;

export function registerScheduleTools(server: McpServer, client: ConduitClient): void {
  server.registerTool(
    'conduit_meet_notes',
    {
      title: 'Google Meet notes',
      description:
        'Google Meet AI meeting notes. EXPENSIVE — each note\'s `summary` is a full meeting transcript, so a wide ' +
        'pull can cost tens of thousands of tokens. Rules: (1) `from` is required — for "the past two weeks" pass ' +
        'now minus 14 days as ISO-8601; (2) keep `limit` at or below 10 (this tool defaults to 10, not the API\'s 50); ' +
        '(3) pass `q` when you are looking for a specific meeting. ' +
        'conduit_digest already returns short excerpts of recent meetings — check there first and only come here ' +
        'when the user needs detail from a specific meeting. ' +
        'Pass `id` (from a previous list call or the digest) to fetch exactly one note with its full transcript.',
      inputSchema: {
        id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Fetch one note by id, including its full transcript. When set, all other parameters are ignored. This is the cheapest way to get detail on one known meeting.',
          ),
        from: z
          .string()
          .optional()
          .describe(
            'REQUIRED unless `id` is given. ISO-8601 lower bound on meeting date. "Past two weeks" = now minus 14 days.',
          ),
        to: z.string().optional().describe('ISO-8601 upper bound on meeting date. Default: no upper bound.'),
        q: z.string().optional().describe('Substring match against note title and summary.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe(`Max notes. Defaults to ${MEET_NOTES_DEFAULT_LIMIT} here. Do not raise this without a narrow window.`),
        offset: z.number().int().min(0).optional().describe('Paging offset. Default 0.'),
      },
      annotations: READ_ONLY,
    },
    async ({ id, from, to, q, limit, offset }) =>
      run(() => {
        if (id !== undefined) return client.get(`/api/meet-notes/${id}`);
        if (!from) {
          throw new Error(
            'from is required (ISO-8601). Meet-note summaries are full transcripts, so unbounded pulls are ' +
              'prohibitively expensive — pass a window such as the last 14 days, or pass `id` to read one known note.',
          );
        }
        return client.get('/api/meet-notes', {
          from,
          to,
          q,
          limit: limit ?? MEET_NOTES_DEFAULT_LIMIT,
          offset,
        });
      }),
  );

  server.registerTool(
    'conduit_calendar_events',
    {
      title: 'Calendar events',
      description:
        'Google Calendar events ordered by start time. conduit_digest already includes the next 7 days — use this ' +
        'tool for any other window ("last month", "next quarter", a specific date) or when you need full event ' +
        'detail such as attendees, description, location or Meet link. ' +
        'Always pass from/to; the unbounded default window is 7 days back to 30 days ahead with a limit of 200.',
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe('ISO-8601 lower bound on event start time. Default: 7 days ago.'),
        to: z
          .string()
          .optional()
          .describe('ISO-8601 upper bound on event start time. Default: 30 days from now.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Max events. API default 200, hard max 500. Prefer 20-50 with a tight window.'),
      },
      annotations: READ_ONLY,
    },
    async ({ from, to, limit }) =>
      run(() => client.get('/api/calendar/events', { from, to, limit })),
  );
}
