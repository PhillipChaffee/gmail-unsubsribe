import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGmailClient, fakeMessage, type FakeMessageSpec } from "../../server/gmail/fake";
import { AuthExpiredError } from "../../server/gmail/types";
import { HistoryStore } from "../../server/store/history";
import type { MethodOutcome } from "../../server/unsub/methods";
import { runUnsubscribe, unsubscribeSender, type RunnerDeps } from "../../server/unsub/runner";
import type { UrlCheck } from "../../server/unsub/urlPolicy";
import { statusFromResult } from "../../shared/status";
import type { SenderResult, Subscription, UnsubTargets } from "../../shared/types";

const NOW = 1_700_000_000_000;
const now = () => NOW;

const SENDER = "news@shop.com";
const ONE_CLICK = "https://unsub.shop.com/u/1";
const MAILTO = "mailto:unsub@shop.com";
const WEB = "https://shop.com/preferences";

let history: HistoryStore;
let gmail: FakeGmailClient;
beforeEach(async () => {
  history = await HistoryStore.open(join(await mkdtemp(join(tmpdir(), "runner-test-")), "history.json"));
  gmail = new FakeGmailClient({ now });
});

const sub = (sender: string, targets: UnsubTargets): Subscription => ({
  sender,
  name: "",
  count: 1,
  lastReceived: NOW,
  latestSubject: "Weekly deals",
  method: targets.oneClickUrl ? "one-click" : targets.mailto ? "mailto" : "manual",
  targets,
  status: "active",
});

const seed = (...specs: FakeMessageSpec[]) => gmail.reset(specs.map((s) => fakeMessage(s, NOW)));
const labelsOf = (id: string) => gmail.messages.get(id)?.labels;

const outcome = (detail: string, ok: boolean) => async (): Promise<MethodOutcome> => ({ ok, detail });
const allowAll = async (): Promise<UrlCheck> => ({ ok: true });

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return { gmail, history, now, checkUrl: vi.fn(allowAll), postOneClick: vi.fn(outcome("HTTP 200", true)), ...overrides };
}

/** Three messages from SENDER across all time (one far outside the scan window) plus one from another sender. */
const seedSenderMail = () =>
  seed(
    { id: "a", from: "Shop <news@shop.com>", daysAgo: 1 },
    { id: "b", from: "news@shop.com", daysAgo: 400, mentionsUnsubscribe: false },
    { id: "c", from: "Shop News <NEWS@shop.com>", daysAgo: 90, labels: ["INBOX", "CATEGORY_PROMOTIONS"] },
    { id: "x", from: "Other <news@other.com>", daysAgo: 1 },
  );

describe("unsubscribeSender: method chain", () => {
  it("one-click success → unsubscribed, methodUsed one-click, history unsubscribed", async () => {
    const checkUrl = vi.fn(allowAll);
    const postOneClick = vi.fn(outcome("HTTP 200", true));
    const r = await unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK, mailto: MAILTO, webUrl: ONE_CLICK }), "leave", makeDeps({ checkUrl, postOneClick }));

    expect(r).toEqual({ sender: SENDER, outcome: "unsubscribed", methodUsed: "one-click", detail: "HTTP 200" });
    expect(checkUrl).toHaveBeenCalledWith(ONE_CLICK);
    expect(postOneClick).toHaveBeenCalledWith(ONE_CLICK);
    expect(gmail.sent).toEqual([]);
    expect(history.get(SENDER)).toEqual({ outcome: "unsubscribed", method: "one-click", at: NOW, detail: "HTTP 200" });
  });

  it("one-click HTTP 500 falls back to mailto → unsubscribed via mailto, detail mentions both", async () => {
    const r = await unsubscribeSender(
      sub(SENDER, { oneClickUrl: ONE_CLICK, mailto: MAILTO, webUrl: ONE_CLICK }),
      "leave",
      makeDeps({ postOneClick: vi.fn(outcome("HTTP 500", false)) }),
    );

    expect(r).toEqual({
      sender: SENDER,
      outcome: "unsubscribed",
      methodUsed: "mailto",
      detail: "one-click: HTTP 500; sent email to unsub@shop.com",
    });
    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0]).toContain("To: unsub@shop.com\r\n");
    expect(history.get(SENDER)).toEqual({ outcome: "unsubscribed", method: "mailto", at: NOW, detail: r.detail });
  });

  it("policy rejection skips POST and falls back", async () => {
    const checkUrl = vi.fn(async (): Promise<UrlCheck> => ({ ok: false, reason: "private address" }));
    const postOneClick = vi.fn(outcome("HTTP 200", true));
    const r = await unsubscribeSender(
      sub(SENDER, { oneClickUrl: "https://10.0.0.1/u", mailto: MAILTO, webUrl: "https://10.0.0.1/u" }),
      "leave",
      makeDeps({ checkUrl, postOneClick }),
    );

    expect(checkUrl).toHaveBeenCalledWith("https://10.0.0.1/u");
    expect(postOneClick).not.toHaveBeenCalled();
    expect(r).toMatchObject({ outcome: "unsubscribed", methodUsed: "mailto" });
    expect(r.detail).toBe("one-click: blocked (private address); sent email to unsub@shop.com");
    expect(gmail.sent).toHaveLength(1);
  });

  it("one-click and mailto fail, webUrl present → manual with manualUrl, history manual-pending", async () => {
    const r = await unsubscribeSender(
      sub(SENDER, { oneClickUrl: ONE_CLICK, mailto: "mailto:not-an-address", webUrl: WEB }),
      "leave",
      makeDeps({ postOneClick: vi.fn(outcome("HTTP 500", false)) }),
    );

    const detail = "one-click: HTTP 500; email: invalid mailto";
    expect(r).toEqual({ sender: SENDER, outcome: "manual", methodUsed: "manual", detail, manualUrl: WEB });
    expect(gmail.sent).toEqual([]);
    expect(history.get(SENDER)).toEqual({ outcome: "manual-pending", method: "manual", at: NOW, detail, manualUrl: WEB });
  });

  it("nothing works and no webUrl → failed, history failed", async () => {
    gmail.failNext = { method: "sendRaw", error: new Error("send failed") };
    const r = await unsubscribeSender(
      sub(SENDER, { oneClickUrl: ONE_CLICK, mailto: MAILTO }),
      "leave",
      makeDeps({ postOneClick: vi.fn(outcome("timed out", false)) }),
    );

    const detail = "one-click: timed out; email: send failed";
    expect(r).toEqual({ sender: SENDER, outcome: "failed", detail });
    expect(history.get(SENDER)).toEqual({ outcome: "failed", at: NOW, detail });
  });

  it("link-only sender → manual without any automatic attempt", async () => {
    const checkUrl = vi.fn(allowAll);
    const postOneClick = vi.fn(outcome("HTTP 200", true));
    const r = await unsubscribeSender(sub(SENDER, { webUrl: "http://shop.com/u" }), "leave", makeDeps({ checkUrl, postOneClick }));

    expect(r).toEqual({
      sender: SENDER,
      outcome: "manual",
      methodUsed: "manual",
      detail: "no automatic unsubscribe method",
      manualUrl: "http://shop.com/u",
    });
    expect(checkUrl).not.toHaveBeenCalled();
    expect(postOneClick).not.toHaveBeenCalled();
    expect(gmail.sent).toEqual([]);
  });

  it("an unexpected exception becomes failed with its message and is recorded in history", async () => {
    const checkUrl = vi.fn(async (): Promise<UrlCheck> => {
      throw new Error("resolver crashed");
    });
    const r = await unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK, mailto: MAILTO }), "trash", makeDeps({ checkUrl }));

    expect(r).toEqual({ sender: SENDER, outcome: "failed", detail: "resolver crashed" });
    expect(history.get(SENDER)).toEqual({ outcome: "failed", at: NOW, detail: "resolver crashed" });
  });

  it("AuthExpiredError from mailto propagates out of unsubscribeSender", async () => {
    gmail.failNext = { method: "sendRaw", error: new AuthExpiredError() };
    await expect(unsubscribeSender(sub(SENDER, { mailto: MAILTO }), "leave", makeDeps())).rejects.toBeInstanceOf(AuthExpiredError);
    expect(history.get(SENDER)).toBeUndefined();
  });
});

describe("unsubscribeSender: cleanup", () => {
  it("cleanup archive removes INBOX from all-time messages of sender only", async () => {
    seedSenderMail();
    const r = await unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK }), "archive", makeDeps());

    expect(r.outcome).toBe("unsubscribed");
    expect(r.cleanup).toEqual({ mode: "archive", ok: true, count: 3 });
    expect(labelsOf("a")).toEqual([]);
    expect(labelsOf("b")).toEqual([]);
    expect(labelsOf("c")).toEqual(["CATEGORY_PROMOTIONS"]);
    expect(labelsOf("x")).toEqual(["INBOX"]);
  });

  it("cleanup trash adds TRASH; result.cleanup.count equals message count", async () => {
    seedSenderMail();
    const r = await unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK }), "trash", makeDeps());

    expect(r.cleanup).toEqual({ mode: "trash", ok: true, count: 3 });
    for (const id of ["a", "b", "c"]) expect(labelsOf(id)).toContain("TRASH");
    expect(labelsOf("x")).toEqual(["INBOX"]);
  });

  it("cleanup failure is reported but outcome stays unsubscribed", async () => {
    seedSenderMail();
    gmail.failNext = { method: "trash", error: new Error("quota exceeded") };
    const r = await unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK }), "trash", makeDeps());

    expect(r).toEqual({
      sender: SENDER,
      outcome: "unsubscribed",
      methodUsed: "one-click",
      detail: "HTTP 200",
      cleanup: { mode: "trash", ok: false, error: "quota exceeded" },
    });
    expect(history.get(SENDER)).toMatchObject({ outcome: "unsubscribed" });
    expect(labelsOf("a")).toEqual(["INBOX"]);
  });

  it("failed sender is not cleaned up", async () => {
    seedSenderMail();
    const listSpy = vi.spyOn(gmail, "listMessageIds");
    const r = await unsubscribeSender(
      sub(SENDER, { oneClickUrl: ONE_CLICK }),
      "trash",
      makeDeps({ postOneClick: vi.fn(outcome("HTTP 404", false)) }),
    );

    expect(r).toEqual({ sender: SENDER, outcome: "failed", detail: "one-click: HTTP 404" });
    expect(listSpy).not.toHaveBeenCalled();
    for (const id of ["a", "b", "c", "x"]) expect(labelsOf(id)).not.toContain("TRASH");
  });

  it("manual sender is cleaned up", async () => {
    seedSenderMail();
    const r = await unsubscribeSender(sub(SENDER, { webUrl: WEB }), "archive", makeDeps());

    expect(r.outcome).toBe("manual");
    expect(r.cleanup).toEqual({ mode: "archive", ok: true, count: 3 });
    expect(labelsOf("a")).toEqual([]);
    expect(labelsOf("x")).toEqual(["INBOX"]);
  });

  it("leave does not touch the mailbox", async () => {
    seedSenderMail();
    const listSpy = vi.spyOn(gmail, "listMessageIds");
    const r = await unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK }), "leave", makeDeps());

    expect(r.cleanup).toBeUndefined();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("searches Gmail with from:(<sender>)", async () => {
    const listSpy = vi.spyOn(gmail, "listMessageIds");
    await unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK }), "archive", makeDeps());
    expect(listSpy).toHaveBeenCalledWith("from:(news@shop.com)");
  });

  it("a sender address that would change the Gmail search is not cleaned up", async () => {
    seedSenderMail();
    const listSpy = vi.spyOn(gmail, "listMessageIds");
    for (const sender of ["-news@shop.com", "news@shop.com)OR(from:other.com", "news{a}@shop.com", "in:inbox@shop.com"]) {
      const r = await unsubscribeSender(sub(sender, { oneClickUrl: ONE_CLICK }), "trash", makeDeps());
      expect(r.outcome).toBe("unsubscribed");
      expect(r.cleanup).toEqual({ mode: "trash", ok: false, error: "sender address can't be searched safely" });
    }
    expect(listSpy).not.toHaveBeenCalled();
    for (const id of ["a", "b", "c", "x"]) expect(labelsOf(id)).not.toContain("TRASH");
  });

  it("AuthExpiredError during cleanup propagates after history was written", async () => {
    seedSenderMail();
    gmail.failNext = { method: "archive", error: new AuthExpiredError() };
    await expect(unsubscribeSender(sub(SENDER, { oneClickUrl: ONE_CLICK }), "archive", makeDeps())).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(history.get(SENDER)).toEqual({ outcome: "unsubscribed", method: "one-click", at: NOW, detail: "HTTP 200" });
  });
});

describe("runUnsubscribe", () => {
  it("runUnsubscribe calls onResult per sender and respects concurrency 4", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const postOneClick = vi.fn(async (): Promise<MethodOutcome> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, detail: "HTTP 200" };
    });
    const subs = Array.from({ length: 10 }, (_, i) => sub(`s${i}@shop.com`, { oneClickUrl: `https://unsub.shop.com/u/${i}` }));
    const seen: SenderResult[] = [];

    const results = await runUnsubscribe(subs, "leave", makeDeps({ postOneClick }), (r) => seen.push(r));

    expect(maxInFlight).toBe(4);
    expect(postOneClick).toHaveBeenCalledTimes(10);
    expect(seen.map((r) => r.sender).sort()).toEqual(subs.map((s) => s.sender).sort());
    expect(results.map((r) => r.sender)).toEqual(subs.map((s) => s.sender));
    expect(results.every((r) => r.outcome === "unsubscribed")).toBe(true);
    for (const s of subs) expect(history.get(s.sender)).toMatchObject({ outcome: "unsubscribed" });
  });

  it("concurrency can be overridden", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const postOneClick = vi.fn(async (): Promise<MethodOutcome> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, detail: "HTTP 200" };
    });
    const subs = Array.from({ length: 5 }, (_, i) => sub(`s${i}@shop.com`, { oneClickUrl: `https://unsub.shop.com/u/${i}` }));

    await runUnsubscribe(subs, "leave", makeDeps({ postOneClick, concurrency: 2 }), () => {});

    expect(maxInFlight).toBe(2);
  });

  it("AuthExpiredError aborts runUnsubscribe and rejects", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const postOneClick = vi.fn(async (): Promise<MethodOutcome> => {
      await gate;
      return { ok: true, detail: "HTTP 200" };
    });
    gmail.failNext = { method: "sendRaw", error: new AuthExpiredError() };
    const subs = [
      sub("expired@shop.com", { mailto: MAILTO }), // hits AuthExpiredError
      sub("inflight@shop.com", { oneClickUrl: "https://unsub.shop.com/u/inflight" }), // already running, must finish
      ...Array.from({ length: 4 }, (_, i) => sub(`later${i}@shop.com`, { oneClickUrl: `https://unsub.shop.com/u/${i}` })),
    ];
    const onResult = vi.fn();

    const run = runUnsubscribe(subs, "leave", makeDeps({ postOneClick, concurrency: 2 }), onResult);
    let settled = false;
    run.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toBe(false); // still waiting for the in-flight sender
    release();
    await expect(run).rejects.toBeInstanceOf(AuthExpiredError);

    expect(postOneClick).toHaveBeenCalledTimes(1);
    expect(postOneClick).toHaveBeenCalledWith("https://unsub.shop.com/u/inflight");
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ sender: "inflight@shop.com", outcome: "unsubscribed" }));
    for (let i = 0; i < 4; i++) expect(history.get(`later${i}@shop.com`)).toBeUndefined();
  });
});

describe("statusFromResult", () => {
  it("maps each outcome to the row status", () => {
    const r = (outcome: SenderResult["outcome"]): SenderResult => ({ sender: SENDER, outcome, detail: "" });
    expect(statusFromResult(r("unsubscribed"))).toBe("unsubscribed");
    expect(statusFromResult(r("manual"))).toBe("manual");
    expect(statusFromResult(r("failed"))).toBe("failed");
  });
});
