import type { HistoryEntry, ScanResult, Status, Subscription } from "../../shared/types";
import { SCAN_CONCURRENCY, SCAN_QUERY, STILL_SENDING_GRACE_MS } from "../constants";
import { AuthExpiredError, type GmailClient, type MessageMeta } from "../gmail/types";
import type { HistoryStore } from "../store/history";
import { mapLimit } from "../util/pool";
import { analyzeMessage, type AnalyzedMessage } from "./headers";

/** §7.3: a row's status from the sender's latest history entry. */
export function deriveStatus(lastReceived: number, entry: HistoryEntry | undefined): Status {
  if (!entry) return "active";
  switch (entry.outcome) {
    case "failed":
      return "failed";
    case "manual-pending":
      return "manual";
    case "unsubscribed":
    case "manual-done":
      return lastReceived > entry.at + STILL_SENDING_GRACE_MS ? "still-sending" : "unsubscribed";
  }
}

export interface ScanDeps {
  gmail: GmailClient;
  history: HistoryStore;
  now?: () => number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/** §7.1: list → fetch metadata → group by sender → derive status from history. */
export async function scanMailbox(deps: ScanDeps): Promise<ScanResult> {
  const { gmail, history, onProgress } = deps;
  const ids = await gmail.listMessageIds(SCAN_QUERY);

  let done = 0;
  let authError: AuthExpiredError | undefined;
  const settled = await mapLimit(ids, deps.concurrency ?? SCAN_CONCURRENCY, async (id): Promise<MessageMeta> => {
    // The scan fails anyway; don't spend a request (and a doomed token refresh) per remaining id.
    if (authError) throw authError;
    try {
      return await gmail.getMessageMetadata(id);
    } catch (err) {
      if (err instanceof AuthExpiredError) authError ??= err;
      throw err;
    } finally {
      onProgress?.(++done, ids.length);
    }
  });
  if (authError) throw authError;

  let skipped = 0;
  const groups = new Map<string, { newest: AnalyzedMessage; count: number }>();
  for (const result of settled) {
    if (result.status === "rejected") {
      skipped++;
      continue;
    }
    const msg = analyzeMessage(result.value);
    if (!msg) continue;
    const group = groups.get(msg.sender);
    if (!group) {
      groups.set(msg.sender, { newest: msg, count: 1 });
      continue;
    }
    group.count++;
    if (msg.internalDate > group.newest.internalDate) group.newest = msg;
  }

  const subscriptions: Subscription[] = [];
  for (const [sender, { newest, count }] of groups) {
    const lastAttempt = history.get(sender);
    const sub: Subscription = {
      sender,
      name: newest.name,
      count,
      lastReceived: newest.internalDate,
      latestSubject: newest.subject,
      method: newest.method,
      targets: newest.targets,
      status: deriveStatus(newest.internalDate, lastAttempt),
    };
    if (lastAttempt) sub.lastAttempt = lastAttempt;
    subscriptions.push(sub);
  }
  subscriptions.sort((a, b) => b.count - a.count || b.lastReceived - a.lastReceived);

  return { scannedAt: (deps.now ?? Date.now)(), subscriptions, skipped };
}
