/**
 * Coverage block for read responses.
 *
 * Conduit only sees the operator's own connected accounts. A search that
 * returns nothing is therefore ambiguous: "nothing exists" vs "this hub cannot
 * see it". Every list-returning read op attaches a `coverage` block so
 * consumers (AI agents, reconcile jobs) can qualify their conclusions instead
 * of asserting them:
 *
 *   coverage: {
 *     accountsSearched:   which concrete accounts the data came from,
 *     sourcesSearched:    the services actually queried,
 *     sourcesUnavailable: requested services that are not live right now —
 *                         either never connected (no data at all) or currently
 *                         disconnected (local cache only, possibly stale),
 *     visibility:         the standing caveat about other people's accounts.
 *   }
 */

import { sql, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { accounts, gmailMessages } from '../db/schema.js';
import { getConnectionManager, type ServiceName } from '../connections/manager.js';

export interface CoverageAccount {
  source: string;
  accountId: string | null;
  displayName: string | null;
}

export interface CoverageUnavailable {
  source: string;
  /** Live connection status: disconnected | connecting | error. */
  status: string;
  detail: string;
}

export interface CoverageBlock {
  accountsSearched: CoverageAccount[];
  sourcesSearched: string[];
  sourcesUnavailable: CoverageUnavailable[];
  visibility: string;
}

export const COVERAGE_VISIBILITY =
  'Only accounts connected to this Conduit hub were searched. Conversations ' +
  'that live exclusively in other people\'s accounts (e.g. a teammate\'s DM ' +
  'with the same person) are not visible here and their absence is not ' +
  'evidence of silence.';

/** Services whose account identity comes from the Google credential store. */
const GOOGLE_SOURCES = new Set(['gmail', 'calendar']);

/**
 * Build the coverage block for a read op.
 *
 * @param requestedSources what the caller asked for (or the op's full default)
 * @param searchedSources  what was actually queried after permission filtering
 */
export function buildCoverage(
  requestedSources: readonly string[],
  searchedSources: readonly string[] = requestedSources,
): CoverageBlock {
  const db = getDb();
  const searched = [...new Set(searchedSources)];
  const requested = [...new Set(requestedSources)];

  const accountsSearched: CoverageAccount[] = [];
  const seen = new Set<string>();
  const push = (a: CoverageAccount) => {
    const key = `${a.source}:${a.accountId}`;
    if (a.accountId && !seen.has(key)) {
      seen.add(key);
      accountsSearched.push(a);
    }
  };

  // Chat platforms: the accounts table is the source of truth.
  const nonGoogle = searched.filter((s) => !GOOGLE_SOURCES.has(s));
  if (nonGoogle.length) {
    for (const row of db
      .select({ source: accounts.source, accountId: accounts.accountId, displayName: accounts.displayName })
      .from(accounts)
      .where(inArray(accounts.source, nonGoogle))
      .all()) {
      push(row);
    }
  }

  // Google accounts: live statuses first, synced data as fallback (the
  // accounts table has no rows for gmail/calendar).
  const manager = getConnectionManager();
  const googleSearched = searched.filter((s) => GOOGLE_SOURCES.has(s));
  if (googleSearched.length) {
    const emails = manager.getGmailAccountStatuses().map((a) => a.email);
    if (emails.length === 0) {
      // Headless/test fallback: whatever accounts the synced mail came from.
      for (const row of db
        .select({ accountId: gmailMessages.accountId })
        .from(gmailMessages)
        .where(sql`${gmailMessages.accountId} IS NOT NULL`)
        .groupBy(gmailMessages.accountId)
        .all()) {
        if (row.accountId) emails.push(row.accountId);
      }
    }
    for (const source of googleSearched) {
      for (const email of emails) push({ source, accountId: email, displayName: email });
    }
  }

  // Requested services that are not live right now.
  const statuses = manager.getAllStatuses();
  const sourcesUnavailable: CoverageUnavailable[] = [];
  for (const source of requested) {
    const status = statuses[source as ServiceName]?.status ?? 'disconnected';
    if (status === 'connected') continue;
    const hasAccount = accountsSearched.some((a) => a.source === source);
    const wasSearched = searched.includes(source);
    sourcesUnavailable.push({
      source,
      status,
      detail: !wasSearched
        ? `${source} was not searched (not permitted or not requested).`
        : hasAccount
          ? `${source} is ${status}; results come from the local sync cache and may be stale or incomplete.`
          : `${source} has never been connected on this hub — no data exists for it, which is not evidence that nothing exists.`,
    });
  }

  return {
    accountsSearched,
    sourcesSearched: searched,
    sourcesUnavailable,
    visibility: COVERAGE_VISIBILITY,
  };
}
