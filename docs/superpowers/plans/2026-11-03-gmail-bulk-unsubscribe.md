# Gmail Bulk Unsubscribe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost web app that connects to a personal Gmail account with OAuth, lists the senders it is subscribed to, and bulk-unsubscribes from selected ones (with optional archive/trash of their mail).

**Architecture:** A single Express 5 server bound to 127.0.0.1 serves a React SPA (Vite middleware in dev, built files with `--prod`) and a JSON API. All Gmail access goes through a `GmailClient` interface, with a googleapis-backed implementation and an in-memory fake used by tests and demo mode. Scans and bulk unsubscribes run as in-memory jobs that the SPA polls.

**Tech Stack:** Node ≥ 22.12, TypeScript 7, Express 5, `@googleapis/gmail` + `google-auth-library`, React 19, Vite 8, TanStack Table v8, Vitest 5, supertest, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-11-03-gmail-bulk-unsubscribe-design.md`. Read it before starting any task. Section numbers below (§n) refer to it.

## Global Constraints

- `package.json`: `"type": "module"`, `"private": true`, `"engines": { "node": ">=22.12" }`.
- Dependencies (exactly these, installed in Task 1; no other runtime deps):
  `express@^5.3.0`, `@googleapis/gmail@^22.0.2`, `google-auth-library@^11.3.2`, `react@^19.3.1`, `react-dom@^19.3.1`, `@tanstack/react-table@^8.21.3` (**v8 API, not v9**).
- Dev dependencies (exactly these): `vite@^8.3.5`, `@vitejs/plugin-react@^6.2.1`, `tsx@^4.23.15`, `typescript@^7.0.2`, `vitest@^5.1.0`, `supertest@^7.3.1`, `@types/express@^5.0.6`, `@types/supertest@^7.2.1`, `@types/react@^19.3.0`, `@types/react-dom@^19.3.0`, `@types/node@^22.0.0`, `@playwright/test@1.63.0` (exact, matching the preinstalled browsers).
- Server listens on host `127.0.0.1` only. Default `PORT` is `3000`.
- OAuth scope is exactly `https://www.googleapis.com/auth/gmail.modify`. Redirect URI is `http://127.0.0.1:${PORT}/api/auth/callback`.
- Data dir is `.data/` (override with `DATA_DIR`) and is git-ignored. Files: `tokens.json` (mode 0600) and `history.json`.
- Demo mode: env `FAKE_GMAIL=1` **or** CLI flag `--demo`. Prod mode: CLI flag `--prod`.
- Constants (define once, import everywhere):
  - Scan: query `unsubscribe newer_than:30d`, still-sending grace `48 * 3600 * 1000`, scan fetch concurrency `8`.
  - Unsubscribe: unsubscribe concurrency `4`, one-click timeout `10000` ms, User-Agent `gmail-bulk-unsubscribe/1.0`.
  - Retry: base `500` ms, factor 2, max `5` attempts, cap `16000` ms, full jitter.
  - Other: UI poll interval `500` ms, OAuth state TTL `10` min, kept finished jobs `20`.
- Exact UI copy:
  - Expired sign-in: "Your Google sign-in expired. Apps in Testing mode must reconnect every 7 days."
  - Demo banner: "Demo mode: fake mailbox".
  - Skipped notice: "N emails couldn't be read".
  - Restart notice: "The server restarted, rescan to continue."
  - Confirm dialog lines and results summary: §3.4 and §3.5.
- TypeScript: `strict: true`, `verbatimModuleSyntax: true`. Use `import type` for types. No `any` in production code except at the googleapis error-shape boundary (`unknown` + narrowing preferred).
- Each task commits its work with a conventional message. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Xp1aFS5A4aa895Q8hGG3m5
  ```

## Review Focus

1. **A hostile `mailto:` header (CR/LF in the address, subject or body)** must never inject extra headers into the sent message. `parseMailto` returns `null` → the runner falls through to manual/failed. Test added in Task 5.
2. **Concurrent history writes** (unsubscribe concurrency 4) must not lose entries or corrupt `history.json`. Test added in Task 1 (20 concurrent `set` calls, all persisted).
3. **A token refresh event without a `refresh_token`** must not erase the stored refresh token. Otherwise the user is silently logged out after an hour. Test added in Task 1 (`TokenStore.save` merge).
4. **Large mailboxes**: `messages.list` pagination across several pages, and per-message fetch failures, must be counted, not crash the scan. Tests added in Task 3 (3-page pagination) and Task 4 (skipped count).
5. **Selected rows that the search box later hides** must not be unsubscribed. The action applies to selected ∩ visible rows only. Test added in Task 11 (E2E: select, filter, confirm count).

---

## File Structure

```
package.json  tsconfig.json  vite.config.ts  vitest.config.ts  playwright.config.ts
.env.example  .gitignore  README.md
shared/types.ts                 Domain + API types shared by server and web
server/constants.ts             All Global Constraints constants
server/util/pool.ts             mapLimit concurrency helper
server/store/json.ts            readJson / writeJsonAtomic
server/store/history.ts         HistoryStore (serialized writes)
server/store/tokens.ts          TokenStore (merge on save, 0600)
server/gmail/types.ts           GmailClient interface, MessageMeta, AuthExpiredError, METADATA_HEADERS
server/gmail/retry.ts           withRetry, isRetryableGmailError, isAuthError
server/gmail/google.ts          GoogleGmailClient (googleapis)
server/gmail/fake.ts            FakeGmailClient + fakeMessage() builder
server/scan/headers.ts          Pure header parsing + analyzeMessage
server/scan/scanner.ts          scanMailbox, deriveStatus
server/unsub/urlPolicy.ts       checkOneClickUrl, isBlockedIp
server/unsub/methods.ts         postOneClick, parseMailto, buildRfc822, sendMailto
server/unsub/runner.ts          unsubscribeSender, runUnsubscribe, statusFromResult
server/auth/google.ts           GoogleAuth (OAuth flow, state, tokens, expiry)
server/config.ts                loadConfig
server/security.ts              hostGuard, csrfGuard
server/jobs.ts                  JobRegistry
server/demo.ts                  createDemoMailbox, fakeEndpointsRouter
server/app.ts                   createApp (API routes + guards)
server/index.ts                 Entry: env, deps, Vite/static, listen
web/index.html  web/main.tsx  web/App.tsx  web/api.ts  web/format.ts  web/styles.css
web/components/SetupNotice.tsx SignIn.tsx Header.tsx ScanProgress.tsx
               SubscriptionTable.tsx StatusCell.tsx ConfirmDialog.tsx ResultsPanel.tsx
tests/...                       Vitest tests mirroring server/ (and tests/web/format.test.ts)
e2e/scan.spec.ts  e2e/unsubscribe.spec.ts
```

## Dependency waves (for parallel execution)

- Wave A: Task 1.
- Wave B (parallel, disjoint files): Tasks 2, 3, 5, 7, 8.
- Wave C: Task 4.
- Wave D: Task 6.
- Wave E: Task 9.
- Wave F: Task 10.
- Wave G: Task 11.
- Wave H: Task 12.

Tasks in Wave B must not edit `package.json`, `shared/types.ts` or `server/gmail/types.ts`. If one needs a change there, report it instead of making it.

---

### Task 1: Scaffold, shared types, persistence

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `shared/types.ts`, `server/constants.ts`, `server/util/pool.ts`, `server/gmail/types.ts`
- Create: `server/store/json.ts`, `server/store/history.ts`, `server/store/tokens.ts`
- Test: `tests/store/json.test.ts`, `tests/store/history.test.ts`, `tests/store/tokens.test.ts`, `tests/util/pool.test.ts`

**Interfaces:**
- Produces: `shared/types.ts`, exactly the spec §6 types plus:
  ```ts
  export type Method = "one-click" | "mailto" | "manual";
  export type Status = "active" | "unsubscribed" | "still-sending" | "manual" | "failed";
  export type CleanupMode = "leave" | "archive" | "trash";
  export interface UnsubTargets { oneClickUrl?: string; mailto?: string; webUrl?: string }
  //   oneClickUrl: set only when one-click eligible (§7.2). webUrl: first https URI, else first http URI.
  export interface HistoryEntry { outcome: "unsubscribed" | "manual-pending" | "manual-done" | "failed"; method?: Method; at: number; detail: string; manualUrl?: string }
  export interface Subscription { sender: string; name: string; count: number; lastReceived: number; latestSubject: string; method: Method; targets: UnsubTargets; status: Status; lastAttempt?: HistoryEntry }
  export interface SenderResult { sender: string; outcome: "unsubscribed" | "manual" | "failed"; methodUsed?: Method; detail: string; manualUrl?: string; cleanup?: { mode: CleanupMode; ok: boolean; count?: number; error?: string } }
  export interface JobError { code: "AUTH_EXPIRED" | "GMAIL_ERROR" | "INTERNAL"; message: string }
  export interface Job { id: string; kind: "scan" | "unsubscribe"; state: "running" | "done" | "error"; progress: { done: number; total: number }; results: SenderResult[]; senders: string[]; error?: JobError; startedAt: number; finishedAt?: number }
  //   senders: the job's sender list (empty for scans); lets the UI mark rows "Unsubscribing…" after a reload.
  export interface ScanResult { scannedAt: number; subscriptions: Subscription[]; skipped: number }
  export interface StatusResponse { configured: boolean; signedIn: boolean; demo: boolean; email?: string; authError?: "expired"; activeJobId?: string; hasScan: boolean }
  export interface UnsubscribeRequest { senders: string[]; cleanup: CleanupMode }
  export interface JobStartResponse { jobId: string }
  export interface BusyResponse { activeJobId: string }
  ```
- Produces: `server/gmail/types.ts`:
  ```ts
  export interface MessageMeta { id: string; internalDate: number; headers: Record<string, string[]> } // header names lowercased
  export interface GmailClient {
    getProfileEmail(): Promise<string>;
    listMessageIds(query: string): Promise<string[]>;            // all pages
    getMessageMetadata(id: string): Promise<MessageMeta>;
    sendRaw(rfc822: string): Promise<void>;
    archive(ids: string[]): Promise<void>;
    trash(ids: string[]): Promise<void>;
  }
  export const METADATA_HEADERS = ["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post", "Authentication-Results", "DKIM-Signature"] as const;
  export class AuthExpiredError extends Error { readonly code = "AUTH_EXPIRED" }
  ```
- Produces: `server/constants.ts`, exporting `SCAN_QUERY`, `STILL_SENDING_GRACE_MS`, `SCAN_CONCURRENCY`, `UNSUB_CONCURRENCY`, `ONE_CLICK_TIMEOUT_MS`, `USER_AGENT`, `RETRY` (`{ baseMs, factor, maxAttempts, capMs }`), `OAUTH_STATE_TTL_MS`, `MAX_FINISHED_JOBS`, `GMAIL_SCOPE`, with the values from Global Constraints.
- Produces: `mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]>`, which preserves input order.
- Produces: `readJson<T>(path: string, fallback: T): Promise<T>` and `writeJsonAtomic(path: string, data: unknown, opts?: { mode?: number }): Promise<void>`.
- Produces: `class HistoryStore { static open(filePath: string): Promise<HistoryStore>; get(sender: string): HistoryEntry | undefined; all(): Record<string, HistoryEntry>; set(sender: string, entry: HistoryEntry): Promise<void>; clear(): Promise<void> }`. File shape: `{ version: 1, senders: {...} }`.
- Produces: `class TokenStore { constructor(filePath: string); load(): Promise<Credentials | null>; save(c: Credentials): Promise<void>; clear(): Promise<void> }`. `Credentials` comes from `google-auth-library`.

- [ ] **Step 1: Scaffold the project**
  - `package.json` scripts:
    - `dev`: `tsx watch server/index.ts`
    - `demo`: `tsx watch server/index.ts --demo`
    - `build`: `vite build`
    - `start`: `vite build && tsx server/index.ts --prod`
    - `test`: `vitest run`
    - `test:e2e`: `playwright test`
    - `typecheck`: `tsc --noEmit`
  - Install the exact deps from Global Constraints.
  - `tsconfig.json`: `target ES2023`, `module ESNext`, `moduleResolution Bundler`, `jsx react-jsx`, `lib ["ES2023","DOM","DOM.Iterable"]`, `types ["node","vite/client"]`, `strict`, `verbatimModuleSyntax`, `esModuleInterop`, `skipLibCheck`, `noEmit`; include `server shared web tests e2e *.ts`.
  - `vite.config.ts`: `root: "web"`, the React plugin, `build.outDir: "../dist"`, `emptyOutDir: true`.
  - `vitest.config.ts`: `test.include ["tests/**/*.test.ts"]`, `environment "node"`.
  - `.gitignore`: `node_modules/ dist/ .data/ .data-*/ .env test-results/ playwright-report/`.
  - `.env.example`: `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`, `PORT=3000`, `# DATA_DIR=.data`, `# FAKE_GMAIL=1`.
- [ ] **Step 2: Write the failing tests**
  - `json.test.ts`
    - `readJson returns fallback when file missing`
    - `writeJsonAtomic then readJson round-trips and creates parent dirs`
    - `writeJsonAtomic applies mode 0o600` (`(await stat(p)).mode & 0o777` is `0o600`)
    - `readJson on invalid JSON returns fallback and renames file to <path>.corrupt-<ts>.json` (the original path no longer exists; a `.corrupt-` sibling exists)
    - `no .tmp files are left behind after write`
  - `history.test.ts`
    - `set then reopen persists entry`
    - `20 concurrent set() calls for different senders all persist` (reopen and check `Object.keys(all()).length === 20`)
    - `clear empties store`
  - `tokens.test.ts`
    - `load returns null when missing`
    - `save merges with existing so refresh_token survives a save without it` (save `{access_token:"a",refresh_token:"r"}`, then `{access_token:"b"}`; load → `{access_token:"b",refresh_token:"r"}`)
    - `file mode is 0600`
    - `clear removes file and load returns null`
  - `pool.test.ts`
    - `never runs more than limit at once` (track the max number in flight with limit 3 over 10 items)
    - `preserves order and captures rejections as settled results`
  - All tests use a fresh `mkdtemp` dir.
- [ ] **Step 3: Run the tests to confirm they fail**. Run `npx vitest run tests/store tests/util`. Expected: FAIL (modules not found).
- [ ] **Step 4: Implement the shared types, constants, pool, json, history and tokens.**
  - `writeJsonAtomic` writes `${path}.${process.pid}.${randomUUID()}.tmp` (with `mode`), then `rename`s it.
  - `HistoryStore` serializes writes through a promise chain (`this.queue = this.queue.then(write)`), keeping the in-memory map as the source of truth.
  - `readJson` corrupt rename suffix: `.corrupt-${Date.now()}.json`, plus a `console.warn`.
- [ ] **Step 5: Run the tests and typecheck.** Run `npx vitest run tests/store tests/util && npm run typecheck`. Expected: all PASS, no TS errors.
- [ ] **Step 6: Commit**: `chore: scaffold project with shared types and persistence stores`.

---

### Task 2: Header parsing (`server/scan/headers.ts`)

**Files:**
- Create: `server/scan/headers.ts`
- Test: `tests/scan/headers.test.ts`

**Interfaces:**
- Consumes: `MessageMeta` (Task 1), `Method` and `UnsubTargets` (Task 1).
- Produces:
  ```ts
  export function decodeRfc2047(s: string): string;
  export function parseFrom(raw: string | undefined): { name: string; address: string } | null; // address lowercased
  export function parseListUnsubscribe(raw: string | undefined): { httpsUrl?: string; webUrl?: string; mailto?: string };
  export function isOneClickPost(raw: string | undefined): boolean;
  export function dkimCoversListUnsubscribe(dkimSignatures: string[], authResults: string[]): boolean;
  export interface AnalyzedMessage { id: string; internalDate: number; sender: string; name: string; subject: string; method: Method; targets: UnsubTargets }
  export function analyzeMessage(meta: MessageMeta): AnalyzedMessage | null; // null when no parsable From or no usable target
  ```

- [ ] **Step 1: Write the failing tests** (`tests/scan/headers.test.ts`)
  - `decodeRfc2047`:
    - `=?UTF-8?B?QWNtZSDinKg=?=` decodes to `Acme ✨`.
    - `=?utf-8?Q?Caf=C3=A9_News?=` decodes to `Café News`.
    - Adjacent encoded words separated only by whitespace are joined without the space.
    - Plain text is returned unchanged.
  - `parseFrom`:
    - `Acme Deals <Deals@Acme.com>` gives `{name:"Acme Deals",address:"deals@acme.com"}`.
    - `"Doe, Jane" <jane@x.io>` gives name `Doe, Jane`.
    - A bare `news@x.io` gives name `""`.
    - The encoded name `=?UTF-8?B?QWNtZSDinKg=?= <a@b.co>` gives name `Acme ✨`.
    - `undefined` and `not an address` give `null`.
  - `parseListUnsubscribe`:
    - `<mailto:u@x.com?subject=unsub>, <https://x.com/u?id=1>` gives `httpsUrl` and `webUrl` = the https URL and `mailto` = the mailto.
    - Folded `"<https://a.com/u>,\r\n <mailto:b@a.com>"` works.
    - Without angle brackets, `https://a.com/u` is still accepted.
    - `<http://a.com/u>` gives `webUrl` set and `httpsUrl` undefined.
    - Both `<http://a.com/1>, <https://a.com/2>` gives `webUrl` = `https://a.com/2`.
    - `<ftp://x>` and garbage give `{}`.
  - `isOneClickPost`: `List-Unsubscribe=One-Click` and ` list-unsubscribe=one-click ` give true. `undefined` and `List-Unsubscribe=Other` give false.
  - `dkimCoversListUnsubscribe`, using `sig = "v=1; a=rsa-sha256; d=news.example.com; s=s1;\r\n h=from:to:subject:list-unsubscribe:list-unsubscribe-post; bh=x; b=y"` and `ar = "mx.google.com;\r\n dkim=pass header.i=@news.example.com header.s=s1 header.b=abc;\r\n spf=pass smtp.mailfrom=x"`:
    - `[sig]` with `[ar]` gives true.
    - `header.i=@mail.news.example.com` (a subdomain of d) gives true.
    - `dkim=fail` gives false.
    - An `h=` without `list-unsubscribe-post` gives false.
    - An authserv-id of `evil.com` gives false.
    - A `d=` mismatch (`d=other.com`) gives false.
    - Empty arrays give false.
  - `analyzeMessage`:
    - With the One-Click header, an https URL and passing DKIM: `method:"one-click"`, `targets.oneClickUrl` set.
    - The same headers with failing DKIM and a mailto present: `method:"mailto"`, `oneClickUrl` undefined, `webUrl` still set.
    - Only an http link: `method:"manual"`.
    - No List-Unsubscribe: `null`.
    - No From: `null`.
    - Multiple `list-unsubscribe` values are joined with `,` before parsing.
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/scan/headers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** using the §7.2 rules.
  - DKIM gate: the authserv-id is the text before the first `;` of an `Authentication-Results` value, trimmed and lowercased, and must equal `mx.google.com`.
  - Passing domains come from each `;`-segment starting with `dkim=pass`: the domain part of `header.i=` (after `@`) and `header.d=`, lowercased.
  - DKIM-Signature tags: split on `;`, strip all whitespace inside the values of `d` and `h`, and split `h` on `:`, lowercased.
  - Match when the passing domain `p === d || p.endsWith("." + d)`.
- [ ] **Step 4: Run the tests.** Expected: PASS. `npm run typecheck`: no errors in `server/scan/headers.ts`.
- [ ] **Step 5: Commit**: `feat: parse unsubscribe headers with RFC 8058 DKIM gate`.

---

### Task 3: Gmail clients and retry

**Files:**
- Create: `server/gmail/retry.ts`, `server/gmail/google.ts`, `server/gmail/fake.ts`
- Test: `tests/gmail/retry.test.ts`, `tests/gmail/google.test.ts`, `tests/gmail/fake.test.ts`

**Interfaces:**
- Consumes: `GmailClient`, `MessageMeta`, `METADATA_HEADERS`, `AuthExpiredError` (Task 1); `RETRY` (Task 1); `mapLimit` (Task 1).
- Produces:
  ```ts
  // retry.ts
  export interface RetryOptions { maxAttempts?: number; baseMs?: number; capMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }
  export function isRetryableGmailError(err: unknown): boolean; // status 429 or >=500, or 403 with reason rateLimitExceeded|userRateLimitExceeded
  export function isAuthError(err: unknown): boolean;           // status 401, or "invalid_grant" in response.data.error / message
  export function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
  // google.ts
  export class GoogleGmailClient implements GmailClient { constructor(api: gmail_v1.Gmail, opts?: { retry?: RetryOptions; trashConcurrency?: number /* default 8 */ }) }
  // fake.ts
  export interface FakeMessage { id: string; internalDate: number; headers: Record<string, string[]>; labels: string[]; mentionsUnsubscribe: boolean }
  export class FakeGmailClient implements GmailClient {
    constructor(opts?: { email?: string; messages?: FakeMessage[]; now?: () => number });
    readonly messages: Map<string, FakeMessage>;
    readonly sent: string[];                  // raw RFC 822 strings
    readonly failMetadataFor: Set<string>;    // ids whose getMessageMetadata rejects
    failNext?: { method: keyof GmailClient; error: Error }; // one-shot injected failure
    reset(messages: FakeMessage[]): void;
  }
  export interface FakeMessageSpec { id: string; from: string; subject?: string; daysAgo: number; listUnsubscribe?: string; oneClick?: boolean; dkim?: "pass" | "fail" | "none"; labels?: string[]; mentionsUnsubscribe?: boolean }
  export function fakeMessage(spec: FakeMessageSpec, now: number): FakeMessage;
  ```
  - Error shapes to narrow (googleapis/gaxios):
    - Status: `err.status ?? err.response?.status ?? err.code` (when numeric).
    - Reason: `err.errors?.[0]?.reason ?? err.response?.data?.error?.errors?.[0]?.reason`.
    - `invalid_grant`: `err.response?.data?.error === "invalid_grant"` or `/invalid_grant/` in `err.message`.
  - `withRetry` delay: `random() * min(capMs, baseMs * 2 ** (attempt - 1))`. Non-retryable errors are rethrown immediately.
  - `GoogleGmailClient` wraps every API call in `withRetry`. Any error where `isAuthError` holds is rethrown as `AuthExpiredError`.
    - `listMessageIds`: `users.messages.list({ userId:"me", q, maxResults:500, pageToken })`, looping until there's no `nextPageToken`.
    - `getMessageMetadata`: `format:"metadata"`, `metadataHeaders: [...METADATA_HEADERS]`. Map `payload.headers` into lowercased arrays; `internalDate` is `Number(data.internalDate)`.
    - `sendRaw`: `users.messages.send({ userId:"me", requestBody:{ raw: base64url(rfc822) } })`.
    - `archive`: `batchModify` with `removeLabelIds:["INBOX"]` in chunks of 1000.
    - `trash`: `users.messages.trash` per id via `mapLimit`. Throw an `Error` summarizing the failures if any id failed after retries.
    - `getProfileEmail`: `users.getProfile` → `emailAddress`.
  - `FakeGmailClient.listMessageIds` supports exactly two query shapes and throws on anything else:
    - `SCAN_QUERY`: ids with `mentionsUnsubscribe`, not labeled `SPAM`/`TRASH`, and `internalDate >= now() - 30d`, newest first.
    - `from:(<addr>)`: all non-SPAM/TRASH messages whose parsed From address equals `<addr>`, case-insensitive. Use a small local regex for the angle-addr. Don't import Task 2.
  - `archive` removes `INBOX`; `trash` adds `TRASH`; `sendRaw` pushes to `sent`.
  - `fakeMessage` defaults: `listUnsubscribe` = `<https://unsub.<domain>/u/<id>>, <mailto:unsub@<domain>>`, `oneClick: true`, `dkim: "pass"`, `labels: ["INBOX"]`, `mentionsUnsubscribe: true`.
    - It builds a `DKIM-Signature` with `d=<domain>` and `h=from:subject:list-unsubscribe:list-unsubscribe-post`, and an `Authentication-Results: mx.google.com; dkim=<pass|fail> header.i=@<domain> ...` (omit both when `dkim:"none"`).
    - It emits `List-Unsubscribe-Post: List-Unsubscribe=One-Click` only when `oneClick`.
    - `internalDate = now - daysAgo * 86400000`.

- [ ] **Step 1: Write the failing tests**
  - `retry.test.ts` (inject `sleep` as a recorder and `random: () => 1`):
    - `retries 429 then succeeds` (2 calls)
    - `retries 503 and 403 rateLimitExceeded`
    - `does not retry 400 or 404` (1 call, rethrows)
    - `gives up after 5 attempts and rethrows last error`
    - `delays follow 500,1000,2000,4000 capped at 16000`
    - `isAuthError detects 401 and invalid_grant`
  - `google.test.ts`, with a stub object cast to `gmail_v1.Gmail` whose methods are `vi.fn()`:
    - `listMessageIds follows nextPageToken across 3 pages and concatenates ids`
    - `getMessageMetadata requests format metadata with METADATA_HEADERS and lowercases header names, keeping repeated headers in order`
    - `sendRaw base64url-encodes (no +, /, or = padding)`
    - `archive chunks 2500 ids into 1000/1000/500 batchModify calls removing INBOX`
    - `trash calls messages.trash once per id`
    - `invalid_grant from the API surfaces as AuthExpiredError`
  - `fake.test.ts`:
    - `scan query excludes SPAM, TRASH, older than 30d, and mentionsUnsubscribe=false`
    - `from:() query matches all-time case-insensitively`
    - `archive removes INBOX; trash adds TRASH (then excluded from scan query)`
    - `failMetadataFor makes getMessageMetadata reject`
    - `fakeMessage(dkim:"none") omits DKIM-Signature and Authentication-Results`
    - `unknown query throws`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/gmail`. Expected: FAIL.
- [ ] **Step 3: Implement** `retry.ts`, `google.ts` and `fake.ts` per the Interfaces block.
- [ ] **Step 4: Run the tests.** Expected: PASS. `npm run typecheck`: no errors in `server/gmail/*`.
- [ ] **Step 5: Commit**: `feat: add Gmail client interface implementations with retry and fake`.

---

### Task 4: Scanner (`server/scan/scanner.ts`)

**Files:**
- Create: `server/scan/scanner.ts`
- Test: `tests/scan/scanner.test.ts`

**Interfaces:**
- Consumes: `analyzeMessage` (Task 2); `GmailClient` (Task 1); `FakeGmailClient` and `fakeMessage` (Task 3, tests only); `HistoryStore` (Task 1); `mapLimit`, `SCAN_QUERY`, `SCAN_CONCURRENCY`, `STILL_SENDING_GRACE_MS` (Task 1).
- Produces:
  ```ts
  export function deriveStatus(lastReceived: number, entry: HistoryEntry | undefined): Status; // §7.3
  export interface ScanDeps { gmail: GmailClient; history: HistoryStore; now?: () => number; concurrency?: number; onProgress?: (done: number, total: number) => void }
  export function scanMailbox(deps: ScanDeps): Promise<ScanResult>;
  ```
  - Subscriptions are sorted by `count` desc, then `lastReceived` desc.
  - `AuthExpiredError` from any call propagates (it isn't counted as skipped). Other `getMessageMetadata` rejections increment `skipped`.

- [ ] **Step 1: Write the failing tests**, using `FakeGmailClient` with a fixed `now`:
  - `groups messages by lowercased sender address (Deals@Acme.com and deals@acme.com → one row, count 2)`
  - `name, latestSubject, lastReceived, targets and method come from the newest message`
  - `messages without a usable List-Unsubscribe are not counted and a sender with none is absent`
  - `failing metadata fetches are skipped and counted` (`failMetadataFor` with 2 ids → `skipped === 2`)
  - `onProgress reports (done,total) ending at (total,total)`
  - `AuthExpiredError from getMessageMetadata rejects scanMailbox`
  - `deriveStatus`:
    - No entry → `active`.
    - `failed` → `failed`.
    - `manual-pending` → `manual`.
    - `unsubscribed` at T with lastReceived T+48h → `unsubscribed`.
    - lastReceived T+48h+1ms → `still-sending`.
    - `manual-done` behaves like `unsubscribed`.
  - `status and lastAttempt are filled from history`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/scan/scanner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per §7.1. Fetch with `mapLimit(ids, concurrency ?? SCAN_CONCURRENCY, …)`. Call `onProgress` after each settled fetch. If any settled rejection is an `AuthExpiredError`, throw it after the pool settles.
- [ ] **Step 4: Run the tests.** Expected: PASS. Typecheck clean.
- [ ] **Step 5: Commit**: `feat: scan mailbox into per-sender subscriptions`.

---

### Task 5: URL policy and unsubscribe methods

**Files:**
- Create: `server/unsub/urlPolicy.ts`, `server/unsub/methods.ts`
- Test: `tests/unsub/urlPolicy.test.ts`, `tests/unsub/methods.test.ts`

**Interfaces:**
- Consumes: `GmailClient` (Task 1); `ONE_CLICK_TIMEOUT_MS`, `USER_AGENT` (Task 1).
- Produces:
  ```ts
  // urlPolicy.ts
  export type Resolver = (host: string) => Promise<string[]>;
  export type UrlCheck = { ok: true } | { ok: false; reason: string };
  export interface UrlPolicyOptions { resolve?: Resolver; allowPrefixes?: string[] } // default resolve: dns.promises.lookup(host,{all:true})
  export function isBlockedIp(ip: string): boolean;
  export function checkOneClickUrl(url: string, opts?: UrlPolicyOptions): Promise<UrlCheck>;
  // methods.ts
  export interface MethodOutcome { ok: boolean; detail: string }
  export function postOneClick(url: string, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<MethodOutcome>;
  export function parseMailto(mailto: string): { to: string; subject: string; body: string } | null;
  export function buildRfc822(msg: { to: string; subject: string; body: string }): string;
  export function sendMailto(gmail: GmailClient, mailto: string): Promise<MethodOutcome>;
  ```
  - Blocked ranges, via `net.BlockList`:
    - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4`, `255.255.255.255/32`.
    - IPv6: `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
    - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is checked as its IPv4.
  - `checkOneClickUrl` order:
    1. A URL starting with any `allowPrefixes` entry → ok.
    2. Unparseable → `invalid URL`.
    3. Protocol ≠ `https:` → `not https`.
    4. Username or password present → `credentials in URL`.
    5. Hostname `localhost` or ending in `.localhost` → `local host`.
    6. An IP-literal hostname that `isBlockedIp` → `private address`.
    7. Otherwise resolve: any blocked IP → `private address`; a resolve error → `DNS lookup failed`.
  - `postOneClick` sends `method:"POST"`, a `FormData` body with `List-Unsubscribe=One-Click`, `headers: { "User-Agent": USER_AGENT }`, `redirect:"manual"`, `signal: AbortSignal.timeout(timeoutMs)`, and no credentials.
    - 200–399 → `{ok:true, detail:"HTTP <status>"}`.
    - Other status → `{ok:false, detail:"HTTP <status>"}`.
    - Timeout → `{ok:false, detail:"timed out"}`.
    - Other error → `{ok:false, detail: err.message}`.
  - `parseMailto` parses the query string manually with `decodeURIComponent`. Don't use URLSearchParams: `+` is literal in mailto.
    - The address is the decoded path; comma-separated lists are kept as-is.
    - `subject` and `body` default to `"unsubscribe"` when absent or empty.
    - Return `null` if the address has no `@`, or if any of to/subject/body contains `\r` or `\n` (Review Focus 1).
  - `buildRfc822` output:
    - Headers, joined by CRLF: `To`, `Subject` (RFC 2047 `=?UTF-8?B?...?=` if non-ASCII), `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8`, `Content-Transfer-Encoding: base64`.
    - Then a blank line and the base64 body.
  - `sendMailto`: an unparseable mailto → `{ok:false, detail:"invalid mailto"}`. Success → `{ok:true, detail:"sent email to <to>"}`. A thrown `AuthExpiredError` propagates; other errors → `{ok:false, detail: message}`.

- [ ] **Step 1: Write the failing tests**
  - `urlPolicy.test.ts`, with an injected `resolve`:
    - `allows public https host` (resolves to `93.184.216.34`)
    - `rejects http`
    - `rejects user:pass@`
    - `rejects localhost and foo.localhost`
    - `rejects https://127.0.0.1/ https://10.1.2.3/ https://[::1]/ https://[fe80::1]/ https://169.254.169.254/`
    - `rejects host resolving to 192.168.1.10`
    - `rejects host resolving to ::ffff:10.0.0.1`
    - `DNS failure → reason "DNS lookup failed"`
    - `allowPrefixes admits http://127.0.0.1:3100/__fake/`
  - `methods.test.ts`:
    - `postOneClick sends multipart POST with List-Unsubscribe=One-Click and UA, no redirect following`. Start a local `http.createServer` on port 0; assert the method, that `content-type` starts with `multipart/form-data`, that the body contains `List-Unsubscribe` and `One-Click`, and the user-agent.
    - `302 counts as ok without following Location` (the server records no request to the Location path)
    - `500 → ok:false "HTTP 500"`
    - `timeout → ok:false "timed out"` (the server never responds; `timeoutMs: 200`)
    - `parseMailto("mailto:u@x.com?subject=Unsub%20me&body=a+b")` gives `{to:"u@x.com",subject:"Unsub me",body:"a+b"}`
    - `parseMailto defaults subject/body to "unsubscribe"`
    - `parseMailto rejects CR/LF injection` (`mailto:u@x.com?subject=hi%0D%0ABcc:%20evil@x.com` → `null`; `mailto:u@x.com%0D%0ABcc:evil@x.com` → `null`)
    - `parseMailto rejects missing @`
    - `buildRfc822 encodes non-ASCII subject as =?UTF-8?B?...?= and base64 body; lines joined by CRLF`
    - `sendMailto sends via gmail.sendRaw` (`FakeGmailClient.sent` has one entry containing `To: u@x.com`)
    - `sendMailto with invalid mailto → ok:false, nothing sent`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/unsub`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run the tests.** Expected: PASS. Typecheck clean for these files.
- [ ] **Step 5: Commit**: `feat: add one-click URL policy and unsubscribe methods`.

---

### Task 6: Unsubscribe runner (`server/unsub/runner.ts`)

**Files:**
- Create: `server/unsub/runner.ts`, `shared/status.ts`
- Test: `tests/unsub/runner.test.ts`

**Interfaces:**
- Consumes: `postOneClick`, `sendMailto`, `UrlCheck` (Task 5); `HistoryStore` (Task 1); `GmailClient`, `AuthExpiredError` (Task 1); `mapLimit`, `UNSUB_CONCURRENCY` (Task 1); `FakeGmailClient` and `fakeMessage` (Task 3, tests).
- Produces:
  ```ts
  export interface RunnerDeps {
    gmail: GmailClient; history: HistoryStore;
    checkUrl: (url: string) => Promise<UrlCheck>;
    postOneClick: (url: string) => Promise<MethodOutcome>;
    now?: () => number; concurrency?: number;
  }
  export function unsubscribeSender(sub: Subscription, cleanup: CleanupMode, deps: RunnerDeps): Promise<SenderResult>;
  export function runUnsubscribe(subs: Subscription[], cleanup: CleanupMode, deps: RunnerDeps, onResult: (r: SenderResult) => void): Promise<SenderResult[]>;
  // shared/status.ts (pure, imported by the runner, server/app.ts and the web UI; no duplicates):
  export function statusFromResult(r: SenderResult): Status; // unsubscribed→"unsubscribed", manual→"manual", failed→"failed"
  ```
  - Method chain (§8):
    1. If `targets.oneClickUrl`: run `checkUrl`, then `postOneClick`.
    2. Then if `targets.mailto`: `sendMailto`.
    3. Then if `targets.webUrl`: outcome `manual` with `manualUrl = webUrl`.
    4. Otherwise `failed`.
  - `detail` on success is the winning method's detail. On manual or failed it is the attempted steps joined with `; `, e.g. `one-click: HTTP 500; email: invalid mailto`.
  - History is written before cleanup:
    - `unsubscribed` → `{outcome:"unsubscribed", method, at, detail}`
    - `manual` → `{outcome:"manual-pending", method:"manual", at, detail, manualUrl}`
    - `failed` → `{outcome:"failed", at, detail}`
  - Cleanup runs when `cleanup !== "leave"` and the outcome ≠ `failed`: `listMessageIds("from:(" + sender + ")")`, then `archive` or `trash`. The result is `cleanup = {mode, ok, count}` or `{mode, ok:false, error}`.
  - `AuthExpiredError` from any step propagates out of `unsubscribeSender`. `runUnsubscribe` stops starting new senders once one is seen, waits for in-flight ones, and then rejects with it. Any other exception becomes `{outcome:"failed", detail: message}`.

- [ ] **Step 1: Write the failing tests**, using `FakeGmailClient`, a stub `postOneClick`, a stub `checkUrl` and a temp `HistoryStore`:
  - `one-click success → unsubscribed, methodUsed one-click, history unsubscribed`
  - `one-click HTTP 500 falls back to mailto → unsubscribed via mailto, detail mentions both`
  - `policy rejection skips POST and falls back` (`postOneClick` not called)
  - `one-click and mailto fail, webUrl present → manual with manualUrl, history manual-pending`
  - `nothing works and no webUrl → failed, history failed`
  - `cleanup archive removes INBOX from all-time messages of sender only`
  - `cleanup trash adds TRASH; result.cleanup.count equals message count`
  - `cleanup failure is reported but outcome stays unsubscribed` (`failNext` on `trash`)
  - `failed sender is not cleaned up`
  - `manual sender is cleaned up`
  - `runUnsubscribe calls onResult per sender and respects concurrency 4`
  - `AuthExpiredError aborts runUnsubscribe and rejects`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/unsub/runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run the tests.** Expected: PASS. Typecheck clean.
- [ ] **Step 5: Commit**: `feat: run per-sender unsubscribe with fallbacks and cleanup`.

---

### Task 7: Google OAuth (`server/auth/google.ts`)

**Files:**
- Create: `server/auth/google.ts`
- Test: `tests/auth/google.test.ts`

**Interfaces:**
- Consumes: `TokenStore` (Task 1); `GMAIL_SCOPE`, `OAUTH_STATE_TTL_MS` (Task 1).
- Produces:
  ```ts
  export class InvalidStateError extends Error {}
  export interface GoogleAuthOptions { clientId: string; clientSecret: string; redirectUri: string; tokens: TokenStore; now?: () => number; oauthClient?: OAuth2Client }
  export class GoogleAuth {
    constructor(opts: GoogleAuthOptions);
    readonly client: OAuth2Client;
    init(): Promise<void>;                 // load tokens into client; on client "tokens" event → tokens.save(merged)
    createAuthUrl(): string;               // access_type offline, prompt consent, scope [GMAIL_SCOPE], random 32-byte hex state stored with expiry
    handleCallback(code: string | undefined, state: string | undefined): Promise<void>; // validates + consumes state, getToken, setCredentials, save, clears authError
    isSignedIn(): boolean;                 // client has a refresh_token
    readonly authError: "expired" | undefined;
    markExpired(): Promise<void>;          // tokens.clear(), client.setCredentials({}), authError = "expired"
    logout(): Promise<void>;               // revokeCredentials best effort (errors swallowed), tokens.clear(), setCredentials({}), authError = undefined
  }
  ```

- [ ] **Step 1: Write the failing tests**, using a real `OAuth2Client` with `vi.spyOn(client, "getToken")` and `revokeCredentials` stubbed, plus a temp `TokenStore`:
  - `createAuthUrl includes gmail.modify scope, access_type=offline, prompt=consent, redirect_uri, and a 64-hex state`
  - `handleCallback with valid state stores tokens and isSignedIn() becomes true`
  - `state is single-use` (second call → `InvalidStateError`)
  - `unknown or missing state → InvalidStateError`
  - `expired state (now + 10min + 1ms) → InvalidStateError`
  - `missing code → InvalidStateError`
  - `init loads persisted tokens (isSignedIn true after restart)`
  - `"tokens" event without refresh_token persists access_token and keeps refresh_token`
  - `markExpired clears tokens and sets authError "expired"`
  - `logout swallows revoke errors and clears tokens`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/auth`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run the tests.** Expected: PASS. Typecheck clean.
- [ ] **Step 5: Commit**: `feat: add Google OAuth flow with state validation and token persistence`.

---

### Task 8: Config, security guards, job registry

**Files:**
- Create: `server/config.ts`, `server/security.ts`, `server/jobs.ts`
- Test: `tests/config.test.ts`, `tests/security.test.ts`, `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `Job`, `SenderResult`, `JobError` (Task 1); `AuthExpiredError` (Task 1); `MAX_FINISHED_JOBS` (Task 1).
- Produces:
  ```ts
  // config.ts
  export interface AppConfig { port: number; host: "127.0.0.1"; clientId?: string; clientSecret?: string; demo: boolean; prod: boolean; dataDir: string; redirectUri: string; configured: boolean }
  export function loadConfig(env?: NodeJS.ProcessEnv, argv?: string[], cwd?: string): AppConfig;
  //   port = Number(env.PORT) || 3000; demo = env.FAKE_GMAIL === "1" || argv.includes("--demo"); prod = argv.includes("--prod")
  //   dataDir = resolve(cwd, env.DATA_DIR ?? ".data"); redirectUri = `http://127.0.0.1:${port}/api/auth/callback`
  //   configured = demo || (!!clientId && !!clientSecret)
  // security.ts
  export function hostGuard(port: number): RequestHandler; // Host must be 127.0.0.1:<port> or localhost:<port> → else 403 text "Forbidden host"
  export function csrfGuard(port: number): RequestHandler; // methods other than GET/HEAD/OPTIONS: content-type must be application/json (415) and Origin, if present, must be http://127.0.0.1:<port> or http://localhost:<port> (403)
  // jobs.ts
  export interface JobControl { setProgress(done: number, total: number): void; addResult(r: SenderResult): void }
  export class JobRegistry {
    constructor(opts?: { now?: () => number });
    get active(): Job | undefined;
    get(id: string): Job | undefined;
    start(kind: Job["kind"], senders: string[], run: (ctl: JobControl) => Promise<void>): { ok: true; job: Job } | { ok: false; activeJobId: string };
    clear(): void;                        // drops all jobs (used by logout and demo reset)
  }
  //   run resolves → state "done"; rejects with AuthExpiredError → error {code:"AUTH_EXPIRED"};
  //   with an error that has a numeric `status` or a `response` property (gaxios/googleapis) → "GMAIL_ERROR"; else "INTERNAL".
  //   error.message = err.message. finishedAt set.
  //   Keeps at most MAX_FINISHED_JOBS finished jobs (oldest evicted). ids from crypto.randomUUID().
  ```

- [ ] **Step 1: Write the failing tests**
  - `config.test.ts`:
    - `defaults port 3000, dataDir <cwd>/.data, not configured without creds`
    - `configured with both creds`
    - `--demo or FAKE_GMAIL=1 → demo and configured`
    - `--prod sets prod`
    - `redirectUri uses PORT`
  - `security.test.ts`, with supertest on a tiny express app that uses both guards and has a `POST /x` route:
    - `Host evil.com → 403`
    - `Host localhost:<port> → allowed`
    - `POST with text/plain → 415`
    - `POST with JSON and Origin http://evil.com → 403`
    - `POST with JSON and no Origin → 200`
    - `POST with JSON and Origin http://127.0.0.1:<port> → 200`
    - `GET without content-type → 200`
    - Supertest sets Host to `127.0.0.1:<ephemeral>`, so set an explicit `Host` header matching the guard's configured port.
  - `jobs.test.ts`:
    - `start returns running job; second start while running → {ok:false, activeJobId}`
    - `progress and results visible via get()`
    - `resolve → done with finishedAt`
    - `AuthExpiredError → error AUTH_EXPIRED`
    - `generic Error → INTERNAL with message`
    - `error with numeric status → GMAIL_ERROR`
    - `after done, a new job can start`
    - `keeps only 20 finished jobs`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/config.test.ts tests/security.test.ts tests/jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run the tests.** Expected: PASS. Typecheck clean.
- [ ] **Step 5: Commit**: `feat: add config loader, localhost security guards, and job registry`.

---

### Task 9: API app, demo mode, server entry

**Files:**
- Create: `server/app.ts`, `server/demo.ts`, `server/index.ts`, `web/index.html`, `web/main.tsx` (placeholder `<div>Loading…</div>` render, replaced in Task 10)
- Test: `tests/app.test.ts`, `tests/demo.test.ts`

**Interfaces:**
- Consumes: everything above. Specifically: `scanMailbox` (T4); `runUnsubscribe` (T6), `statusFromResult` (`shared/status.ts`, T6); `checkOneClickUrl`, `postOneClick` (T5); `GoogleAuth`, `InvalidStateError` (T7); `loadConfig`, `hostGuard`, `csrfGuard`, `JobRegistry` (T8); `GoogleGmailClient`, `FakeGmailClient`, `fakeMessage` (T3); `HistoryStore`, `TokenStore` (T1).
- Produces:
  ```ts
  // demo.ts
  export function createDemoMailbox(opts: { now: number; fakeBaseUrl: string }): FakeMessage[];
  export function fakeEndpointsRouter(): Router; // mounted at /__fake: POST /unsub/ok/:id → 200, /unsub/fail/:id → 500, /unsub/redirect/:id → 302 Location /
  // app.ts
  export interface AppDeps {
    config: AppConfig; gmail: GmailClient; auth?: GoogleAuth;   // auth undefined in demo mode
    history: HistoryStore; jobs: JobRegistry;
    checkUrl: (url: string) => Promise<UrlCheck>; postOneClick: (url: string) => Promise<MethodOutcome>;
    now?: () => number;
    demoReset?: () => Promise<void>;                            // demo only: reseed mailbox
  }
  export function createApp(deps: AppDeps): express.Express;
  ```
  - `createApp` holds `state = { scan?: ScanResult; email?: string }`. It applies `hostGuard` to everything, plus `express.json({ limit: "100kb" })` and `csrfGuard` on `/api`. The routes follow §5:
    - Signed in means `deps.auth ? deps.auth.isSignedIn() : true`. The Gmail-backed routes (`/api/scan`, `/api/scan/latest`, `/api/unsubscribe`, `/api/manual-done`) return `401 {error:"NOT_SIGNED_IN"}` when not signed in.
    - `/api/status`:
      - `email`: demo → `"demo@example.com"`. Otherwise `state.email ??= await gmail.getProfileEmail()` when signed in. An `AuthExpiredError` there → `auth.markExpired()`, and the response reports `signedIn:false, authError:"expired"`.
      - `activeJobId` = `jobs.active?.id`.
    - Login is a 302 to `auth.createAuthUrl()`. The callback has two outcomes:
      - `InvalidStateError` → 400 with the HTML body `Sign-in link expired or invalid. <a href="/">Try again</a>`.
      - Success → reset `state.email`, 302 to `/`.
    - The scan job's `run` does `state.scan = await scanMailbox({ gmail, history, onProgress: ctl.setProgress })`.
    - Unsubscribe validates the body: `senders` is a non-empty array of strings that all exist in `state.scan`, and `cleanup` ∈ the three modes; otherwise 400 `{error}`. No scan → 400 `{error:"NO_SCAN"}`. The job's `onResult` updates the scan row (`status = statusFromResult(r)`, `lastAttempt = history.get(sender)`) and calls `ctl.addResult`.
    - `manual-done` takes a sender, which must be in the scan. It writes history `{outcome:"manual-done", method:"manual", at, detail:"marked done by user", manualUrl}` and sets the row to `unsubscribed`.
    - Any job error with code `AUTH_EXPIRED` → `await deps.auth?.markExpired()` inside the run wrapper before rethrowing.
    - Logout → `auth.logout()`, clear `state`, `jobs.clear()`.
  - In demo mode, `createApp` also mounts `fakeEndpointsRouter()` at `/__fake`, outside the csrf guard, plus `POST /__fake/reset` → `deps.demoReset()`, `history.clear()`, `jobs.clear()`, `state = {}`, then `{ok:true}`.
  - `createDemoMailbox`: about 30 senders, built with `fakeMessage`, that cover:
    - ≥ 15 one-click senders whose URLs are `${fakeBaseUrl}/__fake/unsub/ok/<id>`; 3 with `/fail/` and mailto present (fallback); 1 with `/fail/` and no mailto (→ manual); 1 with `/redirect/`.
    - 4 mailto-only senders (no `oneClick`); 4 http-only senders (`<http://...>` → manual).
    - 2 senders with one-click headers but `dkim:"fail"` (→ mailto).
    - 1 sender with 40 messages; 1 with an RFC 2047 encoded name.
    - 1 message in `SPAM` and 1 at 45 days old (both excluded).
    - Realistic, varied names and subjects (fictional brands).
  - `index.ts`:
    - `try { process.loadEnvFile() } catch {}`, then `loadConfig()`.
    - Open `HistoryStore` and `TokenStore` in `dataDir`.
    - Demo: `FakeGmailClient` seeded with `createDemoMailbox({ now: Date.now(), fakeBaseUrl: "http://127.0.0.1:"+port })`, `checkUrl = url => checkOneClickUrl(url, { allowPrefixes: [fakeBaseUrl + "/__fake/"] })`, and `demoReset` reseeds.
    - Real: when configured, `new GoogleAuth(...)` + `init()`, and `new GoogleGmailClient(gmail({ version: "v1", auth: auth.client }))`. When not configured, use a `GmailClient` whose methods all throw, and no auth. `/api/status` then reports `configured:false`.
    - `createApp(deps)`, then `http.createServer(app)`.
    - Not prod: `createServer({ configFile: <repo>/vite.config.ts, server: { middlewareMode: true, hmr: { server: httpServer } }, appType: "spa" })` and `app.use(vite.middlewares)`.
    - Prod: `express.static(<repo>/dist)` plus an SPA fallback to `dist/index.html`. If `dist` is missing, exit with "Run npm run build first".
    - Listen on `127.0.0.1:port`. On `EADDRINUSE`, print `Port <port> is in use. Try PORT=<port+1> npm run dev (and update the OAuth redirect URI).` and exit 1.
    - On listen, print `Gmail Bulk Unsubscribe running at http://127.0.0.1:<port>`, plus ` (demo mode)` in demo.

- [ ] **Step 1: Write the failing tests**
  - `tests/app.test.ts`, using supertest with `createApp`, a demo-style deps object (`FakeGmailClient` seeded via `fakeMessage`, `auth: undefined`), a stub `postOneClick` and an allow-all `checkUrl`. Every request sets `Host: 127.0.0.1:3000` and JSON content-type.
    - `GET /api/status → configured, signedIn, demo email, hasScan false`
    - `POST /api/scan → 202 jobId; polling /api/jobs/:id reaches done; /api/scan/latest returns subscriptions`
    - `POST /api/scan while running → 409 activeJobId`
    - `POST /api/unsubscribe before scan → 400 NO_SCAN`
    - `POST /api/unsubscribe with unknown sender or empty list or bad cleanup → 400`
    - `unsubscribe job results appear incrementally and scan rows get updated statuses`
    - `POST /api/manual-done marks row unsubscribed and writes history`
    - `GET /api/jobs/unknown → 404`
    - `Gmail routes return 401 NOT_SIGNED_IN when auth reports signed out` (stub `auth` with `isSignedIn: () => false`)
    - `AUTH_EXPIRED during scan calls auth.markExpired` (`failNext` = `AuthExpiredError` on `listMessageIds`; stub `auth`)
    - `foreign Origin POST → 403; text/plain POST → 415; bad Host → 403`
    - `callback with bad state → 400 page` (stub `auth.handleCallback` throwing `InvalidStateError`)
  - `tests/demo.test.ts`:
    - `createDemoMailbox produces ≥30 senders with all method types after scanMailbox` (run `scanMailbox` over a `FakeGmailClient`; assert the counts of `one-click`, `mailto` and `manual` are each > 0, the SPAM and 45-day messages are excluded, and the encoded name is decoded)
    - `fake endpoints return 200/500/302`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/app.test.ts tests/demo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `demo.ts`, `app.ts`, `index.ts` and the placeholder web entry.
- [ ] **Step 4: Run the full suite and typecheck.** Run `npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Smoke-run demo mode.**
  - Run `DATA_DIR=.data-smoke PORT=3123 npx tsx server/index.ts --demo &`, then `curl -s -H 'Host: 127.0.0.1:3123' http://127.0.0.1:3123/api/status`.
  - Expected: JSON with `"demo":true,"signedIn":true`. `curl http://127.0.0.1:3123/` returns HTML containing `id="root"`.
  - Kill the server and `rm -rf .data-smoke`.
- [ ] **Step 6: Commit**: `feat: add API server, demo mode, and entry point`.

---

### Task 10: Web UI shell and subscriptions table

**Files:**
- Create: `web/App.tsx`, `web/api.ts`, `web/format.ts`, `web/styles.css`, `web/components/SetupNotice.tsx`, `SignIn.tsx`, `Header.tsx`, `ScanProgress.tsx`, `SubscriptionTable.tsx`, `StatusCell.tsx` (renders every status in Task 11's StatusCell list. `pending` comes from the `pending` prop, and Mark done calls `onManualDone`.)
- Modify: `web/main.tsx` (render `<App/>`, import `styles.css`)
- Create: `playwright.config.ts`, `e2e/scan.spec.ts`
- Test: `tests/web/format.test.ts`

**Interfaces:**
- Consumes: the API from Task 9 and the types from `shared/types.ts`.
- Produces:
  ```ts
  // web/api.ts
  export type StartJob = { ok: true; jobId: string } | { ok: false; activeJobId: string };
  export const api: {
    status(): Promise<StatusResponse>;
    startScan(): Promise<StartJob>;
    latestScan(): Promise<ScanResult | null>;          // 404 → null
    startUnsubscribe(req: UnsubscribeRequest): Promise<StartJob>;
    job(id: string): Promise<Job | null>;              // 404 → null
    manualDone(sender: string): Promise<void>;
    logout(): Promise<void>;
  };
  export function pollJob(id: string, onUpdate: (job: Job | null) => void, intervalMs?: number): () => void; // stops itself when job is done/error/null; returns cancel
  // web/format.ts
  export function formatReceived(ts: number, now: number): string; // "Today" | "Yesterday" | "N days ago" (2–6) | "MMM d" via Intl en-US
  // SubscriptionTable props
  interface SubscriptionTableProps {
    rows: Subscription[]; hiddenAtLoad: ReadonlySet<string>; showUnsubscribed: boolean;
    pending: ReadonlySet<string>;                       // senders in a running job → "Unsubscribing…", not selectable
    selection: Record<string, boolean>; onSelectionChange: (s: Record<string, boolean>) => void;
    globalFilter: string;
    onVisibleSelectedChange: (senders: string[]) => void; // selected ∩ visible (Review Focus 5)
    onManualDone: (sender: string) => void;
  }
  ```
  - `data-testid` values (E2E depends on these exactly):
    - Screens: `setup-notice`, `connect-button`, `expired-message`, `demo-banner`, `account-email`.
    - Header: `rescan-button`, `signout-button`, `scan-progress`, `skipped-notice`, `restart-notice`.
    - Table: `search-input`, `show-unsubscribed`, `select-all`, `subscriptions-table`, row `tr` with `data-testid="row"` and `data-sender=<sender>`, `row-checkbox`, sort buttons `sort-sender|sort-count|sort-lastReceived|sort-latestSubject|sort-method|sort-status`, `method-badge`, `status-cell`, `manual-open`, `manual-done`.
    - Unsubscribe: `unsubscribe-button`.
  - App flow (§3):
    1. On mount → `api.status()`.
    2. `!configured` → `SetupNotice` (the README setup steps in short).
    3. `!signedIn` → `SignIn` (with the `expired-message` copy when `authError === "expired"`).
    4. Otherwise: if `activeJobId`, poll it (a scan job → progress; an unsubscribe job → pending rows). Else if `hasScan` → `latestScan()`. Else → `startScan()`.
    5. On scan done → load `latestScan`, set `hiddenAtLoad` = senders whose status is `unsubscribed`, and clear the selection.
    6. `pollJob` → `null` shows `restart-notice`. A job error `AUTH_EXPIRED` → re-fetch status (shows SignIn with the expired message).
  - Table (TanStack Table v8):
    - Hooks: `useReactTable` with `getCoreRowModel`, `getSortedRowModel`, `getFilteredRowModel`.
    - `getRowId: r => r.sender`. Initial sorting `[{ id: "count", desc: true }]`.
    - `globalFilterFn`: a case-insensitive substring match on name, sender or latestSubject.
    - Rows hidden when `!showUnsubscribed && hiddenAtLoad.has(sender)` are removed from `data` before the table gets it.
    - `enableRowSelection: row => !pending.has(row.id)`. The header checkbox uses `table.getToggleAllRowsSelectedHandler()` (it acts on the filtered rows in v8).
  - Styling:
    - A simple, clean, responsive CSS: a sticky table header, badges colored by method, and a subject cell truncated with an ellipsis plus a `title` tooltip.
    - Usable at 1024 px or wider; the table scrolls horizontally on narrow screens.

- [ ] **Step 1: Write the failing tests**
  - `tests/web/format.test.ts`:
    - `formatReceived same day → "Today"`
    - `previous day → "Yesterday"`
    - `3 days → "3 days ago"`
    - `8 days → "Oct 26"` (for now = Nov 3 2026 local, ts = Oct 26)
  - `playwright.config.ts`:
    - `testDir "e2e"`, `workers: 1`, `use.baseURL "http://127.0.0.1:3100"`.
    - `webServer: { command: "npx tsx server/index.ts --demo", env: { PORT: "3100", DATA_DIR: ".data-e2e" }, url: "http://127.0.0.1:3100/api/status", reuseExistingServer: false }`.
    - `globalSetup` removes `.data-e2e`.
  - `e2e/scan.spec.ts`. In `beforeEach`, `request.post("/__fake/reset")`, then `page.goto("/")`.
    - `shows demo banner and account email`
    - `auto-scans and lists rows sorted by count desc` (first row's count ≥ second row's; the 40-message sender is first)
    - `search filters rows by subject text`
    - `select-all selects only filtered rows` (filter, select-all, clear the filter; the checked count equals the filtered count)
    - `clicking sort-sender sorts alphabetically`
    - `method badges show One-click, Email and Manual`
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/web && npx playwright test e2e/scan.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `api.ts`, `format.ts`, the components, `App.tsx` and `styles.css` per the Interfaces block.
- [ ] **Step 4: Run the tests.**
  - Run `npx vitest run tests/web && npx playwright test e2e/scan.spec.ts && npm run typecheck && npm run build`.
  - Expected: all PASS, and the build emits `dist/index.html`.
- [ ] **Step 5: Commit**: `feat: add web UI shell and subscriptions table`.

---

### Task 11: Unsubscribe flow UI

**Files:**
- Create: `web/components/ConfirmDialog.tsx`, `web/components/ResultsPanel.tsx`
- Modify: `web/App.tsx`. Also `web/components/StatusCell.tsx` and `web/components/SubscriptionTable.tsx`, only to fix gaps against the StatusCell list below; Task 10 already renders it.
- Create: `e2e/unsubscribe.spec.ts`

**Interfaces:**
- Consumes: `api.startUnsubscribe`, `pollJob`, `api.manualDone` (Task 10); `SubscriptionTable` props (Task 10).
- Produces:
  ```ts
  interface ConfirmDialogProps { subs: Subscription[]; onCancel: () => void; onConfirm: (cleanup: CleanupMode) => void }
  interface ResultsPanelProps { results: SenderResult[]; onManualDone: (sender: string) => void; onDismiss: () => void }
  ```
  - `data-testid` values:
    - Confirm dialog: `confirm-dialog`, `confirm-count-one-click`, `confirm-count-mailto`, `confirm-count-manual`, `cleanup-leave`, `cleanup-archive`, `cleanup-trash`, `confirm-submit`, `confirm-cancel`.
    - Results panel: `results-panel`, `results-summary`, `result-row` (`data-sender`), `manual-open`, `manual-done`, `results-dismiss`.
  - ConfirmDialog copy follows §3.4 exactly. It counts by each sub's `method`, omits zero-count lines, and defaults to `leave`.
  - Flow:
    1. The button is labeled `Unsubscribe from N selected` and uses the visible selected senders (Review Focus 5).
    2. Confirm → `startUnsubscribe({ senders, cleanup })` → those senders go into `pending` → `pollJob`.
    3. On each update, for each result: update the row's `status = statusFromResult(r)` (import from `shared/status.ts`). Remove the sender from `pending`.
    4. On done → show `ResultsPanel` and clear the selection.
  - Results summary format: `✅ X unsubscribed · ❌ Y failed · ↗ Z needs you`, omitting zero parts. A failed row shows `❌ Failed: <detail>`. A cleanup error shows `Unsubscribed, but couldn't <archive|move to Trash> emails: <error>`.
  - StatusCell:
    - `pending` → `Unsubscribing…`
    - `unsubscribed` → `✅ Unsubscribed`
    - `failed` → `❌ Failed: <lastAttempt.detail or result detail>`
    - `manual` → `↗ Manual` plus an `Open` link (`target="_blank" rel="noopener noreferrer"`, href = `manualUrl`, or else `targets.webUrl`) and a `Mark done` button
    - `still-sending` → `⚠ Still sending`
    - `active` → empty
  - Mark done → `api.manualDone(sender)` → the row status becomes `unsubscribed`.

- [ ] **Step 1: Write the failing E2E tests** (`e2e/unsubscribe.spec.ts`; `beforeEach` resets as in Task 10):
  - `confirm dialog shows per-method counts and defaults to Leave`
  - `cancel closes dialog without changes`
  - `unsubscribing one-click senders shows ✅ and the summary` (select 3 `/ok/` one-click rows by `data-sender`)
  - `failing one-click with mailto falls back and shows ✅`
  - `manual sender shows Open and Mark done; Mark done turns it ✅`
  - `trash cleanup then Rescan removes those senders from the table` (choose `cleanup-trash`, then rescan; the senders are absent even with `show-unsubscribed` on, because their mail is in Trash)
  - `leave cleanup then Rescan hides unsubscribed senders until Show unsubscribed is toggled`
  - `selected rows hidden by search are not unsubscribed` (select 2 rows, search to hide one, click unsubscribe; the dialog total is 1)
- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx playwright test e2e/unsubscribe.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** ConfirmDialog, ResultsPanel, the StatusCell states and the App wiring.
- [ ] **Step 4: Run the tests.**
  - Run `npx playwright test && npm test && npm run typecheck && npm run build`.
  - Expected: all PASS.
- [ ] **Step 5: Commit**: `feat: add bulk unsubscribe confirm, live status, and results UI`.

---

### Task 12: README and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the README** per spec §12. Sections:
  1. What it does.
  2. Requirements (Node ≥ 22.12).
  3. Google Cloud setup: a numbered list, with the exact redirect URI and the test-user step.
  4. Configure `.env`.
  5. Run: `npm run dev` / `npm start` / `npm run demo`.
  6. First-run smoke checklist: run the demo first; sign in; check the account email; scan; unsubscribe from 1–2 one-click senders with Leave; check the ✅; check Sent for any Email-method sends.
  7. How detection and methods work, including the DKIM gate.
  8. Known limitations (§12.7).
  9. Troubleshooting:
     - `redirect_uri_mismatch` → the URI must match exactly, including the port.
     - "Access blocked: app not verified" → add yourself as a test user.
     - Sign-in expiring weekly.
     - Port in use.
  10. Data and privacy: tokens and history in `.data/`; nothing leaves your machine except calls to Google and to the unsubscribe endpoints.
  11. Development: `npm test`, `npm run test:e2e` (run `npx playwright install chromium` once), `npm run typecheck`.
- [ ] **Step 2: Full verification.**
  - Run `npm ci && npm run typecheck && npm test && npm run test:e2e && npm run build`. Expected: all pass.
  - Then `npx tsx server/index.ts --prod --demo` (PORT 3124, DATA_DIR `.data-smoke`) and curl `/` and `/api/status` with the right Host header. Expected: HTML and demo status JSON. Clean up.
- [ ] **Step 3: Commit**: `docs: add setup and usage README`.
