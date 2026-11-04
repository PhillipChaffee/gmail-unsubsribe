import type { gmail_v1 } from "@googleapis/gmail";
import { mapLimit } from "../util/pool";
import { isAuthError, withRetry, type RetryOptions } from "./retry";
import { AuthExpiredError, METADATA_HEADERS, type GmailClient, type MessageMeta } from "./types";

const ARCHIVE_CHUNK = 1000;
/** The trash error is shown in the results panel and polled every 500 ms: name a few ids, count the rest. */
const MAX_NAMED_IDS = 5;

export class GoogleGmailClient implements GmailClient {
  private readonly retry: RetryOptions | undefined;
  private readonly trashConcurrency: number;

  constructor(
    private readonly api: gmail_v1.Gmail,
    opts: { retry?: RetryOptions; trashConcurrency?: number } = {},
  ) {
    this.retry = opts.retry;
    this.trashConcurrency = opts.trashConcurrency ?? 8;
  }

  /** Runs one API call with retry; auth failures become AuthExpiredError. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(fn, this.retry);
    } catch (err) {
      if (isAuthError(err)) throw new AuthExpiredError();
      throw err;
    }
  }

  async getProfileEmail(): Promise<string> {
    const { data } = await this.call(() => this.api.users.getProfile({ userId: "me" }));
    if (!data.emailAddress) throw new Error("Gmail profile has no emailAddress");
    return data.emailAddress;
  }

  async listMessageIds(query: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const token = pageToken;
      const { data } = await this.call(() =>
        this.api.users.messages.list({ userId: "me", q: query, maxResults: 500, pageToken: token }),
      );
      for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }

  async getMessageMetadata(id: string): Promise<MessageMeta> {
    const { data } = await this.call(() =>
      this.api.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: [...METADATA_HEADERS] }),
    );
    const headers: Record<string, string[]> = {};
    for (const h of data.payload?.headers ?? []) {
      if (!h.name) continue;
      (headers[h.name.toLowerCase()] ??= []).push(h.value ?? "");
    }
    return { id: data.id ?? id, internalDate: Number(data.internalDate), headers };
  }

  async sendRaw(rfc822: string): Promise<void> {
    const raw = Buffer.from(rfc822, "utf8").toString("base64url");
    await this.call(() => this.api.users.messages.send({ userId: "me", requestBody: { raw } }));
  }

  async archive(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += ARCHIVE_CHUNK) {
      const chunk = ids.slice(i, i + ARCHIVE_CHUNK);
      await this.call(() =>
        this.api.users.messages.batchModify({ userId: "me", requestBody: { ids: chunk, removeLabelIds: ["INBOX"] } }),
      );
    }
  }

  async trash(ids: string[]): Promise<void> {
    let authError: AuthExpiredError | undefined;
    const results = await mapLimit(ids, this.trashConcurrency, async (id) => {
      // After an auth failure every further request (and its token refresh) would fail too.
      if (authError) throw authError;
      try {
        return await this.call(() => this.api.users.messages.trash({ userId: "me", id }));
      } catch (err) {
        if (err instanceof AuthExpiredError) authError ??= err;
        throw err;
      }
    });
    if (authError) throw authError;
    const failed = ids.filter((_id, i) => results[i]!.status === "rejected");
    if (failed.length > 0) {
      const more = failed.length > MAX_NAMED_IDS ? ` and ${failed.length - MAX_NAMED_IDS} more` : "";
      throw new Error(`Failed to trash ${failed.length} of ${ids.length} messages: ${failed.slice(0, MAX_NAMED_IDS).join(", ")}${more}`);
    }
  }
}
