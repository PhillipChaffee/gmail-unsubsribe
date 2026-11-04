import { describe, expect, it } from "vitest";
import {
  analyzeMessage,
  decodeRfc2047,
  dkimCoversListUnsubscribe,
  isOneClickPost,
  parseFrom,
  parseListUnsubscribe,
} from "../../server/scan/headers.js";
import type { MessageMeta } from "../../server/gmail/types.js";

describe("decodeRfc2047", () => {
  it("decodes B words", () => {
    expect(decodeRfc2047("=?UTF-8?B?QWNtZSDinKg=?=")).toBe("Acme ✨");
  });
  it("decodes Q words", () => {
    expect(decodeRfc2047("=?utf-8?Q?Caf=C3=A9_News?=")).toBe("Café News");
  });
  it("joins adjacent encoded words without the space", () => {
    expect(decodeRfc2047("=?UTF-8?Q?Caf?= =?UTF-8?Q?=C3=A9?=")).toBe("Café");
  });
  it("keeps whitespace between an encoded word and plain text", () => {
    expect(decodeRfc2047("=?UTF-8?Q?Caf=C3=A9?= News")).toBe("Café News");
  });
  it("returns plain text unchanged", () => {
    expect(decodeRfc2047("Hello World")).toBe("Hello World");
  });
});

describe("parseFrom", () => {
  it("parses name and address, lowercasing the address", () => {
    expect(parseFrom("Acme Deals <Deals@Acme.com>")).toEqual({ name: "Acme Deals", address: "deals@acme.com" });
  });
  it("handles quoted names with commas", () => {
    expect(parseFrom('"Doe, Jane" <jane@x.io>')).toEqual({ name: "Doe, Jane", address: "jane@x.io" });
  });
  it("handles a bare address", () => {
    expect(parseFrom("news@x.io")).toEqual({ name: "", address: "news@x.io" });
  });
  it("decodes encoded names", () => {
    expect(parseFrom("=?UTF-8?B?QWNtZSDinKg=?= <a@b.co>")).toEqual({ name: "Acme ✨", address: "a@b.co" });
  });
  it("returns null for undefined or garbage", () => {
    expect(parseFrom(undefined)).toBeNull();
    expect(parseFrom("not an address")).toBeNull();
  });
});

describe("parseListUnsubscribe", () => {
  it("extracts https and mailto", () => {
    expect(parseListUnsubscribe("<mailto:u@x.com?subject=unsub>, <https://x.com/u?id=1>")).toEqual({
      httpsUrl: "https://x.com/u?id=1",
      webUrl: "https://x.com/u?id=1",
      mailto: "mailto:u@x.com?subject=unsub",
    });
  });
  it("handles folded values", () => {
    expect(parseListUnsubscribe("<https://a.com/u>,\r\n <mailto:b@a.com>")).toEqual({
      httpsUrl: "https://a.com/u",
      webUrl: "https://a.com/u",
      mailto: "mailto:b@a.com",
    });
  });
  it("accepts a URI without angle brackets", () => {
    expect(parseListUnsubscribe("https://a.com/u").httpsUrl).toBe("https://a.com/u");
  });
  it("treats http as a web link only", () => {
    const r = parseListUnsubscribe("<http://a.com/u>");
    expect(r.webUrl).toBe("http://a.com/u");
    expect(r.httpsUrl).toBeUndefined();
  });
  it("prefers https for webUrl", () => {
    expect(parseListUnsubscribe("<http://a.com/1>, <https://a.com/2>").webUrl).toBe("https://a.com/2");
  });
  it("skips a mailto the unsubscribe step would refuse and keeps the first sendable one", () => {
    expect(parseListUnsubscribe("<mailto:a@x.com,boss@victim.com>, <mailto:ok@x.com?subject=u>")).toEqual({
      mailto: "mailto:ok@x.com?subject=u",
    });
    expect(parseListUnsubscribe("<mailto:a@x.com%0D%0ABcc:z@y.com>, <https://x.com/u>")).toEqual({
      httpsUrl: "https://x.com/u",
      webUrl: "https://x.com/u",
    });
    expect(parseListUnsubscribe("<mailto:not-an-address>")).toEqual({});
  });
  it("ignores other schemes and garbage", () => {
    expect(parseListUnsubscribe("<ftp://x>")).toEqual({});
    expect(parseListUnsubscribe("garbage")).toEqual({});
    expect(parseListUnsubscribe(undefined)).toEqual({});
  });
});

describe("isOneClickPost", () => {
  it("matches trimmed, case-insensitive", () => {
    expect(isOneClickPost("List-Unsubscribe=One-Click")).toBe(true);
    expect(isOneClickPost(" list-unsubscribe=one-click ")).toBe(true);
  });
  it("rejects others", () => {
    expect(isOneClickPost(undefined)).toBe(false);
    expect(isOneClickPost("List-Unsubscribe=Other")).toBe(false);
  });
});

const sig =
  "v=1; a=rsa-sha256; d=news.example.com; s=s1;\r\n h=from:to:subject:list-unsubscribe:list-unsubscribe-post; bh=x; b=y";
const ar =
  "mx.google.com;\r\n dkim=pass header.i=@news.example.com header.s=s1 header.b=abc;\r\n spf=pass smtp.mailfrom=x";

describe("dkimCoversListUnsubscribe", () => {
  it("passes for matching signature and result", () => {
    expect(dkimCoversListUnsubscribe([sig], [ar])).toBe(true);
  });
  it("accepts a subdomain of d", () => {
    expect(dkimCoversListUnsubscribe([sig], [ar.replace("@news.example.com", "@mail.news.example.com")])).toBe(true);
  });
  it("accepts header.d", () => {
    expect(dkimCoversListUnsubscribe([sig], ["mx.google.com; dkim=pass header.d=news.example.com"])).toBe(true);
  });
  it("rejects dkim=fail", () => {
    expect(dkimCoversListUnsubscribe([sig], [ar.replace("dkim=pass", "dkim=fail")])).toBe(false);
  });
  it("rejects h= without list-unsubscribe-post", () => {
    expect(dkimCoversListUnsubscribe([sig.replace(":list-unsubscribe-post", "")], [ar])).toBe(false);
  });
  it("rejects a foreign authserv-id", () => {
    expect(dkimCoversListUnsubscribe([sig], [ar.replace("mx.google.com", "evil.com")])).toBe(false);
  });
  it("rejects d= mismatch", () => {
    expect(dkimCoversListUnsubscribe([sig.replace("d=news.example.com", "d=other.com")], [ar])).toBe(false);
  });
  it("rejects a lookalike suffix", () => {
    expect(dkimCoversListUnsubscribe([sig], [ar.replace("@news.example.com", "@evilnews.example.com")])).toBe(false);
  });
  it("rejects empty inputs", () => {
    expect(dkimCoversListUnsubscribe([], [])).toBe(false);
    expect(dkimCoversListUnsubscribe([sig], [])).toBe(false);
    expect(dkimCoversListUnsubscribe([], [ar])).toBe(false);
  });
});

function meta(headers: Record<string, string[]>): MessageMeta {
  return { id: "m1", internalDate: 1000, headers };
}
const base = {
  from: ["Acme <News@Acme.com>"],
  subject: ["=?UTF-8?Q?Caf=C3=A9?= deals"],
};

describe("analyzeMessage", () => {
  const oneClick = {
    ...base,
    "list-unsubscribe": ["<https://acme.com/u?id=1>, <mailto:u@acme.com>"],
    "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    "dkim-signature": [sig],
    "authentication-results": [ar],
  };
  it("selects one-click when eligible", () => {
    expect(analyzeMessage(meta(oneClick))).toEqual({
      id: "m1",
      internalDate: 1000,
      sender: "news@acme.com",
      name: "Acme",
      subject: "Café deals",
      method: "one-click",
      targets: { oneClickUrl: "https://acme.com/u?id=1", mailto: "mailto:u@acme.com", webUrl: "https://acme.com/u?id=1" },
    });
  });
  it("falls back to mailto when DKIM fails", () => {
    const r = analyzeMessage(meta({ ...oneClick, "authentication-results": [ar.replace("dkim=pass", "dkim=fail")] }));
    expect(r?.method).toBe("mailto");
    expect(r?.targets.oneClickUrl).toBeUndefined();
    expect(r?.targets.webUrl).toBe("https://acme.com/u?id=1");
  });
  it("is manual for http-only", () => {
    expect(analyzeMessage(meta({ ...base, "list-unsubscribe": ["<http://acme.com/u>"] }))?.method).toBe("manual");
    // A recipient-list mailto can't be sent, so the row must not promise "by email".
    expect(analyzeMessage(meta({ ...base, "list-unsubscribe": ["<mailto:a@acme.com,b@other.com>, <http://acme.com/u>"] }))?.method).toBe("manual");
  });
  it("returns null without List-Unsubscribe", () => {
    expect(analyzeMessage(meta(base))).toBeNull();
  });
  it("returns null without From", () => {
    expect(analyzeMessage(meta({ "list-unsubscribe": ["<https://a.com/u>"] }))).toBeNull();
  });
  it("returns null when no usable target", () => {
    expect(analyzeMessage(meta({ ...base, "list-unsubscribe": ["<ftp://x>"] }))).toBeNull();
  });
  it("joins multiple list-unsubscribe values", () => {
    const r = analyzeMessage(meta({ ...base, "list-unsubscribe": ["<mailto:a@b.com>", "<https://b.com/u>"] }));
    expect(r?.targets).toEqual({ mailto: "mailto:a@b.com", webUrl: "https://b.com/u" });
  });
});
