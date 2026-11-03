import type { Method, UnsubTargets } from "../../shared/types.js";
import type { MessageMeta } from "../gmail/types.js";

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

function decodeWord(charset: string, enc: string, text: string): string {
  let bytes: Buffer;
  if (enc.toUpperCase() === "B") {
    bytes = Buffer.from(text, "base64");
  } else {
    const arr: number[] = [];
    const t = text.replace(/_/g, " ");
    for (let i = 0; i < t.length; i++) {
      const hex = t.slice(i + 1, i + 3);
      if (t[i] === "=" && /^[0-9a-fA-F]{2}$/.test(hex)) {
        arr.push(parseInt(hex, 16));
        i += 2;
      } else {
        arr.push(...Buffer.from(t[i]!, "utf8"));
      }
    }
    bytes = Buffer.from(arr);
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** Decodes RFC 2047 encoded words; text without encoded words is returned unchanged. */
export function decodeRfc2047(s: string): string {
  const joined = s.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, "$1");
  return joined.replace(ENCODED_WORD, (_m, cs: string, enc: string, text: string) => decodeWord(cs, enc, text));
}

const BARE_ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+$/;

export function parseFrom(raw: string | undefined): { name: string; address: string } | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  const angle = /^(.*)<([^<>]*)>\s*$/.exec(s);
  let name: string;
  let address: string;
  if (angle) {
    name = angle[1]!.trim();
    address = angle[2]!.trim();
  } else {
    name = "";
    address = s;
  }
  if (!BARE_ADDRESS.test(address)) return null;
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return { name: decodeRfc2047(name).trim(), address: address.toLowerCase() };
}

export function parseListUnsubscribe(raw: string | undefined): { httpsUrl?: string; webUrl?: string; mailto?: string } {
  if (!raw) return {};
  const bracketed = [...raw.matchAll(/<([^<>]*)>/g)].map((m) => m[1]!);
  const items = bracketed.length > 0 ? bracketed : raw.split(",");
  let httpsUrl: string | undefined;
  let httpUrl: string | undefined;
  let mailto: string | undefined;
  for (const item of items) {
    const uri = item.replace(/\s+/g, "");
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri)?.[1]?.toLowerCase();
    if (scheme === "https") httpsUrl ??= uri;
    else if (scheme === "http") httpUrl ??= uri;
    else if (scheme === "mailto") mailto ??= uri;
  }
  const out: { httpsUrl?: string; webUrl?: string; mailto?: string } = {};
  if (httpsUrl) out.httpsUrl = httpsUrl;
  const webUrl = httpsUrl ?? httpUrl;
  if (webUrl) out.webUrl = webUrl;
  if (mailto) out.mailto = mailto;
  return out;
}

export function isOneClickPost(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim().toLowerCase() === "list-unsubscribe=one-click";
}

const TRUSTED_AUTHSERV_ID = "mx.google.com";

function passingDkimDomains(authResults: string[]): string[] {
  const domains: string[] = [];
  for (const value of authResults) {
    const [authservId, ...segments] = value.split(";");
    if (authservId!.trim().toLowerCase() !== TRUSTED_AUTHSERV_ID) continue;
    for (const seg of segments) {
      const t = seg.trim().toLowerCase();
      if (!t.startsWith("dkim=pass")) continue;
      for (const m of t.matchAll(/header\.[id]=(?:[^\s;@]*@)?([^\s;@]+)/g)) domains.push(m[1]!);
    }
  }
  return domains;
}

function parseDkimSignature(sig: string): { d: string; h: string[] } | null {
  let d: string | undefined;
  let h: string[] | undefined;
  for (const part of sig.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const tag = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).replace(/\s+/g, "");
    if (tag === "d") d = value.toLowerCase();
    else if (tag === "h") h = value.toLowerCase().split(":");
  }
  return d && h ? { d, h } : null;
}

export function dkimCoversListUnsubscribe(dkimSignatures: string[], authResults: string[]): boolean {
  const passing = passingDkimDomains(authResults);
  if (passing.length === 0) return false;
  return dkimSignatures.some((raw) => {
    const sig = parseDkimSignature(raw);
    if (!sig || !sig.h.includes("list-unsubscribe") || !sig.h.includes("list-unsubscribe-post")) return false;
    return passing.some((p) => p === sig.d || p.endsWith("." + sig.d));
  });
}

export interface AnalyzedMessage {
  id: string;
  internalDate: number;
  sender: string;
  name: string;
  subject: string;
  method: Method;
  targets: UnsubTargets;
}

export function analyzeMessage(meta: MessageMeta): AnalyzedMessage | null {
  const h = meta.headers;
  const from = parseFrom(h["from"]?.[0]);
  if (!from) return null;
  const parsed = parseListUnsubscribe(h["list-unsubscribe"]?.join(","));
  if (!parsed.webUrl && !parsed.mailto) return null;

  const eligible =
    isOneClickPost(h["list-unsubscribe-post"]?.[0]) &&
    parsed.httpsUrl !== undefined &&
    dkimCoversListUnsubscribe(h["dkim-signature"] ?? [], h["authentication-results"] ?? []);

  const targets: UnsubTargets = {};
  if (eligible && parsed.httpsUrl) targets.oneClickUrl = parsed.httpsUrl;
  if (parsed.mailto) targets.mailto = parsed.mailto;
  if (parsed.webUrl) targets.webUrl = parsed.webUrl;

  const method: Method = eligible ? "one-click" : parsed.mailto ? "mailto" : "manual";
  return {
    id: meta.id,
    internalDate: meta.internalDate,
    sender: from.address,
    name: from.name,
    subject: decodeRfc2047((h["subject"]?.[0] ?? "").replace(/\s+/g, " ").trim()),
    method,
    targets,
  };
}
