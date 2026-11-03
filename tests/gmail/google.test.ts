import type { gmail_v1 } from "@googleapis/gmail";
import { describe, expect, it, vi } from "vitest";
import { GoogleGmailClient } from "../../server/gmail/google";
import { AuthExpiredError, METADATA_HEADERS } from "../../server/gmail/types";

const noSleep = { sleep: async () => {}, random: () => 0 };

function stub() {
  const messages = {
    list: vi.fn(),
    get: vi.fn(),
    send: vi.fn().mockResolvedValue({ data: {} }),
    batchModify: vi.fn().mockResolvedValue({ data: {} }),
    trash: vi.fn().mockResolvedValue({ data: {} }),
  };
  const getProfile = vi.fn();
  const api = { users: { messages, getProfile } } as unknown as gmail_v1.Gmail;
  return { api, messages, getProfile, client: new GoogleGmailClient(api, { retry: noSleep }) };
}

describe("GoogleGmailClient", () => {
  it("getProfileEmail returns emailAddress", async () => {
    const s = stub();
    s.getProfile.mockResolvedValue({ data: { emailAddress: "me@example.com" } });
    await expect(s.client.getProfileEmail()).resolves.toBe("me@example.com");
    expect(s.getProfile).toHaveBeenCalledWith({ userId: "me" });
  });

  it("listMessageIds follows nextPageToken across 3 pages and concatenates ids", async () => {
    const s = stub();
    s.messages.list
      .mockResolvedValueOnce({ data: { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "t1" } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "c" }], nextPageToken: "t2" } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "d" }] } });
    await expect(s.client.listMessageIds("q")).resolves.toEqual(["a", "b", "c", "d"]);
    expect(s.messages.list).toHaveBeenCalledTimes(3);
    expect(s.messages.list).toHaveBeenNthCalledWith(1, { userId: "me", q: "q", maxResults: 500, pageToken: undefined });
    expect(s.messages.list).toHaveBeenNthCalledWith(3, { userId: "me", q: "q", maxResults: 500, pageToken: "t2" });
  });

  it("listMessageIds handles an empty result", async () => {
    const s = stub();
    s.messages.list.mockResolvedValue({ data: {} });
    await expect(s.client.listMessageIds("q")).resolves.toEqual([]);
  });

  it("getMessageMetadata requests format metadata with METADATA_HEADERS and lowercases header names, keeping repeated headers in order", async () => {
    const s = stub();
    s.messages.get.mockResolvedValue({
      data: {
        id: "m1",
        internalDate: "1700000000000",
        payload: {
          headers: [
            { name: "From", value: "A <a@x.com>" },
            { name: "DKIM-Signature", value: "first" },
            { name: "Subject", value: "Hi" },
            { name: "DKIM-Signature", value: "second" },
          ],
        },
      },
    });
    const meta = await s.client.getMessageMetadata("m1");
    expect(s.messages.get).toHaveBeenCalledWith({
      userId: "me",
      id: "m1",
      format: "metadata",
      metadataHeaders: [...METADATA_HEADERS],
    });
    expect(meta).toEqual({
      id: "m1",
      internalDate: 1700000000000,
      headers: { from: ["A <a@x.com>"], "dkim-signature": ["first", "second"], subject: ["Hi"] },
    });
  });

  it("sendRaw base64url-encodes (no +, /, or = padding)", async () => {
    const s = stub();
    const raw = "Subject: ÿþ?>>>\r\n\r\nbody~~";
    await s.client.sendRaw(raw);
    const sent = s.messages.send.mock.calls[0][0].requestBody.raw as string;
    expect(sent).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sent, "base64url").toString("utf8")).toBe(raw);
    expect(s.messages.send.mock.calls[0][0].userId).toBe("me");
  });

  it("archive chunks 2500 ids into 1000/1000/500 batchModify calls removing INBOX", async () => {
    const s = stub();
    const ids = Array.from({ length: 2500 }, (_, i) => `id${i}`);
    await s.client.archive(ids);
    const calls = s.messages.batchModify.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.requestBody.ids.length)).toEqual([1000, 1000, 500]);
    for (const c of calls) {
      expect(c.userId).toBe("me");
      expect(c.requestBody.removeLabelIds).toEqual(["INBOX"]);
    }
  });

  it("archive with no ids makes no calls", async () => {
    const s = stub();
    await s.client.archive([]);
    expect(s.messages.batchModify).not.toHaveBeenCalled();
  });

  it("trash calls messages.trash once per id", async () => {
    const s = stub();
    await s.client.trash(["a", "b", "c"]);
    expect(s.messages.trash.mock.calls.map((c) => c[0])).toEqual([
      { userId: "me", id: "a" },
      { userId: "me", id: "b" },
      { userId: "me", id: "c" },
    ]);
  });

  it("trash throws a summary error when some ids fail after retries", async () => {
    const s = stub();
    s.messages.trash.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "b") throw Object.assign(new Error("nope"), { status: 404 });
      return { data: {} };
    });
    await expect(s.client.trash(["a", "b", "c"])).rejects.toThrow(/1 of 3.*b/);
    expect(s.messages.trash).toHaveBeenCalledTimes(3);
  });

  it("the trash summary names at most 5 failed ids", async () => {
    const s = stub();
    s.messages.trash.mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }));
    const ids = Array.from({ length: 40 }, (_, i) => `id${i}`);
    await expect(s.client.trash(ids)).rejects.toThrow("Failed to trash 40 of 40 messages: id0, id1, id2, id3, id4 and 35 more");
  });

  it("trash stops sending requests after the first AuthExpiredError", async () => {
    const s = stub();
    const client = new GoogleGmailClient(s.api, { retry: noSleep, trashConcurrency: 1 });
    s.messages.trash.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "b") throw Object.assign(new Error("unauth"), { status: 401 });
      return { data: {} };
    });
    await expect(client.trash(["a", "b", "c", "d"])).rejects.toBeInstanceOf(AuthExpiredError);
    expect(s.messages.trash.mock.calls.map((c) => c[0].id)).toEqual(["a", "b"]);
  });

  it("invalid_grant from the API surfaces as AuthExpiredError", async () => {
    const s = stub();
    s.getProfile.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } }),
    );
    await expect(s.client.getProfileEmail()).rejects.toBeInstanceOf(AuthExpiredError);
    s.messages.get.mockRejectedValue(Object.assign(new Error("unauth"), { status: 401 }));
    await expect(s.client.getMessageMetadata("x")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(s.messages.get).toHaveBeenCalledTimes(1);
  });
});
