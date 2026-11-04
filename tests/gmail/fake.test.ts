import { describe, expect, it } from "vitest";
import { SCAN_QUERY } from "../../server/constants";
import { FakeGmailClient, fakeMessage } from "../../server/gmail/fake";

const NOW = 1_700_000_000_000;
const mk = (spec: Parameters<typeof fakeMessage>[0]) => fakeMessage(spec, NOW);

describe("FakeGmailClient", () => {
  it("scan query excludes SPAM, TRASH, older than 30d, and mentionsUnsubscribe=false", async () => {
    const c = new FakeGmailClient({
      now: () => NOW,
      messages: [
        mk({ id: "old", from: "a@x.com", daysAgo: 5 }),
        mk({ id: "new", from: "a@x.com", daysAgo: 1 }),
        mk({ id: "spam", from: "a@x.com", daysAgo: 1, labels: ["SPAM"] }),
        mk({ id: "trash", from: "a@x.com", daysAgo: 1, labels: ["TRASH"] }),
        mk({ id: "ancient", from: "a@x.com", daysAgo: 31 }),
        mk({ id: "nomention", from: "a@x.com", daysAgo: 1, mentionsUnsubscribe: false }),
      ],
    });
    await expect(c.listMessageIds(SCAN_QUERY)).resolves.toEqual(["new", "old"]);
  });

  it("from:() query matches all-time case-insensitively", async () => {
    const c = new FakeGmailClient({
      now: () => NOW,
      messages: [
        mk({ id: "1", from: "News <News@Example.com>", daysAgo: 100 }),
        mk({ id: "2", from: "news@example.com", daysAgo: 2 }),
        mk({ id: "3", from: "other@example.com", daysAgo: 2 }),
        mk({ id: "4", from: "news@example.com", daysAgo: 2, labels: ["SPAM"] }),
      ],
    });
    await expect(c.listMessageIds("from:(NEWS@example.com)")).resolves.toEqual(["2", "1"]);
  });

  it("archive removes INBOX; trash adds TRASH (then excluded from scan query)", async () => {
    const c = new FakeGmailClient({ now: () => NOW, messages: [mk({ id: "1", from: "a@x.com", daysAgo: 1 }), mk({ id: "2", from: "a@x.com", daysAgo: 2 })] });
    await c.archive(["1"]);
    expect(c.messages.get("1")!.labels).toEqual([]);
    await c.trash(["2"]);
    expect(c.messages.get("2")!.labels).toContain("TRASH");
    await expect(c.listMessageIds(SCAN_QUERY)).resolves.toEqual(["1"]);
  });

  it("sendRaw records raw messages and getProfileEmail returns the email", async () => {
    const c = new FakeGmailClient({ email: "me@demo.test" });
    await c.sendRaw("To: a\r\n\r\nx");
    expect(c.sent).toEqual(["To: a\r\n\r\nx"]);
    await expect(c.getProfileEmail()).resolves.toBe("me@demo.test");
  });

  it("failMetadataFor makes getMessageMetadata reject", async () => {
    const c = new FakeGmailClient({ now: () => NOW, messages: [mk({ id: "1", from: "a@x.com", daysAgo: 1 }), mk({ id: "2", from: "a@x.com", daysAgo: 1 })] });
    c.failMetadataFor.add("1");
    await expect(c.getMessageMetadata("1")).rejects.toThrow();
    await expect(c.getMessageMetadata("2")).resolves.toMatchObject({ id: "2", internalDate: NOW - 86400000 });
  });

  it("failNext injects a one-shot failure", async () => {
    const c = new FakeGmailClient();
    c.failNext = { method: "archive", error: new Error("boom") };
    await expect(c.archive([])).rejects.toThrow("boom");
    await expect(c.archive([])).resolves.toBeUndefined();
  });

  it("reset replaces messages", async () => {
    const c = new FakeGmailClient({ now: () => NOW, messages: [mk({ id: "1", from: "a@x.com", daysAgo: 1 })] });
    c.reset([mk({ id: "9", from: "a@x.com", daysAgo: 1 })]);
    expect([...c.messages.keys()]).toEqual(["9"]);
  });

  it("unknown query throws", async () => {
    const c = new FakeGmailClient();
    await expect(c.listMessageIds("label:foo")).rejects.toThrow(/unsupported/i);
  });
});

describe("fakeMessage", () => {
  it("applies defaults", () => {
    const m = mk({ id: "abc", from: "Shop <deals@shop.example>", daysAgo: 2 });
    expect(m.internalDate).toBe(NOW - 2 * 86400000);
    expect(m.labels).toEqual(["INBOX"]);
    expect(m.mentionsUnsubscribe).toBe(true);
    expect(m.headers["list-unsubscribe"]).toEqual(["<https://unsub.shop.example/u/abc>, <mailto:unsub@shop.example>"]);
    expect(m.headers["list-unsubscribe-post"]).toEqual(["List-Unsubscribe=One-Click"]);
    expect(m.headers["dkim-signature"][0]).toContain("d=shop.example");
    expect(m.headers["dkim-signature"][0]).toContain("h=from:subject:list-unsubscribe:list-unsubscribe-post");
    expect(m.headers["authentication-results"][0]).toMatch(/^mx\.google\.com; dkim=pass header\.i=@shop\.example/);
  });

  it("omits one-click header when oneClick is false and honors dkim fail", () => {
    const m = mk({ id: "1", from: "a@b.test", daysAgo: 0, oneClick: false, dkim: "fail" });
    expect(m.headers["list-unsubscribe-post"]).toBeUndefined();
    expect(m.headers["authentication-results"][0]).toContain("dkim=fail");
  });

  it('fakeMessage(dkim:"none") omits DKIM-Signature and Authentication-Results', () => {
    const m = mk({ id: "1", from: "a@b.test", daysAgo: 0, dkim: "none" });
    expect(m.headers["dkim-signature"]).toBeUndefined();
    expect(m.headers["authentication-results"]).toBeUndefined();
  });
});
