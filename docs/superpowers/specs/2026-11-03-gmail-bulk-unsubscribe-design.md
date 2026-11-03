# Gmail Bulk Unsubscribe — Design

Date: 2026-11-03
Status: Approved for planning (owner delegated remaining decisions)

## 1. Goal

A small web app, run locally by one person against their own **personal @gmail.com**
account, that:

1. Connects to Gmail with OAuth.
2. Shows a table of the mailing lists ("subscriptions") the account is currently receiving.
3. Lets the user select many rows and unsubscribe from all of them in one action,
   optionally archiving or trashing the existing mail from those senders.

### Non-goals

- Hosting/deploying anywhere other than `127.0.0.1`. Multi-user. Multi-account.
- Parsing message bodies for unsubscribe links (header-based detection only).
- Creating Gmail filters for future mail.
- Caching scan results between runs (each scan is fresh).
- Google app verification (the OAuth app stays in "Testing").

## 2. Decisions (from the requirements Q&A)

| Topic | Decision |
|---|---|
| Stack | TypeScript. Node (Express 5) server + React 19 SPA built with Vite. One package, one process, one port. |
| Account | Personal @gmail.com. OAuth client in an *External* consent screen in *Testing* status, user added as a test user. Refresh tokens expire after 7 days; the app handles that by asking the user to reconnect. |
| Scan window | Fixed: last 30 days, all mail except Spam and Trash. |
| Subscription | A sender address with at least one message in the window carrying a usable `List-Unsubscribe` header. |
| Grouping | One row per lowercased `From` address. Unsubscribe data comes from that sender's most recent message that has a usable header. |
| Method priority | One-click (RFC 8058) → `mailto:` → manual web link. |
| Link-only senders | Shown with method **Manual**. After a run they get **Open** (new tab) and **Mark done** buttons. The app never fetches a manual link itself. |
| Cleanup | The confirm dialog offers **Leave / Archive / Move to Trash** (default Leave). It applies to *all* mail from each sender, not just the 30-day window. |
| Persistence | Only the OAuth token and an unsubscribe history (JSON files in git-ignored `.data/`). Unsubscribed senders are hidden by default. A sender who keeps emailing more than 48h after unsubscribing reappears as **Still sending**. |
| Table | Columns and controls listed in §3.3. |
| Process layout | A single Express server. In development it serves the SPA through Vite middleware mode; with `npm start` it serves the built SPA. |

## 3. User-facing behaviour

### 3.1 Setup / signed-out states

- **Missing config** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` not set): the page shows setup
  instructions (mirroring the README) instead of the app. The server still starts.
- **Signed out**: a "Connect Gmail" button goes to `/api/auth/login`.
- **Demo mode** (`FAKE_GMAIL=1`): counts as configured and signed in as `demo@example.com`. No
  Google calls are made. A banner reads "Demo mode: fake mailbox".
- **Session expired** (refresh token revoked or expired after 7 days): the same Connect screen,
  with the message "Your Google sign-in expired. Apps in Testing mode must reconnect every 7 days."

### 3.2 Signed-in header

Shows the account email address (from `users.getProfile`), a **Rescan** button and **Sign out**.

### 3.3 Subscriptions table

When the page loads signed in and the server has no scan result yet, a scan starts automatically.
While it runs, a progress line reads `Scanning… 412 / 980 emails`.

Columns:

| Column | Content |
|---|---|
| ☐ | Row selection |
| Sender | Display name (bold) + address |
| Emails (30d) | Count of matching messages from this sender in the window |
| Last received | Date of the newest message (relative within a week, otherwise `MMM d`) |
| Latest subject | Subject of the newest message, truncated with a full-text tooltip |
| Method | Badge: `One-click`, `Email`, `Manual` |
| Status | blank · `Unsubscribing…` · `✅ Unsubscribed` · `❌ Failed: <reason>` · `↗ Manual` (+ Open, Mark done) · `⚠ Still sending` |

Controls:

- Sort by any column. Default: Emails, descending.
- A search box filters by name, address or subject (case-insensitive substring).
- The header checkbox selects or deselects **all rows that pass the current filter**.
- **Show unsubscribed** toggle (off by default). It hides rows whose status is `unsubscribed`
  *as of the scan*. Rows unsubscribed during the current session stay visible with their ✅ until
  the next scan, so nothing disappears unexpectedly.
- **Unsubscribe from N selected** (disabled when N = 0 or a job is running) opens the confirm dialog.
- Rows can't be selected while their sender is part of a running job.

### 3.4 Confirm dialog

```
Unsubscribe from 12 senders?
  9 by one-click
  2 by email: sends an unsubscribe email from your account
  1 manual: you'll finish in your browser
Existing emails from these senders:
  (•) Leave them   ( ) Archive   ( ) Move to Trash
[Cancel]  [Unsubscribe]
```

This dialog is the "user consent" that RFC 8058 requires before a one-click POST.

### 3.5 Running and results

- Row statuses update live as each sender finishes (the page polls the job every 500 ms).
- When the job finishes, a results panel shows `✅ 10 unsubscribed · ❌ 1 failed · ↗ 1 needs you`
  followed by a per-sender list. Manual senders have **Open** (opens the link in a new tab with
  `rel="noopener noreferrer"`) and **Mark done** (records the sender as unsubscribed in history).
  The same two buttons appear in the Status cell of any row with status `manual`.
- A cleanup error is reported alongside the unsubscribe result, e.g.
  "Unsubscribed, but couldn't move emails to Trash: <reason>".

## 4. Architecture

```
package.json  tsconfig.json  vite.config.ts  .env.example  .gitignore  README.md
server/
  index.ts            Express on 127.0.0.1:PORT. Mounts /api; dev: Vite middleware, prod: static web/dist
  config.ts           Env + paths (PORT, client id/secret, FAKE_GMAIL, data dir)
  security.ts         Host / Origin / Content-Type guards
  routes.ts           /api handlers; thin, delegates to modules
  auth/google.ts      OAuth2 client, consent URL + state, code exchange, token load/save/refresh/revoke
  gmail/client.ts     GmailClient interface + GoogleGmailClient (googleapis), with retry/backoff
  gmail/fake.ts       FakeGmailClient (in-memory, seeded) for tests and FAKE_GMAIL=1 demo mode
  gmail/retry.ts      Retry with exponential backoff + jitter for 429/5xx/rate-limit 403
  scan/headers.ts     Pure parsers: From, List-Unsubscribe, List-Unsubscribe-Post, DKIM gate, RFC 2047 decode
  scan/scanner.ts     list → fetch metadata → group → derive status from history → Subscription[]
  unsub/urlPolicy.ts  Validates one-click targets (https only; no private/loopback/link-local hosts)
  unsub/methods.ts    oneClick(url), sendMailto(mailto)
  unsub/runner.ts     Per-sender pipeline: method → fallback → cleanup → history
  store/json.ts       Atomic JSON read/write (temp file + rename), corrupt-file recovery
  store/history.ts    .data/history.json access
  store/tokens.ts     .data/tokens.json access (file mode 0600)
  jobs.ts             In-memory job registry: one active job at a time, progress, incremental results
  fakeEndpoints.ts    Demo-mode-only routes that act as one-click endpoints (some fail on purpose)
shared/
  types.ts            Subscription, Method, Status, Job, SenderResult, CleanupMode, API payloads
web/
  index.html  main.tsx  App.tsx  api.ts  styles.css
  components/ SetupNotice.tsx SignIn.tsx Header.tsx SubscriptionTable.tsx ConfirmDialog.tsx
              ScanProgress.tsx ResultsPanel.tsx StatusCell.tsx
tests/        Vitest unit + API tests (mirrors server/ layout)
e2e/          Playwright spec run against FAKE_GMAIL=1
```

Key boundaries:

- **GmailClient interface**: the only module that touches `googleapis` is `GoogleGmailClient`.
  The scanner, runner and routes depend on the interface, so the fake can stand in for tests and
  demo mode.
- **The server holds the latest scan.** `POST /api/unsubscribe` takes sender addresses only. The
  server resolves unsubscribe targets from its own scan result, so the browser never supplies a
  URL for the server to request.
- **Jobs**: scan and unsubscribe are long-running jobs polled by ID. One job runs at a time;
  starting another while one is running returns `409` with the active job's ID.

### 4.1 GmailClient interface

```ts
interface GmailClient {
  getProfileEmail(): Promise<string>;
  listMessageIds(query: string, opts?: { onPage?: (count: number) => void }): Promise<string[]>; // paginates, maxResults=500
  getMessageMetadata(id: string): Promise<MessageMeta>;   // format=metadata, selected headers
  sendRaw(rawRfc822: string): Promise<void>;               // base64url-encodes internally
  archive(ids: string[]): Promise<void>;                   // batchModify removeLabelIds INBOX, chunks of 1000
  trash(ids: string[]): Promise<void>;                     // messages.trash per id, concurrency-limited
}
interface MessageMeta {
  id: string; internalDate: number;                        // ms epoch (from internalDate, not the Date header)
  headers: Record<string, string[]>;                       // lowercased name → all values, in order
}
```

Metadata headers requested: `From`, `Subject`, `List-Unsubscribe`, `List-Unsubscribe-Post`,
`Authentication-Results`, `DKIM-Signature`.

## 5. HTTP API

All JSON. Mutating routes require `Content-Type: application/json` (see §9).

| Method & path | Body | Response |
|---|---|---|
| `GET /api/status` | – | `{ configured, signedIn, email?, authError?, activeJobId?, hasScan }` |
| `GET /api/auth/login` | – | 302 to the Google consent screen (state stored server-side, single use, 10-min TTL) |
| `GET /api/auth/callback?code&state` | – | Exchanges the code, saves tokens, 302 to `/`. Bad or missing state → 400 page. |
| `POST /api/auth/logout` | `{}` | Revokes the token (best effort), deletes `tokens.json`, clears the scan. `{ ok: true }` |
| `POST /api/scan` | `{}` | `{ jobId }` (202) or 409 `{ activeJobId }` |
| `GET /api/scan/latest` | – | `{ scannedAt, subscriptions: Subscription[], skipped: number }` or 404 |
| `POST /api/unsubscribe` | `{ senders: string[], cleanup: "leave"\|"archive"\|"trash" }` | `{ jobId }` (202), 400 for unknown senders or an empty list, 409 if busy |
| `POST /api/manual-done` | `{ sender: string }` | `{ ok: true }`. Records `manual-done` in history. |
| `GET /api/jobs/:id` | – | `Job` (see §6), 404 if unknown |

## 6. Data model

```ts
type Method = "one-click" | "mailto" | "manual";
type Status = "active" | "unsubscribed" | "still-sending" | "manual" | "failed";

interface UnsubTargets { oneClickUrl?: string; mailto?: string; webUrl?: string }

interface Subscription {
  sender: string;            // lowercased address, the row key
  name: string;              // display name from newest message ('' if none)
  count: number;             // messages in window
  lastReceived: number;      // ms epoch
  latestSubject: string;
  method: Method;            // best available method (after the DKIM gate)
  targets: UnsubTargets;     // fallbacks available
  status: Status;            // derived from history (§7.3)
  lastAttempt?: HistoryEntry;
}

type CleanupMode = "leave" | "archive" | "trash";

interface SenderResult {
  sender: string;
  outcome: "unsubscribed" | "manual" | "failed";
  methodUsed?: Method;       // the method that produced the outcome
  detail: string;            // e.g. "HTTP 200", "sent email to unsub@x.com", "HTTP 500; no fallback"
  manualUrl?: string;        // present when outcome = manual
  cleanup?: { mode: CleanupMode; ok: boolean; count?: number; error?: string };
}

interface Job {
  id: string; kind: "scan" | "unsubscribe";
  state: "running" | "done" | "error";
  progress: { done: number; total: number };
  results: SenderResult[];   // unsubscribe jobs: appended as each sender completes
  error?: { code: "AUTH_EXPIRED" | "GMAIL_ERROR" | "INTERNAL"; message: string };
  startedAt: number; finishedAt?: number;
}
```

### 6.1 Files (`.data/`, git-ignored)

- `tokens.json`: the googleapis `Credentials` object. Written with mode `0600`. Updated on the
  OAuth client's `tokens` event so refreshed access tokens persist.
- `history.json`: `{ "version": 1, "senders": { [sender]: HistoryEntry } }`, holding the latest
  attempt per sender:

```ts
interface HistoryEntry {
  outcome: "unsubscribed" | "manual-pending" | "manual-done" | "failed";
  method?: Method; at: number; detail: string; manualUrl?: string;
}
```

All writes go to a temp file and are then renamed, so a crash can't leave half-written JSON.
If a file fails to parse, it is renamed to `*.corrupt-<ts>.json` and the app starts with an
empty file and logs a warning.

## 7. Scanning

### 7.1 Algorithm

1. `listMessageIds("unsubscribe newer_than:30d")` (Spam and Trash are excluded by default because
   `includeSpamTrash=false`). Gmail search has no operator for the `List-Unsubscribe` header, so
   the full-text term `unsubscribe` narrows the set to likely bulk mail. Known limitation: a
   message with the header but without the word "unsubscribe" anywhere is missed.
2. Fetch metadata for each ID with concurrency 8 and retry (§10). Progress = fetched / total.
   Messages that still fail after retries are skipped and counted (`skipped`).
3. For each message: parse `From`. Parse `List-Unsubscribe` into targets. Drop messages with no
   usable target.
4. Group by sender address. `count` = messages in the group. `lastReceived`, `name` and
   `latestSubject` come from the newest message. Targets come from the newest message that has
   a usable target.
5. Determine `method` (§7.2) and `status` (§7.3). Store the result as the server's latest scan.

### 7.2 Header parsing and method selection (`scan/headers.ts`, pure)

- **RFC 2047**: decode `=?charset?B|Q?...?=` encoded words in `From` and `Subject` if present
  (it does nothing to already-decoded text).
- **From**: handle `Name <addr>`, `"Quoted, Name" <addr>`, and a bare `addr`. Lowercase the address.
- **List-Unsubscribe**: a comma-separated list of `<URI>` items. Allow folded whitespace and
  newlines. Take the first `https:` URI (or `http:`, which can only be used as a manual web link)
  and the first `mailto:` URI. Ignore other schemes and malformed items.
- **One-click eligible** when all of the following hold:
  1. `List-Unsubscribe-Post` equals `List-Unsubscribe=One-Click` (trimmed, case-insensitive), and
  2. there is an `https:` URI, and
  3. **DKIM gate** (RFC 8058 §4): some `DKIM-Signature` header has an `h=` tag listing both
     `list-unsubscribe` and `list-unsubscribe-post`, and its `d=` domain matches a `dkim=pass`
     result in an `Authentication-Results` header whose authserv-id is `mx.google.com`. "Matches"
     means the result's `header.i` domain (or `header.d`) equals `d=` or is a subdomain of it.
- **Method** = `one-click` if eligible, else `mailto` if a mailto URI exists, else `manual` if
  an http(s) URI exists. `targets` keeps every target found, so the runner can fall back.

### 7.3 Status derivation (from history)

Given the latest `HistoryEntry` for the sender, `e`:

- No entry → `active`.
- `e.outcome = failed` → `failed` (the UI shows `e.detail`; the row stays selectable for a retry).
- `e.outcome ∈ {unsubscribed, manual-done}`: `still-sending` if `lastReceived > e.at + 48h`,
  otherwise `unsubscribed`.
- `e.outcome = manual-pending` → `manual`.

## 8. Unsubscribing (`unsub/runner.ts`)

The senders in one job are processed with concurrency 4. For each sender:

1. **Attempt methods in order**, starting at the scan's chosen method:
   - **one-click**: `POST` to `oneClickUrl` with a `multipart/form-data` body of
     `List-Unsubscribe=One-Click`. No cookies or auth, a generic `User-Agent`
     (`gmail-bulk-unsubscribe/1.0`), a 10 s timeout, and `redirect: "manual"` (redirects are
     not followed). The URL must pass `urlPolicy` first (§9). **2xx or 3xx** → unsubscribed
     (status code recorded). Anything else, a timeout, a network error or a policy rejection →
     failure, then fall through.
   - **mailto**: parse `mailto:addr?subject=..&body=..`. Build an RFC 822 message
     (`To`, `Subject` defaulting to `unsubscribe`, `body` defaulting to `unsubscribe`,
     `Content-Type: text/plain; charset=UTF-8`) and send it via `GmailClient.sendRaw`. Success →
     unsubscribed. The sent email remains in the user's Sent folder. Failure → fall through.
   - **manual**: if `webUrl` (or `oneClickUrl`) exists → outcome `manual` with `manualUrl`.
     The app does not request the URL.
   - Nothing left → outcome `failed` with the accumulated reasons.
2. **Record history** right away (`unsubscribed` / `manual-pending` / `failed`), so a crash
   mid-job keeps what has completed.
3. **Cleanup** (when mode ≠ leave and the outcome ≠ failed): `listMessageIds("from:(<sender>)")`
   across all time, then `archive(ids)` or `trash(ids)`. Failures are recorded in
   `SenderResult.cleanup` and don't change the unsubscribe outcome. Failed senders are not
   cleaned up, so their mail stays and they can be retried.
4. Update that sender's row in the server's in-memory scan (`status`, `lastAttempt`), append the
   `SenderResult` to the job, and increment progress. The client decides which rows to hide
   based on statuses *as loaded with the scan*, so rows changed during the session stay visible
   until the next scan or page reload.

`POST /api/manual-done` writes `manual-done` to history and updates the in-memory scan row to
`unsubscribed`.

## 9. Security (localhost app)

- Listen on `127.0.0.1` only.
- **Host guard**: reject requests whose `Host` isn't `127.0.0.1:PORT` or `localhost:PORT`
  (blocks DNS rebinding).
- **CSRF guard** on every non-GET route: require `Content-Type: application/json`, and if an
  `Origin` header is present it must be `http://127.0.0.1:PORT` or `http://localhost:PORT`.
  No CORS headers are sent. Cross-site pages therefore can't make the browser send an accepted
  POST.
- **OAuth**: random 32-byte `state`, single use, 10-minute TTL, stored server-side. Scope:
  `https://www.googleapis.com/auth/gmail.modify` only (covers read, send, label changes and
  trash; it can't permanently delete). `access_type=offline`, `prompt=consent`. Redirect URI:
  `http://127.0.0.1:PORT/api/auth/callback`.
- **Tokens**: `.data/tokens.json` with mode 0600, never logged, never sent to the browser.
- **One-click URL policy**: `https:` only; no userinfo. The host must not be `localhost`; must not
  be an IP literal in loopback, private, link-local, CGNAT or unique-local ranges; and must not
  DNS-resolve to any of those. In demo mode (`FAKE_GMAIL=1`) the policy also allows
  `http://127.0.0.1:PORT/__fake/*`.
- **Manual links** are opened only by the user's browser, with `noopener noreferrer`.
- **The DKIM gate** (§7.2) keeps the app from automatically POSTing to URLs in mail whose
  unsubscribe headers aren't authenticated.

## 10. Error handling

- **Gmail retries** (`gmail/retry.ts`): HTTP 429, 5xx, and 403 with reason `rateLimitExceeded` /
  `userRateLimitExceeded` → exponential backoff with full jitter (base 500 ms, factor 2,
  max 5 attempts, cap 16 s).
- **Auth failures**: `invalid_grant` on refresh, or a 401 after a refresh attempt → delete the
  tokens, set `authError = "expired"`, and fail the active job with `AUTH_EXPIRED`. The UI shows
  the reconnect screen (§3.1).
- **Scan**: a list failure fails the job (`GMAIL_ERROR`). Per-message fetch failures after
  retries are skipped and counted. The UI shows "N emails couldn't be read" when N > 0.
- **Unsubscribe**: one sender's failure never stops the job. An unexpected exception for a sender
  becomes `failed` with its message.
- **Server restart**: jobs and the scan are in memory, so `GET /api/jobs/:id` returns 404 after a
  restart. The UI then shows "The server restarted, rescan to continue." History survives.
- **Missing config** → `configured: false` → setup screen (§3.1).
- **Port in use** → the server exits with a clear message suggesting `PORT=xxxx npm run dev`
  (and the matching redirect URI change).

## 11. Testing

- **Unit (Vitest)**:
  - `headers`: List-Unsubscribe variants (multiple URIs, folding, missing brackets, mailto with
    params, unknown schemes), the One-Click header, the DKIM gate (pass, fail, missing `h=`
    entries, subdomain `header.i`, a non-Google authserv-id), From parsing, RFC 2047.
  - `scanner` with `FakeGmailClient`: grouping, newest-message selection, method choice, status
    derivation including the 48h boundary, skipped count.
  - `runner`: the fallback chain (one-click 500 → mailto → manual), 3xx = success, timeout,
    the policy rejection path, cleanup modes, cleanup failure isolation, the history writes.
  - `urlPolicy`: the allowed and blocked matrix (IP literals, a resolved-private host via an
    injected resolver).
  - `store/json`: atomic write and corrupt-file recovery.
  - `retry`: retries on the listed errors, gives up on others, respects max attempts (fake timers).
- **API (Vitest + supertest)** against `FakeGmailClient`: status, scan job lifecycle,
  unsubscribe job lifecycle, `409` when busy, `400` validation, `manual-done`, security guards
  (bad Host, foreign Origin, non-JSON POST), and OAuth state checks.
- **E2E (Playwright)** against `FAKE_GMAIL=1`: load → auto-scan → sort/search → select →
  confirm with Trash → live statuses → results panel → Manual Open/Mark done → rescan hides
  the unsubscribed senders.
- **Real Gmail**: can't be automated from the build environment. The README includes a first-run
  smoke checklist (start with 1–2 senders).

## 12. Setup (README must cover)

1. Node ≥ 22.12, then `npm install`.
2. Google Cloud: create a project → enable the **Gmail API** → OAuth consent screen *External*,
   status *Testing*, add yourself as a **test user** → create an OAuth client of type
   **Web application** with the authorized redirect URI `http://127.0.0.1:3000/api/auth/callback`.
3. `cp .env.example .env` and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. `npm run dev`, then open `http://127.0.0.1:3000`. Expect the "Google hasn't verified this app"
   warning (Advanced → Continue).
5. Sign-in expires every 7 days in Testing mode; reconnect when prompted.
6. `npm start` for a built, non-watch run. `FAKE_GMAIL=1 npm run dev` for demo mode.
7. Known limitations: header-only detection, the "unsubscribe" keyword prefilter, the 30-day
   window, and manual links needing a human.

## 13. Acceptance criteria

1. **AC-1 OAuth**: With valid `.env`, clicking Connect Gmail completes Google consent and returns
   to the app showing the account email. Restarting the server keeps the user signed in (token
   persisted). Sign out revokes the token and removes it from disk.
2. **AC-2 Expiry**: An expired or revoked refresh token leads to the reconnect screen with the
   7-day explanation, not a crash or a blank table.
3. **AC-3 Scan**: Signed in, the app scans the last 30 days (excluding Spam/Trash), shows
   progress, and lists one row per sender address that has a usable `List-Unsubscribe` header,
   with name, address, 30-day count, last received, latest subject and method.
4. **AC-4 Method**: Method is One-click only when the One-Click header and an https URI are present
   **and** the DKIM gate passes. Otherwise it's Email if a mailto exists, otherwise Manual.
5. **AC-5 Table**: Rows sort by any column (default: count, descending), filter by search text,
   and the header checkbox selects all filtered rows.
6. **AC-6 Confirm**: Bulk unsubscribe requires the confirm dialog, which shows counts per method
   and the Leave/Archive/Trash choice (default Leave).
7. **AC-7 Execute**: One-click senders receive an RFC 8058 POST, Email senders receive an
   unsubscribe email sent from the account, and Manual senders end with Open and Mark done
   controls. A failed one-click falls back to mailto, then manual. Statuses update live, and a
   results summary appears at the end.
8. **AC-8 Cleanup**: Archive removes `INBOX` from, and Trash moves to Trash, *all* messages from
   each successfully-handled (or manual) sender. Cleanup errors are shown without changing the
   unsubscribe outcome.
9. **AC-9 Memory**: After a rescan, previously unsubscribed senders are hidden unless "Show
   unsubscribed" is on. Senders with mail newer than 48h after the unsubscribe show
   **Still sending**. Manual senders marked done count as unsubscribed.
10. **AC-10 Safety**: The server only listens on 127.0.0.1. Requests with a foreign Host/Origin or
    non-JSON POSTs are rejected. One-click never targets non-https or private-network hosts.
11. **AC-11 Demo/Test**: `FAKE_GMAIL=1 npm run dev` runs the whole UI flow without Google
    credentials. `npm test` and `npm run typecheck` pass.

## 14. Future (explicitly out of scope now)

Gmail filters for future mail, a configurable scan window, scan caching, multiple accounts, and
body-link detection.
