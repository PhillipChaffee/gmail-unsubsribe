import type { BusyResponse, Job, JobStartResponse, ScanResult, StatusResponse, UnsubscribeRequest } from "../shared/types";

/** How often the UI polls a running job (Global Constraints). */
export const POLL_INTERVAL_MS = 500;

export type StartJob = { ok: true; jobId: string } | { ok: false; activeJobId: string };

/** A non-OK API response. `code` is the body's `error` field ('' when there is none). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code ? `Request failed: ${code} (HTTP ${status})` : `Request failed (HTTP ${status})`);
    this.name = "ApiError";
  }
}

/** Mutating routes require a JSON Content-Type (§9). */
const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function readJson<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const body: unknown = await res.json().catch(() => null);
  const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "";
  throw new ApiError(res.status, code);
}

async function readOrNull<T>(res: Response): Promise<T | null> {
  return res.status === 404 ? null : readJson<T>(res);
}

async function readStart(res: Response): Promise<StartJob> {
  if (res.status === 409) return { ok: false, activeJobId: ((await res.json()) as BusyResponse).activeJobId };
  return { ok: true, jobId: (await readJson<JobStartResponse>(res)).jobId };
}

/** The HTTP API (§5). Non-OK responses reject with ApiError, except where null or a busy result is listed. */
export const api = {
  async status(): Promise<StatusResponse> {
    return readJson<StatusResponse>(await fetch("/api/status"));
  },
  async startScan(): Promise<StartJob> {
    return readStart(await post("/api/scan", {}));
  },
  /** null when the server holds no scan (404). */
  async latestScan(): Promise<ScanResult | null> {
    return readOrNull<ScanResult>(await fetch("/api/scan/latest"));
  },
  async startUnsubscribe(req: UnsubscribeRequest): Promise<StartJob> {
    return readStart(await post("/api/unsubscribe", req));
  },
  /** null when the server doesn't know the job (404, e.g. after a restart). */
  async job(id: string): Promise<Job | null> {
    return readOrNull<Job>(await fetch(`/api/jobs/${encodeURIComponent(id)}`));
  },
  async manualDone(sender: string): Promise<void> {
    await readJson(await post("/api/manual-done", { sender }));
  },
  async logout(): Promise<void> {
    await readJson(await post("/api/auth/logout", {}));
  },
};

/**
 * Polls a job: once right away, then every `intervalMs` while it is running. It stops by itself after
 * reporting a done or error job, or null (unknown job). A failed request is retried on the next tick.
 * Returns a cancel function; after cancelling, no further update is reported.
 */
export function pollJob(id: string, onUpdate: (job: Job | null) => void, intervalMs = POLL_INTERVAL_MS): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    if (!cancelled) timer = setTimeout(tick, intervalMs);
  };
  async function tick(): Promise<void> {
    let job: Job | null;
    try {
      job = await api.job(id);
    } catch {
      return next();
    }
    if (cancelled) return;
    onUpdate(job);
    if (job?.state === "running") next();
  }
  void tick();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
