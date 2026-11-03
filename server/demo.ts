import { Router } from "express";
import { fakeMessage, type FakeMessage } from "./gmail/fake";
import { postOneClick, type MethodOutcome } from "./unsub/methods";
import { checkOneClickUrl, type UrlCheck } from "./unsub/urlPolicy";

/**
 * How a demo sender unsubscribes:
 * - ok, fail and redirect are one-click senders whose fake endpoint answers 200, 500 or 302.
 * - fail-mailto falls back to email. fail-manual has no mailto, so it ends as manual.
 * - mailto is email only. http has only an http link, so it is manual.
 * - dkim-fail has one-click headers that fail the DKIM gate, so it is demoted to email.
 */
type Kind = "ok" | "fail-mailto" | "fail-manual" | "redirect" | "mailto" | "http" | "dkim-fail";

interface DemoSender {
  from: string;
  kind: Kind;
  count: number;
  /** Days since the newest message; older ones spread evenly back to day 29. */
  newest: number;
  subjects: string[];
}

const SENDERS: DemoSender[] = [
  { from: "Northwind Outfitters <deals@northwindoutfitters.example>", kind: "ok", count: 12, newest: 0.2, subjects: ["48-hour flash sale: 30% off outerwear", "New arrivals for the trail", "Your weekend picks are here"] },
  { from: "The Daily Brief <briefing@dailybrief.example>", kind: "ok", count: 40, newest: 0.1, subjects: ["Morning Brief: markets edge higher", "Morning Brief: what to watch today", "Evening Brief: the day in five stories"] },
  { from: "=?UTF-8?Q?Caf=C3=A9_Lumi=C3=A8re?= <bonjour@cafelumiere.example>", kind: "ok", count: 4, newest: 1.5, subjects: ["Seasonal menu: autumn pastries", "Your loyalty reward is waiting"] },
  { from: "Pixel & Pine Studio <hello@pixelpine.example>", kind: "ok", count: 3, newest: 4, subjects: ["Free icon pack for subscribers", "Design tips: color in dark mode"] },
  { from: "Harbor Fitness <team@harborfitness.example>", kind: "ok", count: 8, newest: 0.8, subjects: ["Your weekly class schedule", "New: sunrise yoga on Saturdays"] },
  { from: "Gadget Grove <offers@gadgetgrove.example>", kind: "ok", count: 9, newest: 0.4, subjects: ["Deal of the day: noise-cancelling headphones", "Price drop on items you viewed"] },
  { from: "Brightside Books <newsletter@brightsidebooks.example>", kind: "ok", count: 5, newest: 2.5, subjects: ["Staff picks for November", "Author Q&A: behind the mystery"] },
  { from: "Summit Air <news@summitair.example>", kind: "ok", count: 6, newest: 1.2, subjects: ["Fares from $59 this week", "Earn double miles on winter trips"] },
  { from: "Greenleaf Grocers <weekly@greenleafgrocers.example>", kind: "ok", count: 4, newest: 3, subjects: ["This week's fresh deals", "Recipe: one-pan harvest chicken"] },
  { from: "Codecraft Weekly <digest@codecraft.example>", kind: "ok", count: 4, newest: 5, subjects: ["Codecraft Weekly #212: type-safe APIs", "Codecraft Weekly #213: profiling in production"] },
  { from: "Lumen Home <hello@lumenhome.example>", kind: "ok", count: 3, newest: 9, subjects: ["Cozy lighting ideas for long nights", "Members save 15% this weekend"] },
  { from: '"Velo Supply Co." <ride@velosupply.example>', kind: "ok", count: 2, newest: 12, subjects: ["Winter riding gear checklist", "Tune-up season: book now"] },
  { from: "Atlas Travel Club <club@atlastravel.example>", kind: "ok", count: 5, newest: 6, subjects: ["Hidden gems: 7 cities to visit in spring", "Your member perks this month"] },
  { from: "Moonbeam Games <news@moonbeamgames.example>", kind: "ok", count: 3, newest: 2, subjects: ["Patch notes 2.4 are live", "Weekend double XP event"] },
  { from: "Riverbend Credit Union <updates@riverbendcu.example>", kind: "ok", count: 2, newest: 15, subjects: ["Your monthly financial wellness tips", "Rates update for savings accounts"] },
  { from: "Petal & Stem <bloom@petalandstem.example>", kind: "ok", count: 3, newest: 7, subjects: ["Fresh bouquets for the weekend", "Free delivery on orders over $40"] },
  { from: "Urban Threads <style@urbanthreads.example>", kind: "fail-mailto", count: 7, newest: 0.6, subjects: ["Last chance: end-of-season sale", "Styled for you: new looks"] },
  { from: "Starlight Cinemas <tickets@starlightcinemas.example>", kind: "fail-mailto", count: 4, newest: 3.5, subjects: ["Now showing: this week's premieres", "Members' Tuesday: half-price tickets"] },
  { from: "QuickCart <promo@quickcart.example>", kind: "fail-mailto", count: 6, newest: 1, subjects: ["Your cart misses you", "Free shipping ends at midnight"] },
  { from: "Nimbus Cloud Storage <news@nimbuscloud.example>", kind: "fail-manual", count: 2, newest: 10, subjects: ["Product update: faster sync", "Your storage report for October"] },
  { from: "Orbit Mobile <offers@orbitmobile.example>", kind: "redirect", count: 3, newest: 4.5, subjects: ["Upgrade offer: new phones from $0 down", "Bring a friend, get a month free"] },
  { from: "Maple Street Bakery <hello@maplestreetbakery.example>", kind: "mailto", count: 3, newest: 2.2, subjects: ["Fresh sourdough every Friday", "Holiday pre-orders are open"] },
  { from: "The Indie Dev Digest <editor@indiedevdigest.example>", kind: "mailto", count: 2, newest: 8, subjects: ["Issue 48: shipping solo", "Issue 49: pricing your first app"] },
  { from: "Community Garden Collective <news@gardencollective.example>", kind: "mailto", count: 2, newest: 11, subjects: ["Volunteer day this Saturday", "Seed swap recap"] },
  { from: "Old Town Hardware <store@oldtownhardware.example>", kind: "mailto", count: 1, newest: 20, subjects: ["Snow shovels are back in stock"] },
  { from: "Sunset Wine Club <cellar@sunsetwineclub.example>", kind: "http", count: 3, newest: 5.5, subjects: ["Your November tasting notes", "Members-only: library vintages"] },
  { from: "Retro Arcade Monthly <mail@retroarcade.example>", kind: "http", count: 1, newest: 18, subjects: ["High scores of the month"] },
  { from: "Bargain Basement <deals@bargainbasement.example>", kind: "http", count: 10, newest: 0.3, subjects: ["Clearance: up to 70% off", "Doorbusters start now", "Today only: buy one, get one"] },
  { from: "Peak Performance Coaching <coach@peakcoaching.example>", kind: "http", count: 2, newest: 13, subjects: ["Free webinar: build better habits", "Your 5-minute morning routine"] },
  { from: "Coastal Living Magazine <subscriptions@coastalliving.example>", kind: "dkim-fail", count: 4, newest: 6.5, subjects: ["Subscriber exclusive: beach house tours", "Renew now and save 40%"] },
  { from: "FreshMeal Kits <hello@freshmealkits.example>", kind: "dkim-fail", count: 5, newest: 1.8, subjects: ["Your next box ships Tuesday", "New on the menu: miso salmon"] },
];

const domainOf = (from: string) => from.slice(from.lastIndexOf("@") + 1).replace(/>$/, "");

function listUnsubscribe(kind: Kind, base: string, id: string, domain: string): string {
  const fake = (path: string) => `<${base}/__fake/unsub/${path}/${id}>`;
  const mailto = `<mailto:unsubscribe@${domain}?subject=unsubscribe>`;
  switch (kind) {
    case "ok":
    case "dkim-fail":
      return `${fake("ok")}, ${mailto}`;
    case "fail-mailto":
      return `${fake("fail")}, ${mailto}`;
    case "fail-manual":
      return fake("fail");
    case "redirect":
      return fake("redirect");
    case "mailto":
      return mailto;
    case "http":
      return `<http://email.${domain}/unsubscribe?id=${id}>`;
  }
}

/** A fictional mailbox (31 senders after scanning) that exercises every method, fallback and exclusion. */
export function createDemoMailbox(opts: { now: number; fakeBaseUrl: string }): FakeMessage[] {
  const messages: FakeMessage[] = [];
  SENDERS.forEach((s, n) => {
    const domain = domainOf(s.from);
    const step = (29 - s.newest) / s.count;
    for (let i = 0; i < s.count; i++) {
      const id = `demo-${String(n).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
      const spec = {
        id,
        from: s.from,
        subject: s.subjects[i % s.subjects.length],
        daysAgo: s.newest + i * step,
        listUnsubscribe: listUnsubscribe(s.kind, opts.fakeBaseUrl, id, domain),
        oneClick: s.kind !== "mailto" && s.kind !== "http",
        dkim: s.kind === "dkim-fail" ? ("fail" as const) : ("pass" as const),
      };
      messages.push(fakeMessage(spec, opts.now));
    }
  });
  // Both carry a usable header, but neither is in the scan: Spam is excluded, and 45 days is outside the window.
  messages.push(
    fakeMessage({ id: "demo-spam", from: "Prize Desk <winner@prize-alerts.example>", subject: "Congratulations, you have been selected!", daysAgo: 2, labels: ["SPAM"] }, opts.now),
    fakeMessage({ id: "demo-old", from: "Seasonal Sale Co <sale@seasonalsale.example>", subject: "Summer clearance ends tonight", daysAgo: 45 }, opts.now),
  );
  return messages;
}

/** Mounted at /__fake in demo mode: stand-in one-click endpoints, some failing on purpose. */
export function fakeEndpointsRouter(): Router {
  const router = Router();
  router.post("/unsub/ok/:id", (_req, res) => void res.sendStatus(200));
  router.post("/unsub/fail/:id", (_req, res) => void res.sendStatus(500));
  router.post("/unsub/redirect/:id", (_req, res) => void res.redirect(302, "/"));
  return router;
}

/**
 * Base URL for the demo mailbox's one-click links. It is https because the scanner only treats https
 * links as one-click (§7.2). The fake endpoints themselves are served over plain http on the same port.
 */
export function demoBaseUrl(port: number): string {
  return `https://127.0.0.1:${port}`;
}

/**
 * Demo one-click deps: the URL policy also allows the fake endpoints (§9), and a one-click POST to
 * `demoBaseUrl(port)/__fake/...` is delivered over http, where the endpoints actually listen.
 */
export function demoOneClick(port: number): {
  checkUrl: (url: string) => Promise<UrlCheck>;
  postOneClick: (url: string) => Promise<MethodOutcome>;
} {
  const httpsPrefix = `${demoBaseUrl(port)}/__fake/`;
  const httpPrefix = `http://127.0.0.1:${port}/__fake/`;
  return {
    checkUrl: (url) => checkOneClickUrl(url, { allowPrefixes: [httpsPrefix, httpPrefix] }),
    postOneClick: (url) => postOneClick(url.startsWith(httpsPrefix) ? httpPrefix + url.slice(httpsPrefix.length) : url),
  };
}
