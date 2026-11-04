import { describe, expect, it } from "vitest";
import { AuthExpiredError } from "../server/gmail/types";
import { JobRegistry, type JobControl } from "../server/jobs";
import type { SenderResult } from "../shared/types";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));
const result = (sender: string): SenderResult => ({ sender, outcome: "unsubscribed", detail: "ok" });

describe("JobRegistry", () => {
  it("start returns running job; second start while running → {ok:false, activeJobId}", () => {
    const reg = new JobRegistry();
    const d = deferred();
    const a = reg.start("scan", [], () => d.promise);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.job.state).toBe("running");
    expect(reg.active?.id).toBe(a.job.id);
    const b = reg.start("unsubscribe", ["x"], async () => {});
    expect(b).toEqual({ ok: false, activeJobId: a.job.id });
  });

  it("progress and results visible via get()", async () => {
    const reg = new JobRegistry();
    const d = deferred();
    let ctl!: JobControl;
    const a = reg.start("unsubscribe", ["a@x.com"], (c) => ((ctl = c), d.promise));
    if (!a.ok) throw new Error("x");
    ctl.setProgress(1, 3);
    ctl.addResult(result("a@x.com"));
    const j = reg.get(a.job.id)!;
    expect(j.progress).toEqual({ done: 1, total: 3 });
    expect(j.results).toEqual([result("a@x.com")]);
    expect(j.senders).toEqual(["a@x.com"]);
    d.resolve();
  });

  it("JobControl methods are safe to call unbound", async () => {
    const reg = new JobRegistry();
    const d = deferred();
    let setProgress!: JobControl["setProgress"];
    let addResult!: JobControl["addResult"];
    const a = reg.start("scan", [], (c) => (({ setProgress, addResult } = c), d.promise));
    if (!a.ok) throw new Error("x");
    setProgress(2, 5);
    addResult(result("b@x.com"));
    expect(reg.get(a.job.id)!.progress).toEqual({ done: 2, total: 5 });
    expect(reg.get(a.job.id)!.results).toHaveLength(1);
    d.resolve();
  });

  it("resolve → done with finishedAt", async () => {
    const reg = new JobRegistry({ now: () => 42 });
    const a = reg.start("scan", [], async () => {});
    if (!a.ok) throw new Error("x");
    await tick();
    const j = reg.get(a.job.id)!;
    expect(j.state).toBe("done");
    expect(j.finishedAt).toBe(42);
    expect(j.startedAt).toBe(42);
    expect(reg.active).toBeUndefined();
  });

  it("AuthExpiredError → error AUTH_EXPIRED", async () => {
    const reg = new JobRegistry();
    const a = reg.start("scan", [], async () => { throw new AuthExpiredError(); });
    if (!a.ok) throw new Error("x");
    await tick();
    const j = reg.get(a.job.id)!;
    expect(j.state).toBe("error");
    expect(j.error).toEqual({ code: "AUTH_EXPIRED", message: "Google sign-in expired" });
    expect(j.finishedAt).toBeDefined();
  });

  it("generic Error → INTERNAL with message", async () => {
    const reg = new JobRegistry();
    const a = reg.start("scan", [], async () => { throw new Error("boom"); });
    if (!a.ok) throw new Error("x");
    await tick();
    expect(reg.get(a.job.id)!.error).toEqual({ code: "INTERNAL", message: "boom" });
  });

  it("non-Error rejection → INTERNAL", async () => {
    const reg = new JobRegistry();
    const a = reg.start("scan", [], () => Promise.reject("str"));
    if (!a.ok) throw new Error("x");
    await tick();
    expect(reg.get(a.job.id)!.error).toEqual({ code: "INTERNAL", message: "str" });
  });

  it("error with numeric status → GMAIL_ERROR", async () => {
    const reg = new JobRegistry();
    const a = reg.start("scan", [], async () => { throw Object.assign(new Error("rate"), { status: 429 }); });
    const b = reg.start("scan", [], async () => {});
    expect(b.ok).toBe(false);
    if (!a.ok) throw new Error("x");
    await tick();
    expect(reg.get(a.job.id)!.error).toEqual({ code: "GMAIL_ERROR", message: "rate" });
    const c = reg.start("scan", [], async () => { throw Object.assign(new Error("g"), { response: {} }); });
    if (!c.ok) throw new Error("x");
    await tick();
    expect(reg.get(c.job.id)!.error?.code).toBe("GMAIL_ERROR");
  });

  it("a synchronous throw in run is captured as an error", async () => {
    const reg = new JobRegistry();
    const a = reg.start("scan", [], () => { throw new Error("sync"); });
    if (!a.ok) throw new Error("x");
    await tick();
    expect(reg.get(a.job.id)!.error?.message).toBe("sync");
  });

  it("after done, a new job can start", async () => {
    const reg = new JobRegistry();
    reg.start("scan", [], async () => {});
    await tick();
    expect(reg.start("scan", [], async () => {}).ok).toBe(true);
  });

  it("keeps only 20 finished jobs", async () => {
    const reg = new JobRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const r = reg.start("scan", [], async () => {});
      if (!r.ok) throw new Error("x");
      ids.push(r.job.id);
      await tick();
    }
    expect(reg.get(ids[0]!)).toBeUndefined();
    expect(reg.get(ids[4]!)).toBeUndefined();
    expect(reg.get(ids[5]!)).toBeDefined();
    expect(reg.get(ids[24]!)).toBeDefined();
  });

  it("clear drops all jobs", async () => {
    const reg = new JobRegistry();
    const r = reg.start("scan", [], async () => {});
    if (!r.ok) throw new Error("x");
    await tick();
    reg.clear();
    expect(reg.get(r.job.id)).toBeUndefined();
    expect(reg.active).toBeUndefined();
  });
});
