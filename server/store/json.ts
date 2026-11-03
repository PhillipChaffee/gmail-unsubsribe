import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Reads JSON; missing file gives fallback. Unparseable file is renamed aside and fallback returned. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const aside = `${path}.corrupt-${Date.now()}.json`;
    await rename(path, aside);
    console.warn(`Corrupt JSON in ${path}; moved to ${aside}`);
    return fallback;
  }
}

/** Writes to a temp file then renames, so a crash never leaves half-written JSON. */
export async function writeJsonAtomic(path: string, data: unknown, opts: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: opts.mode });
  await rename(tmp, path);
}
