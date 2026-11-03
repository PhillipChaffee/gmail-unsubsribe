import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeGmailClient } from "../../server/gmail/fake";
import { buildRfc822, parseMailto, postOneClick, sendMailto } from "../../server/unsub/methods";

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = [];
  server = http.createServer((req, res) => {
    const seen: Seen = { method: req.method, url: req.url, headers: req.headers, body: "" };
    requests.push(seen);
    req.on("data", (c) => (seen.body += c));
    req.on("end", () => handler(req, res, seen));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requests };
}

describe("postOneClick", () => {
  it("sends multipart POST with List-Unsubscribe=One-Click and UA, no redirect following", async () => {
    const { base, requests } = await start((_req, res) => res.writeHead(200).end("ok"));
    const out = await postOneClick(`${base}/u`);
    expect(out).toEqual({ ok: true, detail: "HTTP 200" });
    expect(requests).toHaveLength(1);
    const r = requests[0];
    expect(r.method).toBe("POST");
    expect(r.headers["content-type"]).toMatch(/^multipart\/form-data/);
    expect(r.body).toContain("List-Unsubscribe");
    expect(r.body).toContain("One-Click");
    expect(r.headers["user-agent"]).toBe("gmail-bulk-unsubscribe/1.0");
  });

  it("302 counts as ok without following Location", async () => {
    const { base, requests } = await start((_req, res) => res.writeHead(302, { Location: `${base}/elsewhere` }).end());
    const out = await postOneClick(`${base}/u`);
    expect(out).toEqual({ ok: true, detail: "HTTP 302" });
    expect(requests.map((r) => r.url)).toEqual(["/u"]);
  });

  it("500 gives ok:false HTTP 500", async () => {
    const { base } = await start((_req, res) => res.writeHead(500).end());
    expect(await postOneClick(`${base}/u`)).toEqual({ ok: false, detail: "HTTP 500" });
  });

  it("timeout gives ok:false timed out", async () => {
    const { base } = await start(() => {});
    expect(await postOneClick(`${base}/u`, { timeoutMs: 200 })).toEqual({ ok: false, detail: "timed out" });
  });

  it("other errors give ok:false with the message", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await postOneClick("https://x.example/", { fetchImpl })).toEqual({ ok: false, detail: "boom" });
  });

  it("a network failure names its cause instead of the bare 'fetch failed'", async () => {
    const failWith = (cause: unknown) =>
      (async () => {
        throw new TypeError("fetch failed", { cause });
      }) as unknown as typeof fetch;
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND x.example"), { code: "ENOTFOUND" });
    expect(await postOneClick("https://x.example/", { fetchImpl: failWith(dns) })).toEqual({ ok: false, detail: "fetch failed (ENOTFOUND)" });
    const tls = new Error("unable to verify the first certificate");
    expect(await postOneClick("https://x.example/", { fetchImpl: failWith(tls) })).toEqual({
      ok: false,
      detail: "fetch failed (unable to verify the first certificate)",
    });
    expect(await postOneClick("https://x.example/", { fetchImpl: failWith(undefined) })).toEqual({ ok: false, detail: "fetch failed" });
  });

  it("a real connection refusal is reported with its code", async () => {
    const { base } = await start((_req, res) => res.end());
    const port = new URL(base).port;
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await postOneClick(`http://127.0.0.1:${port}/u`)).toEqual({ ok: false, detail: "fetch failed (ECONNREFUSED)" });
  });
});

describe("parseMailto", () => {
  it("parses address, subject and body, keeping + literal", () => {
    expect(parseMailto("mailto:u@x.com?subject=Unsub%20me&body=a+b")).toEqual({ to: "u@x.com", subject: "Unsub me", body: "a+b" });
  });

  it("defaults subject/body to unsubscribe", () => {
    expect(parseMailto("mailto:u@x.com")).toEqual({ to: "u@x.com", subject: "unsubscribe", body: "unsubscribe" });
    expect(parseMailto("mailto:u@x.com?subject=&body=")).toEqual({ to: "u@x.com", subject: "unsubscribe", body: "unsubscribe" });
  });

  it("rejects anything but exactly one plain address, so a header can't add recipients", () => {
    for (const m of [
      "mailto:unsub@list.com,boss@victim-corp.com?subject=I%20resign",
      "mailto:unsub@list.com%2Cboss@victim-corp.com",
      "mailto:unsub@list.com;boss@victim-corp.com",
      "mailto:a@x.com,b",
      "mailto:List%20%3Cunsub@list.com%3E",
      "mailto:unsub@list.com%20boss@victim-corp.com",
      "mailto:@list.com",
      "mailto:unsub@",
    ]) {
      expect(parseMailto(m), m).toBeNull();
    }
  });

  it("rejects any control character, not only CR/LF", () => {
    expect(parseMailto("mailto:u@x.com%00")).toBeNull();
    expect(parseMailto("mailto:u@x.com?subject=a%00b")).toBeNull();
    expect(parseMailto("mailto:u@x.com?subject=a%09b")).toBeNull();
    expect(parseMailto("mailto:u@x.com?body=a%7Fb")).toBeNull();
    expect(parseMailto("mailto:u@x.com?body=a%1Bb")).toBeNull();
  });

  it("rejects CR/LF injection", () => {
    expect(parseMailto("mailto:u@x.com?subject=hi%0D%0ABcc:%20evil@x.com")).toBeNull();
    expect(parseMailto("mailto:u@x.com%0D%0ABcc:evil@x.com")).toBeNull();
    expect(parseMailto("mailto:u@x.com?body=a%0Ab")).toBeNull();
  });

  it("rejects missing @ and malformed escapes", () => {
    expect(parseMailto("mailto:nobody")).toBeNull();
    expect(parseMailto("mailto:u@x.com?subject=%E0%A4%A")).toBeNull();
  });
});

describe("buildRfc822", () => {
  it("encodes non-ASCII subject as =?UTF-8?B?...?= and base64 body; lines joined by CRLF", () => {
    const raw = buildRfc822({ to: "u@x.com", subject: "Désabonner", body: "héllo" });
    const [head, body] = raw.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "To: u@x.com",
      `Subject: =?UTF-8?B?${Buffer.from("Désabonner", "utf8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(body).toBe(Buffer.from("héllo", "utf8").toString("base64"));
  });

  it("leaves ASCII subject as-is", () => {
    expect(buildRfc822({ to: "u@x.com", subject: "unsubscribe", body: "x" })).toContain("\r\nSubject: unsubscribe\r\n");
  });
});

describe("sendMailto", () => {
  it("sends via gmail.sendRaw", async () => {
    const gmail = new FakeGmailClient();
    const out = await sendMailto(gmail, "mailto:u@x.com?subject=bye");
    expect(out).toEqual({ ok: true, detail: "sent email to u@x.com" });
    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0]).toContain("To: u@x.com");
  });

  it("invalid mailto gives ok:false and nothing sent", async () => {
    const gmail = new FakeGmailClient();
    expect(await sendMailto(gmail, "mailto:u@x.com?subject=a%0D%0ABcc:evil@x.com")).toEqual({ ok: false, detail: "invalid mailto" });
    expect(gmail.sent).toHaveLength(0);
  });
});
