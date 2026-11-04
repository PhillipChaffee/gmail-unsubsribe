import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { Job, JobStartResponse, ScanResult, StatusResponse } from "../shared/types";

const senders = (rows: Locator) => rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-sender") ?? ""));
const row = (page: Page, sender: string) => page.locator(`[data-testid="row"][data-sender="${sender}"]`);
const statusOf = (page: Page, sender: string) => row(page, sender).getByTestId("status-cell");
const resultRow = (page: Page, sender: string) => page.locator(`[data-testid="result-row"][data-sender="${sender}"]`);

async function select(page: Page, ...list: string[]): Promise<void> {
  for (const sender of list) await row(page, sender).getByTestId("row-checkbox").check();
}

/** Opens the confirm dialog for the current selection. */
async function openDialog(page: Page): Promise<Locator> {
  await page.getByTestId("unsubscribe-button").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Clicks Rescan and waits until the new scan is loaded. */
async function rescan(page: Page): Promise<void> {
  const loaded = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/scan/latest" && res.ok());
  await page.getByTestId("rescan-button").click();
  await loaded;
}

/** The server's view of a sender's row in its latest scan. */
async function serverStatus(request: APIRequestContext, sender: string): Promise<string | undefined> {
  const scan = (await (await request.get("/api/scan/latest")).json()) as ScanResult;
  return scan.subscriptions.find((s) => s.sender === sender)?.status;
}

test.beforeEach(async ({ page, request }) => {
  expect((await request.post("/__fake/reset")).ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("row").first()).toBeVisible();
});

test("confirm dialog shows per-method counts and defaults to Leave", async ({ page }) => {
  await select(
    page,
    "briefing@dailybrief.example", // one-click
    "deals@northwindoutfitters.example", // one-click
    "team@harborfitness.example", // one-click
    "hello@maplestreetbakery.example", // email (mailto only)
    "hello@freshmealkits.example", // email (one-click headers, DKIM gate fails)
    "cellar@sunsetwineclub.example", // manual (http link only)
  );
  await expect(page.getByTestId("unsubscribe-button")).toHaveText("Unsubscribe from 6 selected");
  const dialog = await openDialog(page);

  await expect(dialog.getByRole("heading")).toHaveText("Unsubscribe from 6 senders?");
  await expect(dialog.getByTestId("confirm-count-one-click")).toHaveText("3 by one-click");
  await expect(dialog.getByTestId("confirm-count-mailto")).toHaveText("2 by email: sends an unsubscribe email from your account");
  await expect(dialog.getByTestId("confirm-count-manual")).toHaveText("1 manual: you'll finish in your browser");
  await expect(dialog).toContainText("Existing emails from these senders:");

  await expect(dialog.getByTestId("cleanup-leave")).toBeChecked();
  await expect(dialog.getByTestId("cleanup-archive")).not.toBeChecked();
  await expect(dialog.getByTestId("cleanup-trash")).not.toBeChecked();
  await expect(dialog.getByLabel("Leave them")).toBeChecked();
  await expect(dialog.getByLabel("Archive")).not.toBeChecked();
  await expect(dialog.getByLabel("Move to Trash")).not.toBeChecked();
  await expect(dialog.getByTestId("confirm-cancel")).toHaveText("Cancel");
  await expect(dialog.getByTestId("confirm-submit")).toHaveText("Unsubscribe");
});

test("cancel closes dialog without changes", async ({ page, request }) => {
  const picked = ["briefing@dailybrief.example", "hello@maplestreetbakery.example"];
  await select(page, ...picked);

  let dialog = await openDialog(page);
  await dialog.getByTestId("cleanup-trash").check();
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toBeHidden();

  // Nothing ran: no job, the rows are unchanged and still selected.
  await expect(page.getByTestId("unsubscribe-button")).toHaveText("Unsubscribe from 2 selected");
  for (const sender of picked) {
    await expect(statusOf(page, sender)).toHaveText("");
    await expect(row(page, sender).getByTestId("row-checkbox")).toBeChecked();
    expect(await serverStatus(request, sender)).toBe("active");
  }
  expect(((await (await request.get("/api/status")).json()) as StatusResponse).activeJobId).toBeUndefined();

  // Reopening starts from Leave again, and Escape cancels too.
  dialog = await openDialog(page);
  await expect(dialog.getByTestId("cleanup-leave")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("unsubscribe-button")).toHaveText("Unsubscribe from 2 selected");
});

test("unsubscribing one-click senders shows ✅ and the summary", async ({ page }) => {
  // Demo senders whose one-click endpoint is /__fake/unsub/ok/... (answers 200).
  const ok = ["briefing@dailybrief.example", "deals@northwindoutfitters.example", "offers@gadgetgrove.example"];
  await select(page, ...ok);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("confirm-count-one-click")).toHaveText("3 by one-click");
  await expect(dialog.getByTestId("confirm-count-mailto")).toHaveCount(0);
  await expect(dialog.getByTestId("confirm-count-manual")).toHaveCount(0);

  // Hold the job polls, so the rows' in-flight state can be checked before any result arrives.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/jobs/*", async (route) => {
    await held;
    await route.continue();
  });
  await dialog.getByTestId("confirm-submit").click();
  await expect(dialog).toBeHidden();
  for (const sender of ok) {
    await expect(statusOf(page, sender)).toHaveText("Unsubscribing…");
    await expect(row(page, sender).getByTestId("row-checkbox")).toBeDisabled();
  }
  await expect(page.getByTestId("unsubscribe-button")).toBeDisabled();
  await expect(page.getByTestId("rescan-button")).toBeDisabled();
  release();

  for (const sender of ok) await expect(statusOf(page, sender)).toHaveText("✅ Unsubscribed");
  const panel = page.getByTestId("results-panel");
  await expect(panel.getByTestId("results-summary")).toHaveText("✅ 3 unsubscribed");
  expect((await senders(panel.getByTestId("result-row"))).sort()).toEqual([...ok].sort());
  for (const sender of ok) await expect(resultRow(page, sender)).toContainText("✅ Unsubscribed");

  // The selection is cleared once the job is done.
  await expect(page.getByTestId("unsubscribe-button")).toHaveText("Unsubscribe from 0 selected");
  await expect(page.locator('[data-testid="row-checkbox"]:checked')).toHaveCount(0);
  await expect(page.getByTestId("rescan-button")).toBeEnabled();

  await panel.getByTestId("results-dismiss").click();
  await expect(panel).toBeHidden();
  for (const sender of ok) await expect(statusOf(page, sender)).toHaveText("✅ Unsubscribed");
});

test("failing one-click with mailto falls back and shows ✅", async ({ page }) => {
  // Its one-click endpoint answers 500; the list also offers a mailto.
  const sender = "style@urbanthreads.example";
  await expect(row(page, sender).getByTestId("method-badge")).toHaveText("One-click");
  await select(page, sender);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("confirm-count-one-click")).toHaveText("1 by one-click");
  await dialog.getByTestId("confirm-submit").click();

  await expect(statusOf(page, sender)).toHaveText("✅ Unsubscribed");
  await expect(page.getByTestId("results-summary")).toHaveText("✅ 1 unsubscribed");
  await expect(resultRow(page, sender)).toContainText("✅ Unsubscribed");
  await expect(resultRow(page, sender)).toContainText("one-click: HTTP 500; sent email to unsubscribe@urbanthreads.example");
});

test("manual sender shows Open and Mark done; Mark done turns it ✅", async ({ page }) => {
  // Both have only an http link, so they end as manual.
  const wine = "cellar@sunsetwineclub.example";
  const arcade = "mail@retroarcade.example";
  await select(page, wine, arcade);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("confirm-count-manual")).toHaveText("2 manual: you'll finish in your browser");
  await dialog.getByTestId("confirm-submit").click();

  const panel = page.getByTestId("results-panel");
  await expect(panel.getByTestId("results-summary")).toHaveText("↗ 2 needs you");
  const links = {
    [wine]: /^http:\/\/email\.sunsetwineclub\.example\/unsubscribe\?id=demo-\d+-\d+$/,
    [arcade]: /^http:\/\/email\.retroarcade\.example\/unsubscribe\?id=demo-\d+-\d+$/,
  };
  for (const [sender, href] of Object.entries(links)) {
    for (const place of [statusOf(page, sender), resultRow(page, sender)]) {
      await expect(place).toContainText("↗ Manual");
      const open = place.getByTestId("manual-open");
      await expect(open).toHaveText("Open");
      await expect(open).toHaveAttribute("href", href);
      await expect(open).toHaveAttribute("target", "_blank");
      await expect(open).toHaveAttribute("rel", "noopener noreferrer");
      await expect(place.getByTestId("manual-done")).toHaveText("Mark done");
    }
  }

  // Mark done from the table row...
  await statusOf(page, wine).getByTestId("manual-done").click();
  await expect(statusOf(page, wine)).toHaveText("✅ Unsubscribed");
  await expect(resultRow(page, wine)).toContainText("✅ Unsubscribed");
  await expect(resultRow(page, wine).getByTestId("manual-done")).toHaveCount(0);
  await expect(panel.getByTestId("results-summary")).toHaveText("✅ 1 unsubscribed · ↗ 1 needs you");

  // ...and from the results panel.
  await resultRow(page, arcade).getByTestId("manual-done").click();
  await expect(statusOf(page, arcade)).toHaveText("✅ Unsubscribed");
  await expect(panel.getByTestId("results-summary")).toHaveText("✅ 2 unsubscribed");

  // The server recorded both: after a reload they load as unsubscribed, so they are hidden by default.
  await page.reload();
  await expect(page.getByTestId("row").first()).toBeVisible();
  await expect(row(page, wine)).toHaveCount(0);
  await expect(row(page, arcade)).toHaveCount(0);
  await page.getByTestId("show-unsubscribed").check();
  await expect(statusOf(page, wine)).toHaveText("✅ Unsubscribed");
  await expect(statusOf(page, arcade)).toHaveText("✅ Unsubscribed");
});

test("trash cleanup then Rescan removes those senders from the table", async ({ page }) => {
  const picked = ["hello@pixelpine.example", "team@harborfitness.example"];
  const rows = page.getByTestId("row");
  const total = await rows.count();
  await select(page, ...picked);
  const dialog = await openDialog(page);
  await dialog.getByTestId("cleanup-trash").check();
  await dialog.getByTestId("confirm-submit").click();

  await expect(page.getByTestId("results-summary")).toHaveText("✅ 2 unsubscribed");
  for (const sender of picked) await expect(statusOf(page, sender)).toHaveText("✅ Unsubscribed");

  await rescan(page);
  for (const sender of picked) await expect(row(page, sender)).toHaveCount(0);
  await expect(rows).toHaveCount(total - picked.length);
  await expect(page.getByTestId("results-panel")).toBeHidden();

  // Their mail is in Trash, which the scan excludes, so Show unsubscribed doesn't bring them back.
  await page.getByTestId("show-unsubscribed").check();
  await expect(rows).toHaveCount(total - picked.length);
  for (const sender of picked) await expect(row(page, sender)).toHaveCount(0);
});

test("leave cleanup then Rescan hides unsubscribed senders until Show unsubscribed is toggled", async ({ page }) => {
  const picked = ["newsletter@brightsidebooks.example", "news@summitair.example"];
  const rows = page.getByTestId("row");
  const total = await rows.count();
  await select(page, ...picked);
  const dialog = await openDialog(page);
  await dialog.getByTestId("confirm-submit").click(); // default: Leave

  await expect(page.getByTestId("results-summary")).toHaveText("✅ 2 unsubscribed");
  // Unsubscribed during this session: they stay visible until the next scan (§3.3).
  for (const sender of picked) await expect(statusOf(page, sender)).toHaveText("✅ Unsubscribed");
  await expect(rows).toHaveCount(total);

  await rescan(page);
  for (const sender of picked) await expect(row(page, sender)).toHaveCount(0);
  await expect(rows).toHaveCount(total - picked.length);

  await page.getByTestId("show-unsubscribed").check();
  await expect(rows).toHaveCount(total);
  for (const sender of picked) await expect(statusOf(page, sender)).toHaveText("✅ Unsubscribed");
});

test("selected rows hidden by search are not unsubscribed", async ({ page, request }) => {
  const shown = "briefing@dailybrief.example";
  const hidden = "deals@northwindoutfitters.example";
  await select(page, shown, hidden);
  await expect(page.getByTestId("unsubscribe-button")).toHaveText("Unsubscribe from 2 selected");

  await page.getByTestId("search-input").fill("dailybrief");
  await expect(page.getByTestId("row")).toHaveCount(1);
  await expect(page.getByTestId("unsubscribe-button")).toHaveText("Unsubscribe from 1 selected");

  const dialog = await openDialog(page);
  await expect(dialog.getByRole("heading")).toHaveText("Unsubscribe from 1 sender?");
  await expect(dialog.getByTestId("confirm-count-one-click")).toHaveText("1 by one-click");
  await dialog.getByTestId("confirm-submit").click();

  await expect(page.getByTestId("results-summary")).toHaveText("✅ 1 unsubscribed");
  expect(await senders(page.getByTestId("result-row"))).toEqual([shown]);

  await page.getByTestId("search-input").fill("");
  await expect(statusOf(page, shown)).toHaveText("✅ Unsubscribed");
  await expect(statusOf(page, hidden)).toHaveText("");
  expect(await serverStatus(request, hidden)).toBe("active");
});

test("a 409 at start follows the running job and clears its notice once that job ends", async ({ page, request }) => {
  const mine = "briefing@dailybrief.example";
  const other = "offers@gadgetgrove.example";
  // Another tab's job, started through the API.
  const started = await request.post("/api/unsubscribe", { data: { senders: [other], cleanup: "leave" } });
  expect(started.status()).toBe(202);
  const { jobId } = (await started.json()) as JobStartResponse;

  // A demo job ends within milliseconds, too soon to race from the page. So the page sees the job as the server
  // shows it while it runs: the page's start gets the busy answer (§5: 409 { activeJobId }), and its first poll
  // finds the job still running. Later polls are held until release.
  await page.route("**/api/unsubscribe", (route) => route.fulfill({ status: 409, json: { activeJobId: jobId } }));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let polls = 0;
  await page.route("**/api/jobs/*", async (route) => {
    if (polls++ === 0) {
      const job = (await (await route.fetch()).json()) as Job;
      await route.fulfill({ json: { ...job, state: "running", results: [] } });
      return;
    }
    await held;
    await route.continue();
  });

  await select(page, mine);
  await (await openDialog(page)).getByTestId("confirm-submit").click();

  // The page follows the running job, and nothing of its own started.
  await expect(statusOf(page, other)).toHaveText("Unsubscribing…");
  await expect(page.getByTestId("rescan-button")).toBeDisabled();
  await expect(statusOf(page, mine)).toHaveText("");
  // The notice stays while that job runs...
  const notice = page.getByRole("alert");
  await expect(notice).toHaveText("Another job is already running. Try again when it finishes.");

  // ...and goes once it ends; the panel shows the followed job's results.
  release();
  await expect(statusOf(page, other)).toHaveText("✅ Unsubscribed");
  await expect(page.getByTestId("results-summary")).toHaveText("✅ 1 unsubscribed");
  expect(await senders(page.getByTestId("result-row"))).toEqual([other]);
  await expect(notice).toHaveCount(0);
  await expect(statusOf(page, mine)).toHaveText("");
});

test("acting on a scan the server no longer holds shows the restart notice, not a raw error", async ({ page, request }) => {
  const sender = "briefing@dailybrief.example";
  // What a server restart does to the page's scan (§10): the server forgets it while the table stays.
  expect((await request.post("/__fake/reset")).ok()).toBe(true);
  await select(page, sender);
  await (await openDialog(page)).getByTestId("confirm-submit").click();

  await expect(page.getByTestId("restart-notice")).toHaveText("The server restarted, rescan to continue.");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("NO_SCAN")).toHaveCount(0);

  // Rescanning clears the notice and the table works again.
  await rescan(page);
  await expect(page.getByTestId("restart-notice")).toHaveCount(0);
});
