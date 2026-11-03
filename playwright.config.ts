import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "npx tsx server/index.ts --demo",
    env: { PORT: "3100", DATA_DIR: ".data-e2e" },
    url: "http://127.0.0.1:3100/api/status",
    reuseExistingServer: false,
  },
});
