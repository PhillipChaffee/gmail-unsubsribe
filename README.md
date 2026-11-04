# Gmail Bulk Unsubscribe

A localhost web app that scans your recent Gmail for newsletters and marketing mail, lists the
senders in one table, and unsubscribes from the ones you pick, in bulk. It runs only on your
machine and talks only to Google and to the unsubscribe endpoints found in your mail.

## What it does

- Scans the last 30 days of mail matching `unsubscribe` and groups it by sender.
- Reads the `List-Unsubscribe` headers and picks the best method per sender: one-click, `mailto`,
  or a manual link.
- Unsubscribes from the senders you select. Optionally archives or trashes their existing mail
  (Leave, Archive or Trash). Archive and Trash cover **all** mail from that exact sender address,
  not just the last 30 days.
- Records every attempt in a local history. After a rescan, senders you left are hidden unless
  **Show unsubscribed** is on, and senders that keep mailing you after 48 hours show up as
  "still sending".

## Requirements

- Node.js 22.12 or newer
- A Google account and a free Google Cloud project (the app uses your own OAuth client)
- Install dependencies once with `npm install`

## Google Cloud setup

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a new project.
2. Go to **APIs & Services > Library** and enable the **Gmail API**.
3. Go to **APIs & Services > OAuth consent screen**. Choose user type **External** and leave the
   publishing status as **Testing**.
4. Under **Test users**, add the Google account whose mailbox you want to clean up. Without this
   step Google blocks the sign-in.
5. Go to **APIs & Services > Credentials > Create credentials > OAuth client ID**. Choose
   application type **Web application**.
6. Under **Authorized redirect URIs**, add exactly:

   ```
   http://127.0.0.1:3000/api/auth/callback
   ```

   If you change `PORT`, use that port here too.
7. Copy the client ID and client secret.

The app requests one scope, `https://www.googleapis.com/auth/gmail.modify`. It covers reading,
sending the unsubscribe email, and label and trash changes. It cannot permanently delete mail.

## Configure `.env`

```
cp .env.example .env
```

Fill in:

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
PORT=3000
```

Optional: `DATA_DIR` (default `.data`) and `FAKE_GMAIL=1` (demo mode).

## Run

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with file watching and hot reload. |
| `npm start` | Builds the UI, then runs the server without watching. |
| `npm run demo` | Demo mode with a fake mailbox. No Google account needed. |

In demo mode, the one sender whose one-click fails and has no email fallback (Nimbus Cloud
Storage) ends as Manual with an **Open** link that can't be opened: its fake page is an `https:`
URL on the plain-http demo server. Use **Mark done** instead.

Then open <http://127.0.0.1:3000>. The server listens on `127.0.0.1` only. On first sign-in,
Google shows "Google hasn't verified this app". Choose **Advanced > Continue**; this is expected
for an app in Testing mode.

## First-run smoke checklist

1. Run `npm run demo` first and click through a scan and an unsubscribe. The fake mailbox is safe.
2. Stop it, run `npm run dev` (or `npm start`), and sign in with Google.
3. Check that the email address in the header is the account you expect.
4. The scan starts automatically after sign-in; wait for the table to fill.
5. Pick one or two one-click senders you really want gone, choose **Leave**, and confirm.
6. Check that those rows show the checkmark in the results.
7. For any sender handled by the Email method, check your Gmail **Sent** folder for the
   unsubscribe message.

## How detection and methods work

The scan searches `unsubscribe newer_than:30d`, fetches only headers, and parses `From`,
`List-Unsubscribe` and `List-Unsubscribe-Post`. Each sender gets one method:

- **One-click**: the app sends an RFC 8058 `POST` (`List-Unsubscribe=One-Click`) to the `https:`
  URL. It sends no cookies, does not follow redirects, and times out after 10 seconds. It is used
  only when all of these hold:
  - `List-Unsubscribe-Post` is `List-Unsubscribe=One-Click`;
  - there is an `https:` URI;
  - the **DKIM gate** passes: a `DKIM-Signature` signs both `list-unsubscribe` and
    `list-unsubscribe-post` (its `h=` tag), and its `d=` domain matches a `dkim=pass` result in a
    `mx.google.com` `Authentication-Results` header.

  If the gate fails, the sender is demoted to the next method. This stops the app from POSTing to
  URLs in mail whose unsubscribe headers could be forged.
- **Email** (`mailto:`): the app sends the unsubscribe message from your account through Gmail. It
  stays in your Sent folder. Only a `mailto:` with exactly one plain address is used; a list of
  recipients is rejected, so a sender can't make your account mail anyone else.
- **Manual**: the app only gives you the link. You open it yourself and mark the sender done.

If a method fails, the app falls through to the next one. URLs are also checked before any
request: `https:` only, no credentials in the URL, and no localhost, loopback, private, link-local,
CGNAT (`100.64.0.0/10`), unique-local (`fc00::/7`) or other reserved addresses, whether written
as an IP or reached through DNS (every resolved address is checked).

## Known limitations

- Detection is header-only. Mail without a `List-Unsubscribe` header is not listed.
- The search prefilter is the word `unsubscribe`. A message with the header but without that word
  anywhere is missed.
- Only the last 30 days are scanned.
- Manual links need a human to finish them.

## Troubleshooting

- **`redirect_uri_mismatch`**: the redirect URI in Google Cloud must match exactly, including the
  port: `http://127.0.0.1:PORT/api/auth/callback`. `localhost` is not the same as `127.0.0.1`.
- **"Access blocked: app not verified"**: add your Google account as a test user on the OAuth
  consent screen.
- **"Sign-in failed: invalid_client"** (in the browser tab and the terminal): the client ID or
  client secret in `.env` is wrong. Copy both again from **APIs & Services > Credentials**, restart
  the server and click **Try again**. Other reasons, such as `invalid_grant`, usually mean the
  sign-in link was used twice or took too long; just try again.
- **Sign-in expires every week**: apps in Testing mode lose their refresh token after 7 days.
  Click **Connect Gmail** and sign in again.
- **Port in use**: set a different `PORT` in `.env` and add the matching redirect URI in Google
  Cloud, or stop whatever is using the port.

## Data and privacy

Tokens (`tokens.json`, mode 0600) and unsubscribe history (`history.json`) are stored in `.data/`,
which is git-ignored. Demo mode uses `.data/demo/`. Nothing leaves your machine except calls to
Google and to the unsubscribe endpoints in your mail. The app has no analytics and no server of
its own.

## Development

```
npm test               # unit and integration tests (vitest)
npx playwright install chromium   # once, before the E2E tests
npm run test:e2e       # browser tests against the demo server
npm run typecheck
```
