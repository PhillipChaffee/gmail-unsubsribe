import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SenderResult } from "../../shared/types";
import { ResultsPanel } from "../../web/components/ResultsPanel";

const render = (results: SenderResult[]) => renderToStaticMarkup(createElement(ResultsPanel, { results, onManualDone: () => {}, onDismiss: () => {} }));

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

/** Visible text of an HTML fragment: tags become spaces, React's text separators vanish, entities are decoded. */
const textOf = (html: string) =>
  html
    .replaceAll("<!-- -->", "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#x27);/g, (e) => ENTITIES[e]!)
    .replace(/\s+/g, " ")
    .trim();

const summaryOf = (html: string) => textOf(/data-testid="results-summary"[^>]*>(.*?)<\//.exec(html)?.[1] ?? "");

/** The HTML of the result row for `sender` (rows don't nest list items). */
const rowOf = (html: string, sender: string) => {
  const row = new RegExp(`<li[^>]*data-testid="result-row"[^>]*data-sender="${sender}"[^>]*>(.*?)</li>`).exec(html);
  if (!row) throw new Error(`no result row for ${sender}`);
  return row[1]!;
};

const ok = (sender: string, extra: Partial<SenderResult> = {}): SenderResult => ({
  sender,
  outcome: "unsubscribed",
  methodUsed: "one-click",
  detail: "HTTP 200",
  ...extra,
});
const failed = (sender: string, detail: string): SenderResult => ({ sender, outcome: "failed", detail });
const manual = (sender: string, extra: Partial<SenderResult> = {}): SenderResult => ({
  sender,
  outcome: "manual",
  methodUsed: "manual",
  detail: "no automatic unsubscribe method",
  manualUrl: `https://${sender.split("@")[1]}/unsubscribe`,
  ...extra,
});

describe("ResultsPanel summary (§3.5)", () => {
  it("counts each outcome in the order unsubscribed, failed, needs you", () => {
    const html = render([ok("a@x.com"), manual("m@x.com"), failed("f@x.com", "HTTP 500"), ok("b@x.com")]);
    expect(summaryOf(html)).toBe("✅ 2 unsubscribed · ❌ 1 failed · ↗ 1 needs you");
  });

  it("omits the parts whose count is zero", () => {
    expect(summaryOf(render([ok("a@x.com"), ok("b@x.com"), ok("c@x.com")]))).toBe("✅ 3 unsubscribed");
    expect(summaryOf(render([failed("f@x.com", "HTTP 500"), manual("m@x.com")]))).toBe("❌ 1 failed · ↗ 1 needs you");
    expect(summaryOf(render([manual("m@x.com")]))).toBe("↗ 1 needs you");
  });
});

describe("ResultsPanel rows", () => {
  it("lists one row per sender", () => {
    const html = render([ok("a@x.com"), failed("f@x.com", "boom"), manual("m@x.com")]);
    const senders = [...html.matchAll(/data-testid="result-row"[^>]*data-sender="([^"]*)"/g)].map((m) => m[1]);
    expect(senders).toEqual(["a@x.com", "f@x.com", "m@x.com"]);
  });

  it("shows an unsubscribed sender as ✅ with how it was done", () => {
    const text = textOf(rowOf(render([ok("a@x.com", { methodUsed: "mailto", detail: "one-click: HTTP 500; sent email to u@x.com" })]), "a@x.com"));
    expect(text).toContain("✅ Unsubscribed");
    expect(text).toContain("one-click: HTTP 500; sent email to u@x.com");
  });

  it('shows a failed sender as "❌ Failed: <detail>"', () => {
    const text = textOf(rowOf(render([failed("f@x.com", "one-click: HTTP 500; email: invalid mailto")]), "f@x.com"));
    expect(text).toContain("❌ Failed: one-click: HTTP 500; email: invalid mailto");
  });

  it("gives a manual sender Open (new tab, no opener or referrer) and Mark done", () => {
    const row = rowOf(render([manual("m@x.com", { manualUrl: "https://x.com/unsub?id=1&u=2" })]), "m@x.com");
    expect(textOf(row)).toContain("↗ Manual");
    const open = /<a[^>]*data-testid="manual-open"[^>]*>/.exec(row)?.[0] ?? "";
    expect(open).toContain('href="https://x.com/unsub?id=1&amp;u=2"');
    expect(open).toContain('target="_blank"');
    expect(open).toContain('rel="noopener noreferrer"');
    expect(row).toMatch(/<button[^>]*data-testid="manual-done"[^>]*>Mark done<\/button>/);
  });

  it("gives no Open or Mark done to other outcomes", () => {
    const html = render([ok("a@x.com"), failed("f@x.com", "boom")]);
    expect(html).not.toContain("manual-open");
    expect(html).not.toContain("manual-done");
  });
});

describe("ResultsPanel cleanup errors (§3.5)", () => {
  it("reports a failed archive next to the unsubscribe result", () => {
    const text = textOf(rowOf(render([ok("a@x.com", { cleanup: { mode: "archive", ok: false, error: "quota exceeded" } })]), "a@x.com"));
    expect(text).toContain("✅ Unsubscribed");
    expect(text).toContain("Unsubscribed, but couldn't archive emails: quota exceeded");
  });

  it("reports a failed move to Trash", () => {
    const text = textOf(rowOf(render([ok("a@x.com", { cleanup: { mode: "trash", ok: false, count: 4, error: "2 emails couldn't be checked and were left in place" } })]), "a@x.com"));
    expect(text).toContain("Unsubscribed, but couldn't move emails to Trash: 2 emails couldn't be checked and were left in place");
  });

  it("doesn't claim a manual sender is unsubscribed", () => {
    const text = textOf(rowOf(render([manual("m@x.com", { cleanup: { mode: "trash", ok: false, error: "boom" } })]), "m@x.com"));
    expect(text).toContain("Couldn't move emails to Trash: boom");
    expect(text).not.toContain("Unsubscribed, but");
  });

  it("says nothing about a cleanup that worked", () => {
    const text = textOf(rowOf(render([ok("a@x.com", { cleanup: { mode: "archive", ok: true, count: 12 } })]), "a@x.com"));
    expect(text).not.toContain("couldn't");
    expect(text).not.toContain("Couldn't");
  });
});
