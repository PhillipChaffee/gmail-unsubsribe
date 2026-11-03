import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TokenStore } from "../../server/store/tokens";

let file: string;
beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), "tokens-test-")), "tokens.json");
});

describe("TokenStore", () => {
  it("load returns null when missing", async () => {
    expect(await new TokenStore(file).load()).toBeNull();
  });

  it("save merges with existing so refresh_token survives a save without it", async () => {
    const s = new TokenStore(file);
    await s.save({ access_token: "a", refresh_token: "r" });
    await s.save({ access_token: "b" });
    expect(await s.load()).toEqual({ access_token: "b", refresh_token: "r" });
  });

  it("file mode is 0600", async () => {
    const s = new TokenStore(file);
    await s.save({ access_token: "a" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("clear removes file and load returns null", async () => {
    const s = new TokenStore(file);
    await s.save({ access_token: "a" });
    await s.clear();
    await expect(stat(file)).rejects.toThrow();
    expect(await s.load()).toBeNull();
  });
});
