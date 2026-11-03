import type { HistoryEntry } from "../../shared/types";
import { readJson, writeJsonAtomic } from "./json";

interface HistoryFile {
  version: 1;
  senders: Record<string, HistoryEntry>;
}

/** Latest attempt per sender. In-memory map is the source of truth; writes are serialized. */
export class HistoryStore {
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private senders: Record<string, HistoryEntry>,
  ) {}

  static async open(filePath: string): Promise<HistoryStore> {
    const file = await readJson<HistoryFile>(filePath, { version: 1, senders: {} });
    return new HistoryStore(filePath, { ...(file.senders ?? {}) });
  }

  get(sender: string): HistoryEntry | undefined {
    return this.senders[sender];
  }

  all(): Record<string, HistoryEntry> {
    return { ...this.senders };
  }

  set(sender: string, entry: HistoryEntry): Promise<void> {
    this.senders[sender] = entry;
    return this.flush();
  }

  clear(): Promise<void> {
    this.senders = {};
    return this.flush();
  }

  private flush(): Promise<void> {
    const write = () => writeJsonAtomic(this.filePath, { version: 1, senders: this.senders } satisfies HistoryFile);
    const done = this.queue.then(write);
    this.queue = done.catch(() => {});
    return done;
  }
}
