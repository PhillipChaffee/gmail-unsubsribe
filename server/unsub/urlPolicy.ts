import dns from "node:dns/promises";
import net from "node:net";

export type Resolver = (host: string) => Promise<string[]>;
export type UrlCheck = { ok: true } | { ok: false; reason: string };
export interface UrlPolicyOptions {
  resolve?: Resolver;
  allowPrefixes?: string[];
}

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["255.255.255.255", 32],
] as const) {
  blocked.addSubnet(net4, prefix, "ipv4");
}
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
for (const [net6, prefix] of [
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net6, prefix, "ipv6");
}

const MAPPED_DOTTED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** True for addresses that must never be fetched. Unparseable input is treated as blocked. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const dotted = MAPPED_DOTTED.exec(bare);
  if (dotted) return isBlockedIp(dotted[1]);
  const hex = MAPPED_HEX.exec(bare);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const family = net.isIP(bare);
  if (family === 0) return true;
  return blocked.check(bare, family === 4 ? "ipv4" : "ipv6");
}

const defaultResolve: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

export async function checkOneClickUrl(url: string, opts: UrlPolicyOptions = {}): Promise<UrlCheck> {
  if (opts.allowPrefixes?.some((p) => url.startsWith(p))) return { ok: true };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "not https" };
  if (u.username || u.password) return { ok: false, reason: "credentials in URL" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, reason: "local host" };
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (net.isIP(bare) !== 0) {
    return isBlockedIp(bare) ? { ok: false, reason: "private address" } : { ok: true };
  }
  let addrs: string[];
  try {
    addrs = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    return { ok: false, reason: "DNS lookup failed" };
  }
  if (addrs.length === 0) return { ok: false, reason: "DNS lookup failed" };
  if (addrs.some(isBlockedIp)) return { ok: false, reason: "private address" };
  return { ok: true };
}
