import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types";
import { ApiError, api, pollJob } from "../../web/api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const job = (state: Job["state"]): Job => ({
  id: "j1",
  kind: "scan",
  state,
  progress: { done: 0, total: 0 },
  results: [],
  senders: [],
  startedAt: 0,
});

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api", () => {
  it("POSTs JSON bodies with Content-Type application/json (the CSRF guard requires it)", async () => {
    fetchMock.mockResolvedValue(json({ jobId: "j1" }, 202));
    await api.startUnsubscribe({ senders: ["a@x.com"], cleanup: "trash" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/unsubscribe");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ senders: ["a@x.com"], cleanup: "trash" });
  });

  it("startScan maps 202 to { ok: true, jobId } and 409 to { ok: false, activeJobId }", async () => {
    fetchMock.mockResolvedValueOnce(json({ jobId: "j1" }, 202)).mockResolvedValueOnce(json({ activeJobId: "j0" }, 409));
    expect(await api.startScan()).toEqual({ ok: true, jobId: "j1" });
    expect(await api.startScan()).toEqual({ ok: false, activeJobId: "j0" });
  });

  it("latestScan and job map 404 to null", async () => {
    fetchMock.mockImplementation(async () => json({ error: "NOT_FOUND" }, 404));
    expect(await api.latestScan()).toBeNull();
    expect(await api.job("gone")).toBeNull();
  });

  it("rejects with ApiError carrying the status and error code on other failures", async () => {
    fetchMock.mockResolvedValue(json({ error: "NOT_SIGNED_IN" }, 401));
    const err = await api.latestScan().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "NOT_SIGNED_IN" });
  });
});

describe("pollJob", () => {
  it("polls every interval until the job is done, then stops", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(job("running")))
      .mockResolvedValueOnce(json(job("running")))
      .mockResolvedValueOnce(json(job("done")));
    const updates: (Job | null)[] = [];
    pollJob("j1", (j) => updates.push(j), 500);

    await vi.advanceTimersByTimeAsync(0);
    expect(updates.map((j) => j?.state)).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.map((j) => j?.state)).toEqual(["running", "running", "done"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/jobs/j1");
  });

  it("stops on an error state and on a missing job (null)", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json(job("error")));
    const errored: (Job | null)[] = [];
    pollJob("j1", (j) => errored.push(j), 500);
    await vi.advanceTimersByTimeAsync(5000);
    expect(errored.map((j) => j?.state)).toEqual(["error"]);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ error: "NOT_FOUND" }, 404));
    const missing: (Job | null)[] = [];
    pollJob("gone", (j) => missing.push(j), 500);
    await vi.advanceTimersByTimeAsync(5000);
    expect(missing).toEqual([null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancel stops polling, including an update already in flight", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json(job("running")));
    const updates: (Job | null)[] = [];
    const cancel = pollJob("j1", (j) => updates.push(j), 500);
    cancel(); // the first request is already in flight
    await vi.advanceTimersByTimeAsync(5000);
    expect(updates).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on the next interval after a failed request", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json(job("done")));
    const updates: (Job | null)[] = [];
    pollJob("j1", (j) => updates.push(j), 500);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(updates.map((j) => j?.state)).toEqual(["done"]);
  });
});
