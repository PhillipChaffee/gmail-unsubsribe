import { existsSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gmail as gmailApi } from "@googleapis/gmail";
import express from "express";
import { createApp, type AppDeps } from "./app";
import { GoogleAuth } from "./auth/google";
import { loadConfig } from "./config";
import { createDemoMailbox, demoBaseUrl, demoOneClick } from "./demo";
import { FakeGmailClient } from "./gmail/fake";
import { GoogleGmailClient } from "./gmail/google";
import type { GmailClient } from "./gmail/types";
import { JobRegistry } from "./jobs";
import { HistoryStore } from "./store/history";
import { TokenStore } from "./store/tokens";
import { postOneClick } from "./unsub/methods";
import { checkOneClickUrl } from "./unsub/urlPolicy";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

try {
  process.loadEnvFile();
} catch {
  // .env is optional
}
const config = loadConfig();
const history = await HistoryStore.open(join(config.dataDir, "history.json"));
const tokens = new TokenStore(join(config.dataDir, "tokens.json"));

type ModeDeps = Pick<AppDeps, "gmail" | "auth" | "checkUrl" | "postOneClick" | "demoReset">;

function demoDeps(): ModeDeps {
  const seed = () => createDemoMailbox({ now: Date.now(), fakeBaseUrl: demoBaseUrl(config.port) });
  const gmail = new FakeGmailClient({ messages: seed() });
  return { gmail, ...demoOneClick(config.port), demoReset: async () => gmail.reset(seed()) };
}

const notConfigured = async (): Promise<never> => {
  throw new Error("Google OAuth is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
};
const unconfiguredGmail: GmailClient = {
  getProfileEmail: notConfigured,
  listMessageIds: notConfigured,
  getMessageMetadata: notConfigured,
  sendRaw: notConfigured,
  archive: notConfigured,
  trash: notConfigured,
};

async function googleDeps(): Promise<ModeDeps> {
  const oneClick = { checkUrl: (url: string) => checkOneClickUrl(url), postOneClick: (url: string) => postOneClick(url) };
  const { clientId, clientSecret, redirectUri } = config;
  if (!clientId || !clientSecret) return { ...oneClick, gmail: unconfiguredGmail };
  const auth = new GoogleAuth({ clientId, clientSecret, redirectUri, tokens });
  await auth.init();
  return { ...oneClick, auth, gmail: new GoogleGmailClient(gmailApi({ version: "v1", auth: auth.client })) };
}

const app = createApp({ config, history, jobs: new JobRegistry(), ...(config.demo ? demoDeps() : await googleDeps()) });
const server = http.createServer(app);

if (config.prod) {
  const dist = join(ROOT, "dist");
  const indexHtml = join(dist, "index.html");
  if (!existsSync(indexHtml)) {
    console.error("Run npm run build first");
    process.exit(1);
  }
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") res.sendFile(indexHtml);
    else next();
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: join(ROOT, "vite.config.ts"),
    root: join(ROOT, "web"),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`Port ${config.port} is in use. Try PORT=${config.port + 1} npm run dev (and update the OAuth redirect URI).`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`Gmail Bulk Unsubscribe running at http://127.0.0.1:${config.port}${config.demo ? " (demo mode)" : ""}`);
});
