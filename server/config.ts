import { join, resolve } from "node:path";

export interface AppConfig {
  port: number;
  host: "127.0.0.1";
  clientId?: string;
  clientSecret?: string;
  demo: boolean;
  prod: boolean;
  dataDir: string;
  redirectUri: string;
  configured: boolean;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): AppConfig {
  const port = Number(env.PORT) || 3000;
  const demo = env.FAKE_GMAIL === "1" || argv.includes("--demo");
  const clientId = env.GOOGLE_CLIENT_ID || undefined;
  const clientSecret = env.GOOGLE_CLIENT_SECRET || undefined;
  return {
    port,
    host: "127.0.0.1",
    clientId,
    clientSecret,
    demo,
    prod: argv.includes("--prod"),
    // `||`, not `??`: an empty DATA_DIR= would otherwise put tokens.json in the (not git-ignored) working directory.
    dataDir: resolve(cwd, env.DATA_DIR || ".data"),
    redirectUri: `http://127.0.0.1:${port}/api/auth/callback`,
    configured: demo || (!!clientId && !!clientSecret),
  };
}

/**
 * Where the stores live. Demo mode gets its own subdirectory, so the fake mailbox never writes into
 * the real history.json and POST /__fake/reset can't wipe it.
 */
export function storePaths(config: Pick<AppConfig, "dataDir" | "demo">): { history: string; tokens: string } {
  const dir = config.demo ? join(config.dataDir, "demo") : config.dataDir;
  return { history: join(dir, "history.json"), tokens: join(dir, "tokens.json") };
}
