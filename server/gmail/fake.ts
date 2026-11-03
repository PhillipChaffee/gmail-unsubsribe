import { SCAN_QUERY } from "../constants";
import type { GmailClient, MessageMeta } from "./types";

const DAY_MS = 86_400_000;

export interface FakeMessage {
  id: string;
  internalDate: number;
  headers: Record<string, string[]>;
  labels: string[];
  mentionsUnsubscribe: boolean;
}

export interface FakeMessageSpec {
  id: string;
  from: string;
  subject?: string;
  daysAgo: number;
  listUnsubscribe?: string;
  oneClick?: boolean;
  dkim?: "pass" | "fail" | "none";
  labels?: string[];
  mentionsUnsubscribe?: boolean;
}

/** Small local angle-addr parser (kept independent of the scan module). */
function addressOf(from: string): string {
  const m = /<([^<>]*)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

export function fakeMessage(spec: FakeMessageSpec, now: number): FakeMessage {
  const domain = addressOf(spec.from).split("@")[1] ?? "example.com";
  const subject = spec.subject ?? `Newsletter ${spec.id}`;
  const dkim = spec.dkim ?? "pass";
  const headers: Record<string, string[]> = {
    from: [spec.from],
    subject: [subject],
    "list-unsubscribe": [spec.listUnsubscribe ?? `<https://unsub.${domain}/u/${spec.id}>, <mailto:unsub@${domain}>`],
  };
  if (spec.oneClick ?? true) headers["list-unsubscribe-post"] = ["List-Unsubscribe=One-Click"];
  if (dkim !== "none") {
    headers["dkim-signature"] = [
      `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=default; h=from:subject:list-unsubscribe:list-unsubscribe-post; bh=ZmFrZQ==; b=ZmFrZQ==`,
    ];
    headers["authentication-results"] = [`mx.google.com; dkim=${dkim} header.i=@${domain} header.s=default; spf=pass smtp.mailfrom=${domain}`];
  }
  return {
    id: spec.id,
    internalDate: now - spec.daysAgo * DAY_MS,
    headers,
    labels: spec.labels ?? ["INBOX"],
    mentionsUnsubscribe: spec.mentionsUnsubscribe ?? true,
  };
}

export class FakeGmailClient implements GmailClient {
  readonly messages = new Map<string, FakeMessage>();
  readonly sent: string[] = [];
  readonly failMetadataFor = new Set<string>();
  failNext?: { method: keyof GmailClient; error: Error };

  private readonly email: string;
  private readonly now: () => number;

  constructor(opts: { email?: string; messages?: FakeMessage[]; now?: () => number } = {}) {
    this.email = opts.email ?? "demo@example.com";
    this.now = opts.now ?? Date.now;
    this.reset(opts.messages ?? []);
  }

  reset(messages: FakeMessage[]): void {
    this.messages.clear();
    for (const m of messages) this.messages.set(m.id, structuredClone(m));
  }

  private maybeFail(method: keyof GmailClient): void {
    if (this.failNext?.method === method) {
      const { error } = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }

  async getProfileEmail(): Promise<string> {
    this.maybeFail("getProfileEmail");
    return this.email;
  }

  async listMessageIds(query: string): Promise<string[]> {
    this.maybeFail("listMessageIds");
    const live = [...this.messages.values()].filter((m) => !m.labels.includes("SPAM") && !m.labels.includes("TRASH"));
    let matched: FakeMessage[];
    const fromMatch = /^from:\((.*)\)$/.exec(query);
    if (query === SCAN_QUERY) {
      const cutoff = this.now() - 30 * DAY_MS;
      matched = live.filter((m) => m.mentionsUnsubscribe && m.internalDate >= cutoff);
    } else if (fromMatch) {
      const addr = fromMatch[1].trim().toLowerCase();
      matched = live.filter((m) => addressOf(m.headers["from"]?.[0] ?? "") === addr);
    } else {
      throw new Error(`FakeGmailClient: unsupported query "${query}"`);
    }
    return matched.sort((a, b) => b.internalDate - a.internalDate).map((m) => m.id);
  }

  async getMessageMetadata(id: string): Promise<MessageMeta> {
    this.maybeFail("getMessageMetadata");
    const m = this.messages.get(id);
    if (!m || this.failMetadataFor.has(id)) throw new Error(`FakeGmailClient: cannot read message ${id}`);
    return { id: m.id, internalDate: m.internalDate, headers: structuredClone(m.headers) };
  }

  async sendRaw(rfc822: string): Promise<void> {
    this.maybeFail("sendRaw");
    this.sent.push(rfc822);
  }

  async archive(ids: string[]): Promise<void> {
    this.maybeFail("archive");
    for (const id of ids) {
      const m = this.messages.get(id);
      if (m) m.labels = m.labels.filter((l) => l !== "INBOX");
    }
  }

  async trash(ids: string[]): Promise<void> {
    this.maybeFail("trash");
    for (const id of ids) {
      const m = this.messages.get(id);
      if (m && !m.labels.includes("TRASH")) m.labels.push("TRASH");
    }
  }
}
