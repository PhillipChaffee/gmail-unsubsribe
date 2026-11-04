import type { CleanupMode, HistoryEntry, SenderResult, Subscription } from "../../shared/types";
import { SCAN_CONCURRENCY, UNSUB_CONCURRENCY } from "../constants";
import { AuthExpiredError, type GmailClient } from "../gmail/types";
import { parseFrom } from "../scan/headers";
import type { HistoryStore } from "../store/history";
import { mapLimit } from "../util/pool";
import { sendMailto, type MethodOutcome } from "./methods";
import type { UrlCheck } from "./urlPolicy";

export interface RunnerDeps {
  gmail: GmailClient;
  /** The runner only writes history; a narrow type lets the API wrap it per session. */
  history: Pick<HistoryStore, "set">;
  checkUrl: (url: string) => Promise<UrlCheck>;
  postOneClick: (url: string) => Promise<MethodOutcome>;
  now?: () => number;
  concurrency?: number;
}

type Attempt = Pick<SenderResult, "outcome" | "methodUsed" | "detail" | "manualUrl">;
type Cleanup = NonNullable<SenderResult["cleanup"]>;

const NOTHING_ATTEMPTED = "no automatic unsubscribe method";

/**
 * Addresses that read as one plain term inside `from:(...)`. Anything else (a leading "-",
 * parentheses, braces, ":" ...) could make the search match other senders' mail, which cleanup
 * would then archive or trash. Such senders are still unsubscribed; only cleanup is skipped,
 * with an error. Domain labels must be valid DNS labels (no leading or trailing "-").
 */
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const SEARCHABLE_SENDER = new RegExp(`^[a-z0-9_][a-z0-9._%+=-]*@${DNS_LABEL}(?:\\.${DNS_LABEL})+$`, "i");

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One-click → mailto → manual link → failed (§8). Earlier failures are kept in `detail`. */
async function attemptMethods({ targets }: Subscription, deps: RunnerDeps): Promise<Attempt> {
  const steps: string[] = [];
  const won = (methodUsed: "one-click" | "mailto", detail: string): Attempt => ({
    outcome: "unsubscribed",
    methodUsed,
    detail: [...steps, detail].join("; "),
  });

  if (targets.oneClickUrl) {
    const check = await deps.checkUrl(targets.oneClickUrl);
    const res = check.ok ? await deps.postOneClick(targets.oneClickUrl) : { ok: false, detail: `blocked (${check.reason})` };
    if (res.ok) return won("one-click", res.detail);
    steps.push(`one-click: ${res.detail}`);
  }
  if (targets.mailto) {
    const res = await sendMailto(deps.gmail, targets.mailto);
    if (res.ok) return won("mailto", res.detail);
    steps.push(`email: ${res.detail}`);
  }
  const detail = steps.join("; ") || NOTHING_ATTEMPTED;
  // §8 says "webUrl (or oneClickUrl)"; the scan sets webUrl whenever it sets oneClickUrl
  // (parseListUnsubscribe: webUrl = httpsUrl ?? httpUrl), so webUrl alone covers both.
  if (targets.webUrl) return { outcome: "manual", methodUsed: "manual", detail, manualUrl: targets.webUrl };
  return { outcome: "failed", detail };
}

function historyEntry(a: Attempt, at: number): HistoryEntry {
  switch (a.outcome) {
    case "unsubscribed":
      return { outcome: "unsubscribed", method: a.methodUsed, at, detail: a.detail };
    case "manual":
      return { outcome: "manual-pending", method: "manual", at, detail: a.detail, manualUrl: a.manualUrl };
    case "failed":
      return { outcome: "failed", at, detail: a.detail };
  }
}

/**
 * Gmail's from: search can match other senders (lookalikes), so each hit's From header is checked
 * against the exact address. Messages whose metadata can't be read are counted, not touched.
 * AuthExpiredError propagates once the pool has settled.
 */
async function verifiedSenderIds(sender: string, ids: string[], gmail: GmailClient): Promise<{ verified: string[]; unchecked: number }> {
  let authError: AuthExpiredError | undefined;
  const settled = await mapLimit(ids, SCAN_CONCURRENCY, async (id) => {
    // After an auth failure every further fetch would fail too: start no more (like the scanner).
    if (authError) throw authError;
    try {
      const meta = await gmail.getMessageMetadata(id);
      return parseFrom(meta.headers["from"]?.[0])?.address === sender;
    } catch (err) {
      if (err instanceof AuthExpiredError) authError ??= err;
      throw err;
    }
  });
  if (authError) throw authError;
  const verified: string[] = [];
  let unchecked = 0;
  settled.forEach((s, i) => {
    if (s.status === "rejected") unchecked++;
    else if (s.value) verified.push(ids[i]!);
  });
  return { verified, unchecked };
}

/** Archives or trashes the sender's verified mail (all time). Only AuthExpiredError escapes. */
async function cleanUp(sender: string, mode: "archive" | "trash", gmail: GmailClient): Promise<Cleanup> {
  if (!SEARCHABLE_SENDER.test(sender)) return { mode, ok: false, error: "sender address can't be searched safely" };
  try {
    const found = await gmail.listMessageIds(`from:(${sender})`);
    const { verified, unchecked } = await verifiedSenderIds(sender, found, gmail);
    if (verified.length > 0) await (mode === "archive" ? gmail.archive(verified) : gmail.trash(verified));
    if (unchecked === 0) return { mode, ok: true, count: verified.length };
    return { mode, ok: false, count: verified.length, error: `${unchecked} emails couldn't be checked and were left in place` };
  } catch (err) {
    if (err instanceof AuthExpiredError) throw err;
    return { mode, ok: false, error: messageOf(err) };
  }
}

/**
 * Unsubscribes one sender, records history, then cleans up (unless the outcome is failed).
 * AuthExpiredError propagates; any other exception becomes a failed result.
 */
export async function unsubscribeSender(sub: Subscription, cleanup: CleanupMode, deps: RunnerDeps): Promise<SenderResult> {
  const now = deps.now ?? Date.now;
  try {
    const attempt = await attemptMethods(sub, deps);
    await deps.history.set(sub.sender, historyEntry(attempt, now()));
    const result: SenderResult = { sender: sub.sender, ...attempt };
    if (cleanup !== "leave" && attempt.outcome !== "failed") {
      result.cleanup = await cleanUp(sub.sender, cleanup, deps.gmail);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthExpiredError) throw err;
    const detail = messageOf(err);
    // Best effort: keep history in step with the result; the failure is reported either way.
    await deps.history.set(sub.sender, { outcome: "failed", at: now(), detail }).catch(() => {});
    return { sender: sub.sender, outcome: "failed", detail };
  }
}

/**
 * Runs unsubscribeSender over `subs` with bounded concurrency, calling onResult as each finishes.
 * After an AuthExpiredError no new sender starts; in-flight ones finish, then the run rejects with it.
 * Resolves with the results in input order. The runner produces no row Status: callers derive it
 * with statusFromResult (shared/status.ts), e.g. in onResult.
 */
export async function runUnsubscribe(
  subs: Subscription[],
  cleanup: CleanupMode,
  deps: RunnerDeps,
  onResult: (r: SenderResult) => void,
): Promise<SenderResult[]> {
  let authError: AuthExpiredError | undefined;
  const settled = await mapLimit(subs, deps.concurrency ?? UNSUB_CONCURRENCY, async (sub) => {
    if (authError) return undefined;
    try {
      const result = await unsubscribeSender(sub, cleanup, deps);
      onResult(result);
      return result;
    } catch (err) {
      if (err instanceof AuthExpiredError) authError ??= err;
      throw err;
    }
  });
  if (authError) throw authError;
  const results: SenderResult[] = [];
  for (const s of settled) {
    if (s.status === "rejected") throw s.reason;
    if (s.value) results.push(s.value);
  }
  return results;
}
