import { describe, expect, it, vi } from "vitest";
import { isAuthError, isRetryableGmailError, withRetry } from "../../server/gmail/retry";

const statusErr = (status: number, extra: object = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

function setup() {
  const delays: number[] = [];
  return { delays, opts: { sleep: async (ms: number) => void delays.push(ms), random: () => 1 } };
}

describe("withRetry", () => {
  it("retries 429 then succeeds", async () => {
    const { opts } = setup();
    const fn = vi.fn().mockRejectedValueOnce(statusErr(429)).mockResolvedValueOnce("ok");
    await expect(withRetry(fn, opts)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries 503 and 403 rateLimitExceeded", async () => {
    const { opts } = setup();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(statusErr(503))
      .mockRejectedValueOnce(statusErr(403, { errors: [{ reason: "rateLimitExceeded" }] }))
      .mockRejectedValueOnce(
        statusErr(403, { response: { status: 403, data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } } }),
      )
      .mockResolvedValueOnce("ok");
    await expect(withRetry(fn, opts)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(isRetryableGmailError(statusErr(403, { errors: [{ reason: "forbidden" }] }))).toBe(false);
  });

  it("does not retry 400 or 404", async () => {
    for (const status of [400, 404]) {
      const { opts } = setup();
      const err = statusErr(status);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, opts)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after 5 attempts and rethrows last error", async () => {
    const { opts } = setup();
    const fn = vi.fn().mockImplementation(async () => {
      throw statusErr(500, { n: fn.mock.calls.length });
    });
    await expect(withRetry(fn, opts)).rejects.toMatchObject({ n: 5 });
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("delays follow 500,1000,2000,4000 capped at 16000", async () => {
    const a = setup();
    await expect(withRetry(() => Promise.reject(statusErr(500)), a.opts)).rejects.toThrow();
    expect(a.delays).toEqual([500, 1000, 2000, 4000]);
    const b = setup();
    await expect(withRetry(() => Promise.reject(statusErr(500)), { ...b.opts, maxAttempts: 9 })).rejects.toThrow();
    expect(b.delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 16000, 16000]);
  });

  it("applies full jitter via random()", async () => {
    const delays: number[] = [];
    await expect(
      withRetry(() => Promise.reject(statusErr(500)), { maxAttempts: 2, random: () => 0.5, sleep: async (ms) => void delays.push(ms) }),
    ).rejects.toThrow();
    expect(delays).toEqual([250]);
  });
});

describe("isAuthError", () => {
  it("detects 401 and invalid_grant", () => {
    expect(isAuthError(statusErr(401))).toBe(true);
    expect(isAuthError({ response: { status: 401 } })).toBe(true);
    expect(isAuthError({ response: { data: { error: "invalid_grant" } } })).toBe(true);
    expect(isAuthError(new Error("invalid_grant: Token has been expired or revoked."))).toBe(true);
    expect(isAuthError(statusErr(500))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
