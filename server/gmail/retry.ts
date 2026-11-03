import { RETRY } from "../constants";

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// googleapis/gaxios error shapes are loose; narrow from `unknown` here only.
type ErrorShape = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  errors?: { reason?: unknown }[];
  response?: { status?: unknown; data?: { error?: unknown } };
};

const asShape = (err: unknown): ErrorShape => (typeof err === "object" && err !== null ? (err as ErrorShape) : {});

function statusOf(err: unknown): number | undefined {
  const e = asShape(err);
  for (const v of [e.status, e.response?.status, e.code]) {
    if (typeof v === "number") return v;
  }
  return undefined;
}

function reasonOf(err: unknown): string | undefined {
  const e = asShape(err);
  const dataErr = e.response?.data?.error;
  const nested = typeof dataErr === "object" && dataErr !== null ? (dataErr as ErrorShape).errors?.[0]?.reason : undefined;
  const reason = e.errors?.[0]?.reason ?? nested;
  return typeof reason === "string" ? reason : undefined;
}

export function isRetryableGmailError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return false;
  if (status === 429 || status >= 500) return true;
  if (status === 403) {
    const reason = reasonOf(err);
    return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
  }
  return false;
}

export function isAuthError(err: unknown): boolean {
  if (statusOf(err) === 401) return true;
  const e = asShape(err);
  if (e.response?.data?.error === "invalid_grant") return true;
  return typeof e.message === "string" && /invalid_grant/.test(e.message);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? RETRY.maxAttempts;
  const baseMs = opts.baseMs ?? RETRY.baseMs;
  const capMs = opts.capMs ?? RETRY.capMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableGmailError(err)) throw err;
      await sleep(random() * Math.min(capMs, baseMs * RETRY.factor ** (attempt - 1)));
    }
  }
}
