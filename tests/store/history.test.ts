import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryStore } from "../../server/store/history";
import type { HistoryEntry } from "../../shared/types";

let file: string;
beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), "history-test-")), "history.json");
});

const entry = (detail: string): HistoryEntry => ({ outcome: "unsubscribed", method: "one-click", at: 1, detail });

describe("HistoryStore", () => {
  it("set then reopen persists entry", async () => {
    const s = await HistoryStore.open(file);
    await s.set("a@x.com", entry("HTTP 200"));
    const r = await HistoryStore.open(file);
    expect(r.get("a@x.com")).toEqual(entry("HTTP 200"));
    expect(r.get("missing@x.com")).toBeUndefined();
  });

  it("20 concurrent set() calls for different senders all persist", async () => {
    const s = await HistoryStore.open(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.set(`s${i}@x.com`, entry(`d${i}`))));
    const r = await HistoryStore.open(file);
    expect(Object.keys(r.all()).length).toBe(20);
  });

  it("valid JSON of the wrong shape (null, an array, bad senders) opens empty instead of crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const text of ["null", "[]", '"x"', '{"version":1,"senders":null}', '{"version":1,"senders":[1]}']) {
      await writeFile(file, text);
      const s = await HistoryStore.open(file);
      expect(s.all(), text).toEqual({});
      await s.set("a@x.com", entry("x"));
      expect((await HistoryStore.open(file)).get("a@x.com")).toEqual(entry("x"));
    }
    warn.mockRestore();
  });

  it("clear empties store", async () => {
    const s = await HistoryStore.open(file);
    await s.set("a@x.com", entry("x"));
    await s.clear();
    expect(s.all()).toEqual({});
    expect(Object.keys((await HistoryStore.open(file)).all())).toHaveLength(0);
  });
});
