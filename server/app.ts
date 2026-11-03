import express from "express";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { statusFromResult } from "../shared/status";
import type { CleanupMode, HistoryEntry, ScanResult, StatusResponse, Subscription } from "../shared/types";
import { InvalidStateError, type GoogleAuth } from "./auth/google";
import type { AppConfig } from "./config";
import { fakeEndpointsRouter } from "./demo";
import { AuthExpiredError, type GmailClient } from "./gmail/types";
import type { JobControl, JobRegistry } from "./jobs";
import { scanMailbox } from "./scan/scanner";
import { csrfGuard, hostGuard, originGuard } from "./security";
import type { HistoryStore } from "./store/history";
import type { MethodOutcome } from "./unsub/methods";
import { runUnsubscribe, type RunnerDeps } from "./unsub/runner";
import type { UrlCheck } from "./unsub/urlPolicy";

export interface AppDeps {
  config: AppConfig;
  gmail: GmailClient;
  /** Undefined in demo mode and when OAuth isn't configured. */
  auth?: GoogleAuth;
  history: HistoryStore;
  jobs: JobRegistry;
  checkUrl: (url: string) => Promise<UrlCheck>;
  postOneClick: (url: string) => Promise<MethodOutcome>;
  now?: () => number;
  /** Demo only: reseeds the fake mailbox. */
  demoReset?: () => Promise<void>;
}

interface AppState {
  scan?: ScanResult;
  email?: string;
}

const DEMO_EMAIL = "demo@example.com";
const CLEANUP_MODES: readonly string[] = ["leave", "archive", "trash"] satisfies CleanupMode[];
const BAD_STATE_PAGE = 'Sign-in link expired or invalid. <a href="/">Try again</a>';

const isCleanupMode = (v: unknown): v is CleanupMode => typeof v === "string" && CLEANUP_MODES.includes(v);

/**
 * Thrown into a job whose session ended (logout, demo reset). It is an AuthExpiredError, so the
 * scanner and runner stop on it without recording anything.
 */
class SessionEndedError extends AuthExpiredError {
  constructor() {
    super("The session ended while the job was running");
    this.name = "SessionEndedError";
  }
}

/** Validates an unsubscribe body against the scan; duplicate senders are run once. */
function parseUnsubscribe(body: unknown, scan: ScanResult): { subs: Subscription[]; cleanup: CleanupMode } | { error: string } {
  const { senders, cleanup } = (body ?? {}) as { senders?: unknown; cleanup?: unknown };
  if (!Array.isArray(senders) || senders.length === 0 || !senders.every((s): s is string => typeof s === "string")) {
    return { error: "INVALID_SENDERS" };
  }
  if (!isCleanupMode(cleanup)) return { error: "INVALID_CLEANUP" };
  const rows = new Map(scan.subscriptions.map((s) => [s.sender, s]));
  const subs: Subscription[] = [];
  for (const sender of new Set(senders)) {
    const row = rows.get(sender);
    if (!row) return { error: "UNKNOWN_SENDER" };
    subs.push(row);
  }
  return { subs, cleanup };
}

function sendJobStart(res: Response, started: ReturnType<JobRegistry["start"]>): void {
  if (started.ok) res.status(202).json({ jobId: started.job.id });
  else res.status(409).json({ activeJobId: started.activeJobId });
}

/** The API (§5) behind the host guard, plus the demo's fake endpoints. The caller adds the SPA after it. */
export function createApp(deps: AppDeps): express.Express {
  const { config, gmail, auth, history, jobs } = deps;
  const now = deps.now ?? Date.now;
  // Replaced, never cleared in place, on logout and demo reset. A job still running from before
  // then writes only to the old object, so its result can't leak into the new session, and its
  // sessionDeps stop it from touching Gmail or history again.
  let state: AppState = {};

  /**
   * What a job started in session `s` runs with. Once that session ends, every Gmail call, URL check,
   * one-click POST and history write throws SessionEndedError instead of running, and a call already
   * in flight has its result dropped. The job stops there: nothing reaches the next session's mailbox
   * or history, and forSession doesn't mark the sign-in expired. (jobs.clear() forgets the job, so
   * without this a second job could start while the first kept going.)
   */
  function sessionDeps(s: AppState): RunnerDeps {
    const ensureLive = () => {
      if (s !== state) throw new SessionEndedError();
    };
    async function live<R>(call: () => Promise<R>): Promise<R> {
      ensureLive();
      let value: R;
      try {
        value = await call();
      } catch (err) {
        ensureLive();
        throw err;
      }
      ensureLive();
      return value;
    }
    return {
      gmail: {
        getProfileEmail: (...a) => live(() => gmail.getProfileEmail(...a)),
        listMessageIds: (...a) => live(() => gmail.listMessageIds(...a)),
        getMessageMetadata: (...a) => live(() => gmail.getMessageMetadata(...a)),
        sendRaw: (...a) => live(() => gmail.sendRaw(...a)),
        archive: (...a) => live(() => gmail.archive(...a)),
        trash: (...a) => live(() => gmail.trash(...a)),
      },
      history: { set: (...a) => live(() => history.set(...a)) },
      checkUrl: (url) => live(() => deps.checkUrl(url)),
      postOneClick: (url) => live(() => deps.postOneClick(url)),
      now,
    };
  }

  const isSignedIn = () => (auth ? auth.isSignedIn() : config.demo);
  const requireSignedIn: RequestHandler = (_req, res, next) => {
    if (isSignedIn()) return next();
    res.status(401).json({ error: "NOT_SIGNED_IN" });
  };

  /** Job body wrapper: an expired sign-in fails the job and signs the user out (§10), unless the session was reset meanwhile. */
  const forSession =
    (s: AppState, body: (ctl: JobControl) => Promise<void>) =>
    async (ctl: JobControl): Promise<void> => {
      try {
        await body(ctl);
      } catch (err) {
        if (err instanceof AuthExpiredError && s === state) await auth?.markExpired();
        throw err;
      }
    };

  /** Cached per session. Auth expiry signs the user out; other errors just leave the email out. */
  async function profileEmail(s: AppState): Promise<string | undefined> {
    try {
      return (s.email ??= await gmail.getProfileEmail());
    } catch (err) {
      if (err instanceof AuthExpiredError) await auth?.markExpired();
      else console.warn("Could not read the Gmail profile:", err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  const app = express();
  app.use(hostGuard(config.port));

  if (config.demo) {
    app.use("/__fake", fakeEndpointsRouter());
    // No JSON requirement (test harnesses post it bare), but a cross-site page still can't trigger it.
    app.post("/__fake/reset", originGuard(config.port), async (_req, res) => {
      // End the session first, so a running job can't write to the history cleared below.
      state = {};
      jobs.clear();
      await deps.demoReset?.();
      await history.clear();
      res.json({ ok: true });
    });
  }

  app.use("/api", csrfGuard(config.port), express.json({ limit: "100kb" }));

  app.get("/api/status", async (_req, res) => {
    const email = config.demo ? DEMO_EMAIL : isSignedIn() ? await profileEmail(state) : undefined;
    const body: StatusResponse = { configured: config.configured, demo: config.demo, signedIn: isSignedIn(), hasScan: state.scan !== undefined };
    if (email) body.email = email;
    if (auth?.authError) body.authError = auth.authError;
    const active = jobs.active;
    if (active) body.activeJobId = active.id;
    res.json(body);
  });

  app.get("/api/auth/login", (_req, res, next) => {
    if (!auth) return next();
    res.redirect(302, auth.createAuthUrl());
  });

  app.get("/api/auth/callback", async (req, res, next) => {
    if (!auth) return next();
    const { code, state: oauthState } = req.query;
    try {
      await auth.handleCallback(typeof code === "string" ? code : undefined, typeof oauthState === "string" ? oauthState : undefined);
    } catch (err) {
      if (!(err instanceof InvalidStateError)) throw err;
      res.status(400).type("html").send(BAD_STATE_PAGE);
      return;
    }
    state.email = undefined;
    res.redirect(302, "/");
  });

  app.post("/api/auth/logout", async (_req, res) => {
    // End the session first: a running job stops before revoking empties the credentials under it.
    state = {};
    jobs.clear();
    await auth?.logout();
    res.json({ ok: true });
  });

  app.post("/api/scan", requireSignedIn, (_req, res) => {
    const s = state;
    const { gmail: sessionGmail } = sessionDeps(s);
    const run = forSession(s, async (ctl) => {
      s.scan = await scanMailbox({ gmail: sessionGmail, history, now, onProgress: ctl.setProgress });
    });
    sendJobStart(res, jobs.start("scan", [], run));
  });

  app.get("/api/scan/latest", requireSignedIn, (_req, res) => {
    if (!state.scan) return void res.status(404).json({ error: "NO_SCAN" });
    res.json(state.scan);
  });

  app.post("/api/unsubscribe", requireSignedIn, (req, res) => {
    const s = state;
    if (!s.scan) return void res.status(400).json({ error: "NO_SCAN" });
    const parsed = parseUnsubscribe(req.body, s.scan);
    if ("error" in parsed) return void res.status(400).json(parsed);
    const { subs, cleanup } = parsed;
    const rows = new Map(subs.map((sub) => [sub.sender, sub]));
    const runnerDeps = sessionDeps(s);
    const run = forSession(s, async (ctl) => {
      let done = 0;
      ctl.setProgress(0, subs.length);
      await runUnsubscribe(subs, cleanup, runnerDeps, (r) => {
        const row = rows.get(r.sender);
        if (row) {
          row.status = statusFromResult(r);
          const last = history.get(r.sender);
          if (last) row.lastAttempt = last;
        }
        ctl.addResult(r);
        ctl.setProgress(++done, subs.length);
      });
    });
    sendJobStart(res, jobs.start("unsubscribe", subs.map((sub) => sub.sender), run));
  });

  app.post("/api/manual-done", requireSignedIn, async (req, res) => {
    const scan = state.scan;
    if (!scan) return void res.status(400).json({ error: "NO_SCAN" });
    const sender: unknown = (req.body as { sender?: unknown } | undefined)?.sender;
    const row = typeof sender === "string" ? scan.subscriptions.find((s) => s.sender === sender) : undefined;
    if (!row) return void res.status(400).json({ error: "UNKNOWN_SENDER" });
    const entry: HistoryEntry = { outcome: "manual-done", method: "manual", at: now(), detail: "marked done by user" };
    const manualUrl = history.get(row.sender)?.manualUrl ?? row.targets.webUrl;
    if (manualUrl) entry.manualUrl = manualUrl;
    await history.set(row.sender, entry);
    row.status = "unsubscribed";
    row.lastAttempt = entry;
    res.json({ ok: true });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return void res.status(404).json({ error: "NOT_FOUND" });
    res.json(job);
  });

  // Unknown API paths must not fall through to the SPA that index.ts mounts next.
  app.use("/api", (_req, res) => void res.status(404).json({ error: "NOT_FOUND" }));

  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) return void res.status(status).json({ error: "BAD_REQUEST" });
    console.error(err);
    res.status(500).json({ error: "INTERNAL" });
  };
  app.use(onError);

  return app;
}
