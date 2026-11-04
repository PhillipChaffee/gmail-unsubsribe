import { randomUUID } from "node:crypto";
import type { Job, JobError, SenderResult } from "../shared/types";
import { MAX_FINISHED_JOBS } from "./constants";
import { AuthExpiredError } from "./gmail/types";

/** Methods are closures, so they are safe to pass around unbound (e.g. as a scanner onProgress callback). */
export interface JobControl {
  setProgress(done: number, total: number): void;
  addResult(r: SenderResult): void;
}

function toJobError(err: unknown): JobError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AuthExpiredError) return { code: "AUTH_EXPIRED", message };
  if (typeof err === "object" && err !== null) {
    const e = err as { status?: unknown; response?: unknown };
    if (typeof e.status === "number" || e.response !== undefined) return { code: "GMAIL_ERROR", message };
  }
  return { code: "INTERNAL", message };
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>(); // insertion order = start order
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  get active(): Job | undefined {
    for (const job of this.jobs.values()) if (job.state === "running") return job;
    return undefined;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  start(
    kind: Job["kind"],
    senders: string[],
    run: (ctl: JobControl) => Promise<void>,
  ): { ok: true; job: Job } | { ok: false; activeJobId: string } {
    const active = this.active;
    if (active) return { ok: false, activeJobId: active.id };

    const job: Job = {
      id: randomUUID(),
      kind,
      state: "running",
      progress: { done: 0, total: 0 },
      results: [],
      senders,
      startedAt: this.now(),
    };
    this.jobs.set(job.id, job);

    const ctl: JobControl = {
      setProgress: (done, total) => {
        job.progress = { done, total };
      },
      addResult: (r) => {
        job.results.push(r);
      },
    };

    const finish = (error?: JobError) => {
      if (error) {
        job.error = error;
        job.state = "error";
      } else {
        job.state = "done";
      }
      job.finishedAt = this.now();
      this.evict();
    };

    // run starts synchronously; a synchronous throw is captured like a rejection.
    let running: Promise<void>;
    try {
      running = run(ctl);
    } catch (err) {
      running = Promise.reject(err);
    }
    void running.then(
      () => finish(),
      (err: unknown) => finish(toJobError(err)),
    );

    return { ok: true, job };
  }

  clear(): void {
    this.jobs.clear();
  }

  private evict(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state !== "running");
    for (const j of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) this.jobs.delete(j.id);
  }
}
