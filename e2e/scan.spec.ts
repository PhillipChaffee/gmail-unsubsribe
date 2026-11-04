import { expect, test, type Locator } from "@playwright/test";

const senders = (rows: Locator) => rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-sender") ?? ""));

test.beforeEach(async ({ page, request }) => {
  expect((await request.post("/__fake/reset")).ok()).toBe(true);
  await page.goto("/");
});

test("shows demo banner and account email", async ({ page }) => {
  await expect(page.getByTestId("demo-banner")).toHaveText("Demo mode: fake mailbox");
  await expect(page.getByTestId("account-email")).toHaveText("demo@example.com");
});

test("auto-scans and lists rows sorted by count desc", async ({ page }) => {
  const rows = page.getByTestId("row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(1);

  // The 40-message sender is first, and no row has a higher count than the one above it.
  await expect(rows.first()).toHaveAttribute("data-sender", "briefing@dailybrief.example");
  const counts = (await rows.locator("td.col-count").allTextContents()).map(Number);
  expect(counts[0]).toBe(40);
  expect(counts[0]).toBeGreaterThanOrEqual(counts[1]!);
  expect(counts).toEqual([...counts].sort((a, b) => b - a));
});

test("search filters rows by subject text", async ({ page }) => {
  const rows = page.getByTestId("row");
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();

  // "Morning Brief: markets edge higher" is The Daily Brief's latest subject; the case differs on purpose.
  await page.getByTestId("search-input").fill("morning brief");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-sender", "briefing@dailybrief.example");

  await page.getByTestId("search-input").fill("");
  await expect(rows).toHaveCount(total);
});

test("select-all selects only filtered rows", async ({ page }) => {
  const rows = page.getByTestId("row");
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();

  // Two "deals@" addresses and one "This week's fresh deals" subject.
  await page.getByTestId("search-input").fill("deals");
  await expect(rows).toHaveCount(3);
  const filtered = await senders(rows);
  await page.getByTestId("select-all").check();

  await page.getByTestId("search-input").fill("");
  await expect(rows).toHaveCount(total);
  const checked = page.locator('[data-testid="row"]:has([data-testid="row-checkbox"]:checked)');
  await expect(checked).toHaveCount(filtered.length);
  expect((await senders(checked)).sort()).toEqual([...filtered].sort());
});

test("clicking sort-sender sorts alphabetically", async ({ page }) => {
  const rows = page.getByTestId("row");
  await expect(rows.first()).toBeVisible();
  const names = rows.locator(".sender-name");
  const byCount = await names.allTextContents();
  const alphabetical = [...byCount].sort(new Intl.Collator("en", { sensitivity: "base", numeric: true }).compare);
  expect(alphabetical).not.toEqual(byCount);

  await page.getByTestId("sort-sender").click();
  await expect(names).toHaveText(alphabetical);
  await page.getByTestId("sort-sender").click();
  await expect(names).toHaveText([...alphabetical].reverse());
});

test("method badges show One-click, Email and Manual", async ({ page }) => {
  const rows = page.getByTestId("row");
  await expect(rows.first()).toBeVisible();
  const badge = (sender: string) => page.locator(`[data-testid="row"][data-sender="${sender}"]`).getByTestId("method-badge");

  expect(new Set(await page.getByTestId("method-badge").allTextContents())).toEqual(new Set(["One-click", "Email", "Manual"]));
  await expect(badge("briefing@dailybrief.example")).toHaveText("One-click");
  await expect(badge("hello@maplestreetbakery.example")).toHaveText("Email"); // mailto only
  await expect(badge("hello@freshmealkits.example")).toHaveText("Email"); // one-click headers, DKIM gate fails
  await expect(badge("cellar@sunsetwineclub.example")).toHaveText("Manual"); // http link only
});
