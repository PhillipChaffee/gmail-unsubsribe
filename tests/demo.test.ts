import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoMailbox, demoBaseUrl, demoOneClick, fakeEndpointsRouter } from "../server/demo";
import { FakeGmailClient } from "../server/gmail/fake";
import { scanMailbox } from "../server/scan/scanner";
import { HistoryStore } from "../server/store/history";

const NOW = 1_700_000_000_000;
const BASE = demoBaseUrl(3000);

describe("createDemoMailbox", () => {
  it("produces ≥30 senders with all method types after scanMailbox", async () => {
    const mailbox = createDemoMailbox({ now: NOW, fakeBaseUrl: BASE });
    const gmail = new FakeGmailClient({ now: () => NOW, messages: mailbox });
    const history = await HistoryStore.open(join(await mkdtemp(join(tmpdir(), "demo-test-")), "history.json"));
    const { subscriptions: subs, skipped } = await scanMailbox({ gmail, history, now: () => NOW });

    expect(skipped).toBe(0);
    expect(subs.length).toBeGreaterThanOrEqual(30);
    const byMethod = (m: string) => subs.filter((s) => s.method === m);
    expect(byMethod("one-click").length).toBeGreaterThan(0);
    expect(byMethod("mailto").length).toBeGreaterThan(0);
    expect(byMethod("manual").length).toBeGreaterThan(0);

    // The brief's mix of one-click outcomes, all pointing at the demo's fake endpoints.
    const oneClick = (path: string) => byMethod("one-click").filter((s) => s.targets.oneClickUrl?.startsWith(`${BASE}/__fake/unsub/${path}/`));
    expect(oneClick("ok").length).toBeGreaterThanOrEqual(15);
    expect(oneClick("fail").filter((s) => s.targets.mailto).length).toBe(3);
    expect(oneClick("fail").filter((s) => !s.targets.mailto).length).toBe(1);
    expect(oneClick("redirect").length).toBe(1);
    // Mailto-only, http-only (manual) and DKIM-failing one-click senders (demoted to mailto).
    expect(byMethod("mailto").filter((s) => !s.targets.webUrl).length).toBe(4);
    expect(byMethod("manual").every((s) => s.targets.webUrl?.startsWith("http://"))).toBe(true);
    expect(byMethod("manual").length).toBe(4);
    expect(byMethod("mailto").filter((s) => s.targets.webUrl?.includes("/__fake/unsub/ok/")).length).toBe(2);

    expect(subs.some((s) => s.count === 40)).toBe(true);
    expect(subs.some((s) => s.name === "Café Lumière")).toBe(true);
    expect(mailbox.some((m) => m.headers["from"]?.[0]?.includes("=?UTF-8?"))).toBe(true);

    // The SPAM message and the 45-day-old message exist in the mailbox but stay out of the scan.
    const spam = mailbox.filter((m) => m.labels.includes("SPAM"));
    const old = mailbox.filter((m) => m.internalDate < NOW - 30 * 86_400_000);
    expect(spam).toHaveLength(1);
    expect(old).toHaveLength(1);
    const senderOf = (m: (typeof mailbox)[number]) => /<([^>]+)>/.exec(m.headers["from"]![0]!)![1]!.toLowerCase();
    const scanned = new Set(subs.map((s) => s.sender));
    expect(scanned.has(senderOf(spam[0]!))).toBe(false);
    expect(scanned.has(senderOf(old[0]!))).toBe(false);
  });

  it("gives every message a unique id", () => {
    const mailbox = createDemoMailbox({ now: NOW, fakeBaseUrl: BASE });
    expect(new Set(mailbox.map((m) => m.id)).size).toBe(mailbox.length);
  });
});

describe("fakeEndpointsRouter", () => {
  const app = express().use("/__fake", fakeEndpointsRouter());

  it("fake endpoints return 200/500/302", async () => {
    expect((await request(app).post("/__fake/unsub/ok/a1")).status).toBe(200);
    expect((await request(app).post("/__fake/unsub/fail/a1")).status).toBe(500);
    const redirect = await request(app).post("/__fake/unsub/redirect/a1");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("/");
  });
});

describe("demoOneClick", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("allows the demo's https fake URLs and delivers them to the plain-http fake endpoints", async () => {
    server = http.createServer(express().use("/__fake", fakeEndpointsRouter()));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const { checkUrl, postOneClick } = demoOneClick(port);
    const url = (path: string) => `${demoBaseUrl(port)}/__fake/unsub/${path}/x1`;

    expect(await checkUrl(url("ok"))).toEqual({ ok: true });
    expect(await checkUrl(`http://127.0.0.1:${port}/__fake/unsub/ok/x1`)).toEqual({ ok: true }); // §9's demo allowance
    expect(await postOneClick(url("ok"))).toEqual({ ok: true, detail: "HTTP 200" });
    expect(await postOneClick(url("fail"))).toEqual({ ok: false, detail: "HTTP 500" });
    expect(await postOneClick(url("redirect"))).toEqual({ ok: true, detail: "HTTP 302" });
  });

  it("still applies the normal URL policy outside the fake prefix", async () => {
    const { checkUrl } = demoOneClick(3000);
    expect(await checkUrl("https://127.0.0.1:3000/api/scan")).toEqual({ ok: false, reason: "private address" });
    expect(await checkUrl("https://127.0.0.1:3001/__fake/unsub/ok/x1")).toEqual({ ok: false, reason: "private address" });
  });
});
