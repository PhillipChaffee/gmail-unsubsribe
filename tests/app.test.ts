import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { GoogleAuth } from "../server/auth/google";
import { loadConfig } from "../server/config";
import { FakeGmailClient, fakeMessage, type FakeMessageSpec } from "../server/gmail/fake";
import { AuthExpiredError } from "../server/gmail/types";
import { JobRegistry } from "../server/jobs";
import { HistoryStore } from "../server/store/history";
import { TokenStore } from "../server/store/tokens";
import type { MethodOutcome } from "../server/unsub/methods";
import type { Job, ScanResult, StatusResponse } from "../shared/types";

const NOW = 1_700_000_000_000;
const now = () => NOW;
const HOST = "127.0.0.1:3000";

const SHOP: FakeMessageSpec = { id: "s1", from: "Shop <news@shop.example>", daysAgo: 1 };
const SHOP_OLDER: FakeMessageSpec = { id: "s2", from: "Shop <news@shop.example>", daysAgo: 3 };
const BLOG: FakeMessageSpec = { id: "b1", from: "Blog <hi@blog.example>", daysAgo: 2 };
const LINK_ONLY: FakeMessageSpec = {
  id: "l1",
  from: "Links <links@web.example>",
  daysAgo: 1,
  listUnsubscribe: "<http://web.example/prefs>",
  oneClick: false,
};

/** A default fakeMessage sender: https one-click plus mailto. */
const oneClickSpec = (n: number): FakeMessageSpec => ({ id: `o${n}`, from: `Offers ${n} <deals@offers${n}.example>`, daysAgo: 1 });
const mailtoOnlySpec = (n: number): FakeMessageSpec => ({
  id: `m${n}`,
  from: `List ${n} <list@mail${n}.example>`,
  daysAgo: 1,
  listUnsubscribe: `<mailto:unsub@mail${n}.example>`,
  oneClick: false,
});
const senderOf = (spec: FakeMessageSpec) => /<([^>]+)>/.exec(spec.from)![1]!;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The i-th job started through a `vi.spyOn(jobs, "start")` spy; it stays observable after jobs.clear(). */
function startedJob(start: { mock: { results: { value: unknown }[] } }, i: number): Job {
  const started = start.mock.results[i]!.value as ReturnType<JobRegistry["start"]>;
  if (!started.ok) throw new Error("job did not start");
  return started.job;
}

/** Demo-style deps by default (auth undefined); `mode: "google"` adds a real GoogleAuth with an empty token store. */
async function setup(opts: { specs?: FakeMessageSpec[]; mode?: "demo" | "google" | "unconfigured" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "app-test-"));
  const mode = opts.mode ?? "demo";
  const env: NodeJS.ProcessEnv = { PORT: "3000", DATA_DIR: dir };
  if (mode === "demo") env.FAKE_GMAIL = "1";
  if (mode === "google") Object.assign(env, { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
  const config = loadConfig(env, [], dir);
  const auth =
    mode === "google"
      ? new GoogleAuth({ clientId: "id", clientSecret: "secret", redirectUri: config.redirectUri, tokens: new TokenStore(join(dir, "tokens.json")), now })
      : undefined;
  const gmail = new FakeGmailClient({ now, messages: (opts.specs ?? [SHOP, SHOP_OLDER, BLOG, LINK_ONLY]).map((s) => fakeMessage(s, NOW)) });
  const history = await HistoryStore.open(join(dir, "history.json"));
  const jobs = new JobRegistry({ now });
  const postOneClick = vi.fn(async (_url: string): Promise<MethodOutcome> => ({ ok: true, detail: "HTTP 200" }));
  const demoReset = vi.fn(async () => {});
  const app = createApp({ config, gmail, auth, history, jobs, checkUrl: async () => ({ ok: true }), postOneClick, now, demoReset });
  return { app, auth, gmail, history, jobs, postOneClick, demoReset, ...client(app) };
}

function client(app: Express) {
  return {
    get: (path: string) => request(app).get(path).set("Host", HOST).set("Content-Type", "application/json"),
    post: (path: string, body: object = {}) =>
      request(app).post(path).set("Host", HOST).set("Content-Type", "application/json").send(body),
  };
}

type Client = ReturnType<typeof client>;

async function pollJob(c: Client, id: string, until: (j: Job) => boolean = (j) => j.state !== "running"): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const r = await c.get(`/api/jobs/${id}`);
    expect(r.status).toBe(200);
    if (until(r.body as Job)) return r.body as Job;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error(`job ${id} did not reach the expected state`);
}

async function scan(c: Client): Promise<ScanResult> {
  const r = await c.post("/api/scan");
  expect(r.status).toBe(202);
  expect((await pollJob(c, r.body.jobId)).state).toBe("done");
  return (await c.get("/api/scan/latest")).body as ScanResult;
}

const row = (s: ScanResult, sender: string) => s.subscriptions.find((x) => x.sender === sender);

describe("status", () => {
  it("GET /api/status → configured, signedIn, demo email, hasScan false", async () => {
    const t = await setup();
    const r = await t.get("/api/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: true, signedIn: true, demo: true, email: "demo@example.com", hasScan: false } satisfies StatusResponse);
  });

  it("reports the Gmail profile email when signed in with Google, fetching it once", async () => {
    const t = await setup({ mode: "google" });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    const profile = vi.spyOn(t.gmail, "getProfileEmail").mockResolvedValue("me@gmail.com");
    expect((await t.get("/api/status")).body).toEqual({ configured: true, signedIn: true, demo: false, email: "me@gmail.com", hasScan: false });
    await t.get("/api/status");
    expect(profile).toHaveBeenCalledTimes(1);
  });

  it("AuthExpiredError from the profile lookup marks the sign-in expired", async () => {
    const t = await setup({ mode: "google" });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    const markExpired = vi.spyOn(t.auth!, "markExpired");
    t.gmail.failNext = { method: "getProfileEmail", error: new AuthExpiredError() };
    const r = await t.get("/api/status");
    expect(r.body).toEqual({ configured: true, signedIn: false, demo: false, authError: "expired", hasScan: false });
    expect(markExpired).toHaveBeenCalledTimes(1);
  });

  it("other profile lookup errors leave the email out instead of failing", async () => {
    const t = await setup({ mode: "google" });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.gmail.failNext = { method: "getProfileEmail", error: new Error("network down") };
    const r = await t.get("/api/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: true, signedIn: true, demo: false, hasScan: false });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("without OAuth config: configured false, signed out, Gmail routes 401", async () => {
    const t = await setup({ mode: "unconfigured" });
    expect((await t.get("/api/status")).body).toEqual({ configured: false, signedIn: false, demo: false, hasScan: false });
    expect((await t.post("/api/scan")).status).toBe(401);
  });
});

describe("scan", () => {
  it("POST /api/scan → 202 jobId; polling /api/jobs/:id reaches done; /api/scan/latest returns subscriptions", async () => {
    const t = await setup();
    expect((await t.get("/api/scan/latest")).status).toBe(404);
    const r = await t.post("/api/scan");
    expect(r.status).toBe(202);
    expect(typeof r.body.jobId).toBe("string");
    const job = await pollJob(t, r.body.jobId);
    expect(job).toMatchObject({ kind: "scan", state: "done", progress: { done: 4, total: 4 } });

    const latest = await t.get("/api/scan/latest");
    expect(latest.status).toBe(200);
    expect(latest.body.scannedAt).toBe(NOW);
    expect(latest.body.skipped).toBe(0);
    expect(latest.body.subscriptions.map((s: { sender: string }) => s.sender).sort()).toEqual(["hi@blog.example", "links@web.example", "news@shop.example"]);
    expect(row(latest.body, "news@shop.example")).toMatchObject({ count: 2, method: "one-click", status: "active" });
    expect((await t.get("/api/status")).body.hasScan).toBe(true);
  });

  it("POST /api/scan while running → 409 activeJobId", async () => {
    const t = await setup();
    const gate = deferred<string[]>();
    vi.spyOn(t.gmail, "listMessageIds").mockImplementationOnce(() => gate.promise);
    const first = await t.post("/api/scan");
    expect(first.status).toBe(202);

    const second = await t.post("/api/scan");
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ activeJobId: first.body.jobId });
    expect((await t.get("/api/status")).body.activeJobId).toBe(first.body.jobId);

    gate.resolve([]);
    expect((await pollJob(t, first.body.jobId)).state).toBe("done");
    expect((await t.get("/api/status")).body.activeJobId).toBeUndefined();
  });

  it("GET /api/jobs/unknown → 404", async () => {
    const t = await setup();
    const r = await t.get("/api/jobs/unknown");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "NOT_FOUND" });
  });
});

describe("unsubscribe", () => {
  it("POST /api/unsubscribe before scan → 400 NO_SCAN", async () => {
    const t = await setup();
    const r = await t.post("/api/unsubscribe", { senders: ["news@shop.example"], cleanup: "leave" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "NO_SCAN" });
  });

  it("POST /api/unsubscribe with unknown sender or empty list or bad cleanup → 400", async () => {
    const t = await setup();
    await scan(t);
    const bad = [
      { senders: ["nobody@else.example"], cleanup: "leave" },
      { senders: ["news@shop.example", "nobody@else.example"], cleanup: "leave" },
      { senders: [], cleanup: "leave" },
      { senders: "news@shop.example", cleanup: "leave" },
      { senders: [42], cleanup: "leave" },
      { cleanup: "leave" },
      { senders: ["news@shop.example"], cleanup: "delete" },
      { senders: ["news@shop.example"] },
    ];
    for (const body of bad) {
      const r = await t.post("/api/unsubscribe", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
    expect(t.postOneClick).not.toHaveBeenCalled();
    expect((await t.get("/api/status")).body.activeJobId).toBeUndefined();
  });

  it("unsubscribe job results appear incrementally and scan rows get updated statuses", async () => {
    const t = await setup();
    await scan(t);
    const gate = deferred<MethodOutcome>();
    t.postOneClick.mockImplementation(async (url) => (url.includes("blog.example") ? gate.promise : { ok: true, detail: "HTTP 200" }));

    const r = await t.post("/api/unsubscribe", { senders: ["news@shop.example", "hi@blog.example"], cleanup: "archive" });
    expect(r.status).toBe(202);
    const partial = await pollJob(t, r.body.jobId, (j) => j.results.length === 1);
    expect(partial).toMatchObject({ kind: "unsubscribe", state: "running", senders: ["news@shop.example", "hi@blog.example"], progress: { done: 1, total: 2 } });
    expect(partial.results[0]).toMatchObject({ sender: "news@shop.example", outcome: "unsubscribed", methodUsed: "one-click", cleanup: { mode: "archive", ok: true, count: 2 } });

    const mid = (await t.get("/api/scan/latest")).body as ScanResult;
    expect(row(mid, "news@shop.example")).toMatchObject({ status: "unsubscribed", lastAttempt: { outcome: "unsubscribed", method: "one-click", at: NOW } });
    expect(row(mid, "hi@blog.example")?.status).toBe("active");

    gate.resolve({ ok: false, detail: "HTTP 500" });
    const job = await pollJob(t, r.body.jobId);
    expect(job).toMatchObject({ state: "done", progress: { done: 2, total: 2 } });
    expect(job.results[1]).toMatchObject({ sender: "hi@blog.example", outcome: "unsubscribed", methodUsed: "mailto" });

    const end = (await t.get("/api/scan/latest")).body as ScanResult;
    expect(row(end, "hi@blog.example")).toMatchObject({ status: "unsubscribed", lastAttempt: { outcome: "unsubscribed", method: "mailto" } });
    expect(t.history.get("hi@blog.example")?.outcome).toBe("unsubscribed");
    expect(t.gmail.sent).toHaveLength(1);
    expect(t.gmail.messages.get("s1")?.labels).not.toContain("INBOX");
  });

  it("a duplicated sender is unsubscribed once", async () => {
    const t = await setup();
    await scan(t);
    const r = await t.post("/api/unsubscribe", { senders: ["news@shop.example", "news@shop.example"], cleanup: "leave" });
    const job = await pollJob(t, r.body.jobId);
    expect(job.results).toHaveLength(1);
    expect(t.postOneClick).toHaveBeenCalledTimes(1);
  });

  it("manual outcome sets the row to manual with the link", async () => {
    const t = await setup();
    await scan(t);
    const r = await t.post("/api/unsubscribe", { senders: ["links@web.example"], cleanup: "leave" });
    const job = await pollJob(t, r.body.jobId);
    expect(job.results[0]).toMatchObject({ outcome: "manual", manualUrl: "http://web.example/prefs" });
    const latest = (await t.get("/api/scan/latest")).body as ScanResult;
    expect(row(latest, "links@web.example")).toMatchObject({ status: "manual", lastAttempt: { outcome: "manual-pending", manualUrl: "http://web.example/prefs" } });
  });

  it("POST /api/manual-done marks row unsubscribed and writes history", async () => {
    const t = await setup();
    await scan(t);
    const r = await t.post("/api/manual-done", { sender: "links@web.example" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const entry = { outcome: "manual-done", method: "manual", at: NOW, detail: "marked done by user", manualUrl: "http://web.example/prefs" };
    expect(t.history.get("links@web.example")).toEqual(entry);
    const latest = (await t.get("/api/scan/latest")).body as ScanResult;
    expect(row(latest, "links@web.example")).toMatchObject({ status: "unsubscribed", lastAttempt: entry });
  });

  it("POST /api/manual-done rejects a sender outside the scan", async () => {
    const t = await setup();
    expect((await t.post("/api/manual-done", { sender: "links@web.example" })).body).toEqual({ error: "NO_SCAN" });
    await scan(t);
    for (const body of [{ sender: "nobody@else.example" }, { sender: 7 }, {}]) {
      const r = await t.post("/api/manual-done", body);
      expect(r.status).toBe(400);
    }
    expect(t.history.get("nobody@else.example")).toBeUndefined();
  });
});

describe("auth", () => {
  it("Gmail routes return 401 NOT_SIGNED_IN when auth reports signed out", async () => {
    const t = await setup({ mode: "google" });
    vi.spyOn(t.auth!, "isSignedIn").mockReturnValue(false);
    const responses = [
      await t.post("/api/scan"),
      await t.get("/api/scan/latest"),
      await t.post("/api/unsubscribe", { senders: ["news@shop.example"], cleanup: "leave" }),
      await t.post("/api/manual-done", { sender: "links@web.example" }),
    ];
    for (const r of responses) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "NOT_SIGNED_IN" });
    }
    expect((await t.get("/api/status")).body).toEqual({ configured: true, signedIn: false, demo: false, hasScan: false });
  });

  it("AUTH_EXPIRED during scan calls auth.markExpired", async () => {
    const t = await setup({ mode: "google" });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    const markExpired = vi.spyOn(t.auth!, "markExpired");
    t.gmail.failNext = { method: "listMessageIds", error: new AuthExpiredError() };
    const r = await t.post("/api/scan");
    const job = await pollJob(t, r.body.jobId);
    expect(job.state).toBe("error");
    expect(job.error?.code).toBe("AUTH_EXPIRED");
    expect(markExpired).toHaveBeenCalledTimes(1);
    expect((await t.get("/api/status")).body).toMatchObject({ signedIn: false, authError: "expired" });
  });

  it("login redirects to the Google consent screen", async () => {
    const t = await setup({ mode: "google" });
    const r = await t.get("/api/auth/login");
    expect(r.status).toBe(302);
    const url = new URL(r.headers.location!);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("callback with bad state → 400 page", async () => {
    const t = await setup({ mode: "google" });
    const r = await t.get("/api/auth/callback?code=c1&state=bogus");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/^text\/html/);
    expect(r.text).toBe('Sign-in link expired or invalid. <a href="/">Try again</a>');
  });

  it("callback success redirects home and forgets the cached email", async () => {
    const t = await setup({ mode: "google" });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    vi.spyOn(t.gmail, "getProfileEmail").mockResolvedValueOnce("first@gmail.com").mockResolvedValueOnce("second@gmail.com");
    const handle = vi.spyOn(t.auth!, "handleCallback").mockResolvedValue();
    expect((await t.get("/api/status")).body.email).toBe("first@gmail.com");

    const r = await t.get("/api/auth/callback?code=c1&state=s1");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/");
    expect(handle).toHaveBeenCalledWith("c1", "s1");
    expect((await t.get("/api/status")).body.email).toBe("second@gmail.com");
  });

  it("logout signs out, clears the scan and the jobs", async () => {
    const t = await setup({ mode: "google" });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    const logout = vi.spyOn(t.auth!, "logout").mockImplementation(async () => t.auth!.client.setCredentials({}));
    const r1 = await t.post("/api/scan");
    await pollJob(t, r1.body.jobId);

    const r = await t.post("/api/auth/logout");
    expect(r.body).toEqual({ ok: true });
    expect(logout).toHaveBeenCalledTimes(1);
    expect((await t.get("/api/status")).body).toEqual({ configured: true, signedIn: false, demo: false, hasScan: false });
    expect((await t.get(`/api/jobs/${r1.body.jobId}`)).status).toBe(404);
  });

  it("a scan still running at logout neither restores its result nor marks the sign-in expired", async () => {
    const t = await setup({ mode: "google" });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    vi.spyOn(t.auth!, "logout").mockImplementation(async () => t.auth!.client.setCredentials({}));
    const markExpired = vi.spyOn(t.auth!, "markExpired");
    const start = vi.spyOn(t.jobs, "start");
    const gates = [deferred<string[]>(), deferred<string[]>()];
    const listIds = vi
      .spyOn(t.gmail, "listMessageIds")
      .mockImplementationOnce(() => gates[0]!.promise)
      .mockImplementationOnce(() => gates[1]!.promise);
    const metadata = vi.spyOn(t.gmail, "getMessageMetadata");

    // Sign in again after logout so a stale result would be visible.
    await t.post("/api/scan");
    await t.post("/api/auth/logout");
    t.auth!.client.setCredentials({ refresh_token: "r2" });
    gates[0]!.resolve(["s1"]);
    await vi.waitFor(() => expect(startedJob(start, 0).state).not.toBe("running"));
    expect(metadata).not.toHaveBeenCalled(); // the in-flight list result is dropped; the stale scan reads nothing more
    expect((await t.get("/api/status")).body.hasScan).toBe(false);

    await t.post("/api/scan");
    expect(listIds).toHaveBeenCalledTimes(2);
    await t.post("/api/auth/logout");
    gates[1]!.reject(new AuthExpiredError());
    await vi.waitFor(() => expect(startedJob(start, 1).state).toBe("error"));
    expect(markExpired).not.toHaveBeenCalled();
    expect((await t.get("/api/status")).body.authError).toBeUndefined();
  });

  it("logout stops a running unsubscribe: in-flight results are dropped, nothing more is sent, cleaned up or recorded", async () => {
    const specs = [oneClickSpec(1), oneClickSpec(2), oneClickSpec(3), mailtoOnlySpec(1), mailtoOnlySpec(2), LINK_ONLY, oneClickSpec(4)];
    const t = await setup({ mode: "google", specs });
    t.auth!.client.setCredentials({ refresh_token: "r1" });
    vi.spyOn(t.auth!, "logout").mockImplementation(async () => t.auth!.client.setCredentials({}));
    const markExpired = vi.spyOn(t.auth!, "markExpired");
    await scan(t);

    const posts: ReturnType<typeof deferred<MethodOutcome>>[] = [];
    t.postOneClick.mockImplementation(() => {
      const d = deferred<MethodOutcome>();
      posts.push(d);
      return d.promise;
    });
    const mailGate = deferred<void>();
    const sendRaw = vi.spyOn(t.gmail, "sendRaw").mockImplementationOnce(() => mailGate.promise);
    const listIds = vi.spyOn(t.gmail, "listMessageIds");
    const archive = vi.spyOn(t.gmail, "archive");
    const historySet = vi.spyOn(t.history, "set");
    const start = vi.spyOn(t.jobs, "start");

    const r = await t.post("/api/unsubscribe", { senders: specs.map(senderOf), cleanup: "archive" });
    expect(r.status).toBe(202);
    // All four workers are now waiting: three one-click POSTs and one mailto send.
    await vi.waitFor(() => {
      expect(posts).toHaveLength(3);
      expect(sendRaw).toHaveBeenCalledTimes(1);
    });

    await t.post("/api/auth/logout");
    expect((await t.get("/api/status")).body.activeJobId).toBeUndefined();
    // Signed in again (possibly as another account) before the old job drains.
    t.auth!.client.setCredentials({ refresh_token: "r2" });
    t.postOneClick.mockResolvedValue({ ok: true, detail: "HTTP 200" });
    for (const d of posts) d.resolve({ ok: true, detail: "HTTP 200" });
    // What google-auth-library throws once logout has emptied the credentials: not an auth error.
    mailGate.reject(new Error("No access, refresh token, API key or refresh handler callback is set."));
    await vi.waitFor(() => expect(startedJob(start, 0).state).not.toBe("running"));

    expect(historySet).not.toHaveBeenCalled();
    expect(t.history.all()).toEqual({});
    expect(t.postOneClick).toHaveBeenCalledTimes(3);
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(t.gmail.sent).toEqual([]);
    expect(listIds).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(markExpired).not.toHaveBeenCalled();
    expect((await t.get("/api/status")).body).toMatchObject({ signedIn: true, hasScan: false });
  });
});

describe("guards", () => {
  it("foreign Origin POST → 403; text/plain POST → 415; bad Host → 403", async () => {
    const t = await setup();
    const foreign = await request(t.app).post("/api/scan").set("Host", HOST).set("Origin", "http://evil.example").send({});
    expect(foreign.status).toBe(403);
    const plain = await request(t.app).post("/api/scan").set("Host", HOST).set("Content-Type", "text/plain").send("{}");
    expect(plain.status).toBe(415);
    const badHost = await request(t.app).get("/api/status").set("Host", "evil.example:3000");
    expect(badHost.status).toBe(403);
    expect((await t.get("/api/status")).body.activeJobId).toBeUndefined();
  });

  it("unknown /api routes and malformed JSON get JSON errors", async () => {
    const t = await setup();
    const missing = await t.get("/api/nope");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "NOT_FOUND" });
    const malformed = await request(t.app).post("/api/scan").set("Host", HOST).set("Content-Type", "application/json").send("{oops");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "BAD_REQUEST" });
  });
});

describe("demo endpoints", () => {
  it("serves the fake one-click endpoints without the JSON requirement", async () => {
    const t = await setup();
    expect((await request(t.app).post("/__fake/unsub/ok/x1").set("Host", HOST)).status).toBe(200);
    expect((await request(t.app).post("/__fake/unsub/fail/x1").set("Host", HOST)).status).toBe(500);
  });

  it("POST /__fake/reset reseeds and clears history, jobs and the scan", async () => {
    const t = await setup();
    const r1 = await t.post("/api/scan");
    await pollJob(t, r1.body.jobId);
    await t.post("/api/manual-done", { sender: "links@web.example" });

    const r = await request(t.app).post("/__fake/reset").set("Host", HOST);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(t.demoReset).toHaveBeenCalledTimes(1);
    expect(t.history.all()).toEqual({});
    expect((await t.get("/api/status")).body.hasScan).toBe(false);
    expect((await t.get(`/api/jobs/${r1.body.jobId}`)).status).toBe(404);
  });

  it("POST /__fake/reset stops a running unsubscribe, so it can't refill the cleared history", async () => {
    const specs = [oneClickSpec(1), LINK_ONLY, oneClickSpec(2), oneClickSpec(3), oneClickSpec(4), mailtoOnlySpec(1)];
    const t = await setup({ specs });
    await scan(t);
    const posts: ReturnType<typeof deferred<MethodOutcome>>[] = [];
    t.postOneClick.mockImplementation(() => {
      const d = deferred<MethodOutcome>();
      posts.push(d);
      return d.promise;
    });
    const trash = vi.spyOn(t.gmail, "trash");
    const start = vi.spyOn(t.jobs, "start");

    await t.post("/api/unsubscribe", { senders: specs.map(senderOf), cleanup: "trash" });
    // The link-only sender finishes first (recorded and cleaned up before the reset); four one-click POSTs then wait.
    await vi.waitFor(() => {
      expect(posts).toHaveLength(4);
      expect(t.history.get("links@web.example")?.outcome).toBe("manual-pending");
    });
    expect(trash.mock.calls).toEqual([[["l1"]]]);

    expect((await request(t.app).post("/__fake/reset").set("Host", HOST)).status).toBe(200);
    t.postOneClick.mockResolvedValue({ ok: true, detail: "HTTP 200" });
    for (const d of posts) d.resolve({ ok: true, detail: "HTTP 200" });
    await vi.waitFor(() => expect(startedJob(start, 0).state).not.toBe("running"));

    expect(t.history.all()).toEqual({});
    expect(t.gmail.sent).toEqual([]);
    expect(trash).toHaveBeenCalledTimes(1);
    expect(t.postOneClick).toHaveBeenCalledTimes(4);
  });

  it("POST /__fake/reset refuses a cross-site Origin", async () => {
    const t = await setup();
    const r = await request(t.app).post("/__fake/reset").set("Host", HOST).set("Origin", "http://evil.example");
    expect(r.status).toBe(403);
    expect(t.demoReset).not.toHaveBeenCalled();
  });

  it("are not mounted outside demo mode", async () => {
    const t = await setup({ mode: "google" });
    expect((await request(t.app).post("/__fake/reset").set("Host", HOST)).status).toBe(404);
    expect((await request(t.app).post("/__fake/unsub/ok/x1").set("Host", HOST)).status).toBe(404);
  });
});
