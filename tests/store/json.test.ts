import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readJson, writeJsonAtomic } from "../../server/store/json";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "json-test-"));
});

describe("json store", () => {
  it("readJson returns fallback when file missing", async () => {
    expect(await readJson(join(dir, "nope.json"), { a: 1 })).toEqual({ a: 1 });
  });

  it("writeJsonAtomic then readJson round-trips and creates parent dirs", async () => {
    const p = join(dir, "a", "b", "x.json");
    await writeJsonAtomic(p, { hello: "world", n: [1, 2] });
    expect(await readJson(p, null)).toEqual({ hello: "world", n: [1, 2] });
  });

  it("writeJsonAtomic applies mode 0o600", async () => {
    const p = join(dir, "x.json");
    await writeJsonAtomic(p, {}, { mode: 0o600 });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });

  it("readJson on invalid JSON returns fallback and renames file to <path>.corrupt-<ts>.json", async () => {
    const p = join(dir, "bad.json");
    await writeFile(p, "{not json");
    expect(await readJson(p, { ok: true })).toEqual({ ok: true });
    const files = await readdir(dir);
    expect(files).not.toContain("bad.json");
    const corrupt = files.find((f) => f.startsWith("bad.json.corrupt-") && f.endsWith(".json"));
    expect(corrupt).toBeDefined();
    expect(await readFile(join(dir, corrupt!), "utf8")).toBe("{not json");
  });

  it("no .tmp files are left behind after write", async () => {
    const p = join(dir, "x.json");
    await Promise.all([1, 2, 3].map((n) => writeJsonAtomic(p, { n })));
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
