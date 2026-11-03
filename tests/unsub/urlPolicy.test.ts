import { describe, expect, it } from "vitest";
import { checkOneClickUrl, isBlockedIp } from "../../server/unsub/urlPolicy";

const publicResolve = async () => ["93.184.216.34"];

describe("checkOneClickUrl", () => {
  it("allows public https host", async () => {
    expect(await checkOneClickUrl("https://example.com/unsub?x=1", { resolve: publicResolve })).toEqual({ ok: true });
  });

  it("rejects http", async () => {
    expect(await checkOneClickUrl("http://example.com/", { resolve: publicResolve })).toEqual({ ok: false, reason: "not https" });
  });

  it("rejects unparseable URLs", async () => {
    expect(await checkOneClickUrl("not a url", { resolve: publicResolve })).toEqual({ ok: false, reason: "invalid URL" });
  });

  it("rejects user:pass@", async () => {
    expect(await checkOneClickUrl("https://user:pass@example.com/", { resolve: publicResolve })).toEqual({
      ok: false,
      reason: "credentials in URL",
    });
  });

  it("rejects localhost and foo.localhost", async () => {
    for (const u of ["https://localhost/", "https://foo.localhost/"]) {
      expect(await checkOneClickUrl(u, { resolve: publicResolve })).toEqual({ ok: false, reason: "local host" });
    }
  });

  it("rejects private IP literals", async () => {
    const urls = [
      "https://127.0.0.1/",
      "https://10.1.2.3/",
      "https://[::1]/",
      "https://[fe80::1]/",
      "https://169.254.169.254/",
    ];
    for (const u of urls) {
      expect(await checkOneClickUrl(u, { resolve: publicResolve }), u).toEqual({ ok: false, reason: "private address" });
    }
  });

  it("rejects host resolving to 192.168.1.10", async () => {
    expect(await checkOneClickUrl("https://evil.example/", { resolve: async () => ["192.168.1.10"] })).toEqual({
      ok: false,
      reason: "private address",
    });
  });

  it("rejects host resolving to ::ffff:10.0.0.1", async () => {
    expect(await checkOneClickUrl("https://evil.example/", { resolve: async () => ["::ffff:10.0.0.1"] })).toEqual({
      ok: false,
      reason: "private address",
    });
  });

  it("rejects when any resolved address is blocked", async () => {
    expect(await checkOneClickUrl("https://evil.example/", { resolve: async () => ["93.184.216.34", "10.0.0.1"] })).toEqual({
      ok: false,
      reason: "private address",
    });
  });

  it("DNS failure gives reason DNS lookup failed", async () => {
    const resolve = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await checkOneClickUrl("https://nope.example/", { resolve })).toEqual({ ok: false, reason: "DNS lookup failed" });
  });

  it("allowPrefixes admits http://127.0.0.1:3100/__fake/", async () => {
    const r = await checkOneClickUrl("http://127.0.0.1:3100/__fake/unsub/1", { allowPrefixes: ["http://127.0.0.1:3100/__fake/"] });
    expect(r).toEqual({ ok: true });
    expect((await checkOneClickUrl("http://127.0.0.1:3100/other", { allowPrefixes: ["http://127.0.0.1:3100/__fake/"] })).ok).toBe(false);
  });
});

describe("isBlockedIp", () => {
  it("covers range edges", () => {
    for (const ip of ["0.1.2.3", "100.64.0.1", "172.16.0.1", "172.31.255.255", "224.0.0.1", "255.255.255.255", "::", "fc00::1", "fd12::1", "ff02::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});
