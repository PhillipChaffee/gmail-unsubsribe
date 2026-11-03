import { rm } from "node:fs/promises";
import type { Credentials } from "google-auth-library";
import { readJson, writeJsonAtomic } from "./json";

export class TokenStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<Credentials | null> {
    return readJson<Credentials | null>(this.filePath, null);
  }

  /** Merges into stored credentials so a refresh event without refresh_token keeps the old one. */
  save(c: Credentials): Promise<void> {
    return this.enqueue(async () => {
      const existing = (await this.load()) ?? {};
      await writeJsonAtomic(this.filePath, { ...existing, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v != null)) }, { mode: 0o600 });
    });
  }

  clear(): Promise<void> {
    return this.enqueue(() => rm(this.filePath, { force: true }));
  }

  /** Serializes load-merge-write cycles so overlapping saves cannot drop fields. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const done = this.queue.then(op);
    this.queue = done.catch(() => {});
    return done;
  }
}
