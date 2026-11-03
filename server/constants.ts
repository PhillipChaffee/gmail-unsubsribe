export const SCAN_QUERY = "unsubscribe newer_than:30d";
export const STILL_SENDING_GRACE_MS = 48 * 3600 * 1000;
export const SCAN_CONCURRENCY = 8;
export const UNSUB_CONCURRENCY = 4;
export const ONE_CLICK_TIMEOUT_MS = 10_000;
export const USER_AGENT = "gmail-bulk-unsubscribe/1.0";
/** Exponential backoff with full jitter. */
export const RETRY = { baseMs: 500, factor: 2, maxAttempts: 5, capMs: 16_000 } as const;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_FINISHED_JOBS = 20;
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
