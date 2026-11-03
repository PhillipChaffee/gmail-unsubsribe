import { rm } from "node:fs/promises";
import type { Credentials } from "google-auth-library";
import { readJson, writeJsonAtomic } from "./json";

export class TokenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Credentials | null> {
    return readJson<Credentials | null>(this.filePath, null);
  }

  /** Merges into stored credentials so a refresh event without refresh_token keeps the old one. */
  async save(c: Credentials): Promise<void> {
    const existing = (await this.load()) ?? {};
    await writeJsonAtomic(this.filePath, { ...existing, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v != null)) }, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
