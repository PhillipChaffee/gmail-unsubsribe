import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STILL_SENDING_GRACE_MS } from "../../server/constants";
import { FakeGmailClient, fakeMessage, type FakeMessageSpec } from "../../server/gmail/fake";
import { AuthExpiredError } from "../../server/gmail/types";
import { deriveStatus, scanMailbox } from "../../server/scan/scanner";
import { HistoryStore } from "../../server/store/history";
import type { HistoryEntry } from "../../shared/types";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const now = () => NOW;

let history: HistoryStore;
beforeEach(async () => {
  history = await HistoryStore.open(join(await mkdtemp(join(tmpdir(), "scanner-test-")), "history.json"));
});

const gmailWith = (...specs: FakeMessageSpec[]) =>
  new FakeGmailClient({ now, messages: specs.map((s) => fakeMessage(s, NOW)) });

/** Makes listMessageIds return oldest first (the real API and the fake return newest first). */
const listOldestFirst = (gmail: FakeGmailClient) => {
  const newestFirst = gmail.listMessageIds.bind(gmail);
  gmail.listMessageIds = async (query) => (await newestFirst(query)).reverse();
};

const entry = (outcome: HistoryEntry["outcome"], at: number): HistoryEntry => ({ outcome, at, detail: `${outcome} detail` });

describe("scanMailbox", () => {
  it("groups messages by lowercased sender address (Deals@Acme.com and deals@acme.com → one row, count 2)", async () => {
    const gmail = gmailWith(
      { id: "1", from: "Acme Deals <Deals@Acme.com>", daysAgo: 1 },
      { id: "2", from: "deals@acme.com", daysAgo: 2 },
    );
    const result = await scanMailbox({ gmail, history, now });
    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0]).toMatchObject({ sender: "deals@acme.com", count: 2 });
    expect(result.scannedAt).toBe(NOW);
    expect(result.skipped).toBe(0);
  });

  it("name, latestSubject, lastReceived, targets and method come from the newest message", async () => {
    const gmail = gmailWith(
      { id: "old", from: "Old Name <news@shop.com>", subject: "Old subject", daysAgo: 5 },
      { id: "new", from: "New Name <news@shop.com>", subject: "New subject", daysAgo: 1, oneClick: false, listUnsubscribe: "<mailto:stop@shop.com>" },
      { id: "mid", from: "Mid Name <news@shop.com>", subject: "Mid subject", daysAgo: 3 },
    );
    const expected = {
      sender: "news@shop.com",
      name: "New Name",
      count: 3,
      lastReceived: NOW - 1 * DAY,
      latestSubject: "New subject",
      method: "mailto",
      targets: { mailto: "mailto:stop@shop.com" },
    };
    expect((await scanMailbox({ gmail, history, now })).subscriptions).toEqual([expect.objectContaining(expected)]);

    // The newest message is picked by internalDate, not by its position in the list.
    listOldestFirst(gmail);
    expect((await scanMailbox({ gmail, history, now })).subscriptions).toEqual([expect.objectContaining(expected)]);
  });

  it("messages without a usable List-Unsubscribe are not counted and a sender with none is absent", async () => {
    const gmail = gmailWith(
      { id: "a1", from: "A <a@list.com>", subject: "usable 1", daysAgo: 2 },
      { id: "a2", from: "A <a@list.com>", subject: "usable 2", daysAgo: 3 },
      { id: "a3", from: "A <a@list.com>", subject: "no header", daysAgo: 1, listUnsubscribe: "" },
      { id: "a4", from: "A <a@list.com>", subject: "ftp only", daysAgo: 1, listUnsubscribe: "<ftp://list.com/u>" },
      { id: "b1", from: "B <b@nolist.com>", daysAgo: 1, listUnsubscribe: "" },
    );
    const { subscriptions, skipped } = await scanMailbox({ gmail, history, now });
    expect(subscriptions.map((s) => s.sender)).toEqual(["a@list.com"]);
    expect(subscriptions[0]).toMatchObject({ count: 2, latestSubject: "usable 1", lastReceived: NOW - 2 * DAY });
    expect(skipped).toBe(0);
  });

  it("failing metadata fetches are skipped and counted", async () => {
    const gmail = gmailWith(
      { id: "1", from: "a@x.com", daysAgo: 1 },
      { id: "2", from: "a@x.com", daysAgo: 2 },
      { id: "3", from: "b@y.com", daysAgo: 1 },
      { id: "4", from: "c@z.com", daysAgo: 1 },
    );
    gmail.failMetadataFor.add("2");
    gmail.failMetadataFor.add("4");
    const result = await scanMailbox({ gmail, history, now });
    expect(result.skipped).toBe(2);
    expect(result.subscriptions.map((s) => [s.sender, s.count])).toEqual(
      expect.arrayContaining([
        ["a@x.com", 1],
        ["b@y.com", 1],
      ]),
    );
    expect(result.subscriptions).toHaveLength(2);
  });

  it("onProgress reports (done,total) ending at (total,total)", async () => {
    const gmail = gmailWith(
      ...Array.from({ length: 10 }, (_, i): FakeMessageSpec => ({ id: `m${i}`, from: `s${i % 3}@x.com`, daysAgo: 1 + i })),
    );
    gmail.failMetadataFor.add("m4");
    const calls: [number, number][] = [];
    await scanMailbox({ gmail, history, now, concurrency: 3, onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual(Array.from({ length: 10 }, (_, i) => [i + 1, 10]));
    expect(calls.at(-1)).toEqual([10, 10]);
  });

  it("AuthExpiredError from getMessageMetadata rejects scanMailbox", async () => {
    const gmail = gmailWith({ id: "1", from: "a@x.com", daysAgo: 1 }, { id: "2", from: "b@x.com", daysAgo: 2 });
    gmail.failNext = { method: "getMessageMetadata", error: new AuthExpiredError() };
    await expect(scanMailbox({ gmail, history, now })).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("AuthExpiredError from listMessageIds rejects scanMailbox", async () => {
    const gmail = gmailWith({ id: "1", from: "a@x.com", daysAgo: 1 });
    gmail.failNext = { method: "listMessageIds", error: new AuthExpiredError() };
    await expect(scanMailbox({ gmail, history, now })).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("stops issuing metadata fetches once one fails with AuthExpiredError", async () => {
    const gmail = gmailWith(
      { id: "1", from: "a@x.com", daysAgo: 1 },
      { id: "2", from: "b@x.com", daysAgo: 2 },
      { id: "3", from: "c@x.com", daysAgo: 3 },
    );
    gmail.failNext = { method: "getMessageMetadata", error: new AuthExpiredError() };
    const fetch = vi.spyOn(gmail, "getMessageMetadata");
    await expect(scanMailbox({ gmail, history, now, concurrency: 1 })).rejects.toBeInstanceOf(AuthExpiredError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sorts subscriptions by count desc, then lastReceived desc", async () => {
    const gmail = gmailWith(
      { id: "o1", from: "one@x.com", daysAgo: 1 },
      { id: "t1", from: "two-old@x.com", daysAgo: 4 },
      { id: "t2", from: "two-old@x.com", daysAgo: 5 },
      { id: "n1", from: "two-new@x.com", daysAgo: 2 },
      { id: "n2", from: "two-new@x.com", daysAgo: 3 },
      { id: "h1", from: "three@x.com", daysAgo: 7 },
      { id: "h2", from: "three@x.com", daysAgo: 8 },
      { id: "h3", from: "three@x.com", daysAgo: 9 },
    );
    const order = async () => (await scanMailbox({ gmail, history, now })).subscriptions.map((s) => s.sender);
    const expected = ["three@x.com", "two-new@x.com", "two-old@x.com", "one@x.com"];
    expect(await order()).toEqual(expected);
    // Oldest-first listing groups two-old before two-new, so only the lastReceived tiebreak orders them.
    listOldestFirst(gmail);
    expect(await order()).toEqual(expected);
  });

  it("status and lastAttempt are filled from history", async () => {
    const gmail = gmailWith(
      { id: "1", from: "fresh@x.com", daysAgo: 1 },
      { id: "2", from: "failed@x.com", daysAgo: 1 },
      { id: "3", from: "persistent@x.com", daysAgo: 1 },
      { id: "4", from: "pending@x.com", daysAgo: 1 },
    );
    const failed = entry("failed", NOW - 5 * DAY);
    const unsubscribed = entry("unsubscribed", NOW - 5 * DAY);
    const pending = entry("manual-pending", NOW - 2 * DAY);
    await history.set("failed@x.com", failed);
    await history.set("persistent@x.com", unsubscribed);
    await history.set("pending@x.com", pending);

    const bySender = Object.fromEntries((await scanMailbox({ gmail, history, now })).subscriptions.map((s) => [s.sender, s]));
    expect(bySender["fresh@x.com"]!.status).toBe("active");
    expect(bySender["fresh@x.com"]!.lastAttempt).toBeUndefined();
    expect(bySender["failed@x.com"]).toMatchObject({ status: "failed", lastAttempt: failed });
    expect(bySender["persistent@x.com"]).toMatchObject({ status: "still-sending", lastAttempt: unsubscribed });
    expect(bySender["pending@x.com"]).toMatchObject({ status: "manual", lastAttempt: pending });
  });
});

describe("deriveStatus", () => {
  const T = NOW - 10 * DAY;

  it("no entry → active", () => {
    expect(deriveStatus(NOW, undefined)).toBe("active");
  });

  it("failed → failed", () => {
    expect(deriveStatus(NOW, entry("failed", T))).toBe("failed");
  });

  it("manual-pending → manual", () => {
    expect(deriveStatus(NOW, entry("manual-pending", T))).toBe("manual");
  });

  it("unsubscribed at T with lastReceived T+48h → unsubscribed", () => {
    expect(deriveStatus(T + STILL_SENDING_GRACE_MS, entry("unsubscribed", T))).toBe("unsubscribed");
  });

  it("unsubscribed at T with lastReceived T+48h+1ms → still-sending", () => {
    expect(deriveStatus(T + STILL_SENDING_GRACE_MS + 1, entry("unsubscribed", T))).toBe("still-sending");
  });

  it("manual-done behaves like unsubscribed", () => {
    expect(deriveStatus(T + STILL_SENDING_GRACE_MS, entry("manual-done", T))).toBe("unsubscribed");
    expect(deriveStatus(T + STILL_SENDING_GRACE_MS + 1, entry("manual-done", T))).toBe("still-sending");
  });
});
