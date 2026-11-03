import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, storePaths } from "../server/config";

describe("loadConfig", () => {
  it("defaults port 3000, dataDir <cwd>/.data, not configured without creds", () => {
    const c = loadConfig({}, [], "/work");
    expect(c.port).toBe(3000);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dataDir).toBe(resolve("/work", ".data"));
    expect(c.configured).toBe(false);
    expect(c.demo).toBe(false);
    expect(c.prod).toBe(false);
  });
  it("configured with both creds", () => {
    const c = loadConfig({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }, [], "/work");
    expect(c.configured).toBe(true);
    expect(c.clientId).toBe("id");
    expect(loadConfig({ GOOGLE_CLIENT_ID: "id" }, [], "/work").configured).toBe(false);
  });
  it("--demo or FAKE_GMAIL=1 → demo and configured", () => {
    for (const c of [loadConfig({}, ["--demo"], "/w"), loadConfig({ FAKE_GMAIL: "1" }, [], "/w")]) {
      expect(c.demo).toBe(true);
      expect(c.configured).toBe(true);
    }
  });
  it("--prod sets prod", () => {
    expect(loadConfig({}, ["--prod"], "/w").prod).toBe(true);
  });
  it("an empty DATA_DIR falls back to .data instead of the working directory", () => {
    expect(loadConfig({ DATA_DIR: "" }, [], "/w").dataDir).toBe(resolve("/w", ".data"));
  });
  it("redirectUri uses PORT; DATA_DIR overrides", () => {
    const c = loadConfig({ PORT: "4567", DATA_DIR: "d" }, [], "/w");
    expect(c.port).toBe(4567);
    expect(c.redirectUri).toBe("http://127.0.0.1:4567/api/auth/callback");
    expect(c.dataDir).toBe(resolve("/w", "d"));
  });
});

describe("storePaths", () => {
  it("puts the stores in dataDir", () => {
    expect(storePaths(loadConfig({}, [], "/w"))).toEqual({ history: resolve("/w", ".data", "history.json"), tokens: resolve("/w", ".data", "tokens.json") });
  });
  it("demo mode uses a demo subdirectory, so the fake mailbox never touches the real history", () => {
    for (const c of [loadConfig({}, ["--demo"], "/w"), loadConfig({ FAKE_GMAIL: "1", DATA_DIR: "d" }, [], "/w")]) {
      expect(storePaths(c)).toEqual({ history: resolve(c.dataDir, "demo", "history.json"), tokens: resolve(c.dataDir, "demo", "tokens.json") });
    }
  });
});
