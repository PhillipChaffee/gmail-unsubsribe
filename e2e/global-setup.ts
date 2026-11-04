import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Removes the E2E data dir (the webServer's DATA_DIR, relative to the repo root) left by earlier runs. */
export default async function globalSetup(): Promise<void> {
  await rm(fileURLToPath(new URL("../.data-e2e", import.meta.url)), { recursive: true, force: true });
}
