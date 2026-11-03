import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuth, InvalidStateError } from "../../server/auth/google";
import { GMAIL_SCOPE, OAUTH_STATE_TTL_MS } from "../../server/constants";
import { TokenStore } from "../../server/store/tokens";

const REDIRECT = "http://127.0.0.1:3000/api/auth/callback";
let tokens: TokenStore;
let client: OAuth2Client;
let now: number;
let auth: GoogleAuth;
let getToken: ReturnType<typeof vi.spyOn>;

function make(): GoogleAuth {
  return new GoogleAuth({ clientId: "id", clientSecret: "secret", redirectUri: REDIRECT, tokens, now: () => now, oauthClient: client });
}
function stateOf(url: string): string {
  return new URL(url).searchParams.get("state")!;
}

beforeEach(async () => {
  tokens = new TokenStore(join(await mkdtemp(join(tmpdir(), "auth-test-")), "tokens.json"));
  client = new OAuth2Client({ clientId: "id", clientSecret: "secret", redirectUri: REDIRECT });
  now = 1_000_000;
  getToken = vi.spyOn(client, "getToken").mockResolvedValue({ tokens: { access_token: "a1", refresh_token: "r1" }, res: null } as never);
  vi.spyOn(client, "revokeCredentials").mockResolvedValue({} as never);
  auth = make();
});

describe("GoogleAuth", () => {
  it("createAuthUrl includes gmail.modify scope, access_type=offline, prompt=consent, redirect_uri, and a 64-hex state", () => {
    const p = new URL(auth.createAuthUrl()).searchParams;
    expect(p.get("scope")).toBe(GMAIL_SCOPE);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handleCallback with valid state stores tokens and isSignedIn() becomes true", async () => {
    expect(auth.isSignedIn()).toBe(false);
    await auth.handleCallback("code1", stateOf(auth.createAuthUrl()));
    expect(getToken).toHaveBeenCalledWith("code1");
    expect(auth.isSignedIn()).toBe(true);
    expect(await tokens.load()).toMatchObject({ access_token: "a1", refresh_token: "r1" });
  });

  it("handleCallback clears authError", async () => {
    await auth.markExpired();
    await auth.handleCallback("c", stateOf(auth.createAuthUrl()));
    expect(auth.authError).toBeUndefined();
  });

  it("state is single-use", async () => {
    const state = stateOf(auth.createAuthUrl());
    await auth.handleCallback("c", state);
    await expect(auth.handleCallback("c", state)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("unknown or missing state → InvalidStateError", async () => {
    await expect(auth.handleCallback("c", "nope")).rejects.toBeInstanceOf(InvalidStateError);
    await expect(auth.handleCallback("c", undefined)).rejects.toBeInstanceOf(InvalidStateError);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("expired state (now + 10min + 1ms) → InvalidStateError", async () => {
    const state = stateOf(auth.createAuthUrl());
    now += OAUTH_STATE_TTL_MS + 1;
    await expect(auth.handleCallback("c", state)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("state exactly at TTL is still valid", async () => {
    const state = stateOf(auth.createAuthUrl());
    now += OAUTH_STATE_TTL_MS;
    await expect(auth.handleCallback("c", state)).resolves.toBeUndefined();
  });

  it("missing code → InvalidStateError", async () => {
    await expect(auth.handleCallback(undefined, stateOf(auth.createAuthUrl()))).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("init loads persisted tokens (isSignedIn true after restart)", async () => {
    await tokens.save({ access_token: "a", refresh_token: "r" });
    const restarted = new GoogleAuth({ clientId: "id", clientSecret: "s", redirectUri: REDIRECT, tokens });
    expect(restarted.isSignedIn()).toBe(false);
    await restarted.init();
    expect(restarted.isSignedIn()).toBe(true);
  });

  it('"tokens" event without refresh_token persists access_token and keeps refresh_token', async () => {
    await auth.handleCallback("c", stateOf(auth.createAuthUrl()));
    await auth.init();
    client.emit("tokens", { access_token: "a2", expiry_date: 123 });
    await vi.waitFor(async () => expect(await tokens.load()).toMatchObject({ access_token: "a2", refresh_token: "r1" }));
    expect(auth.isSignedIn()).toBe(true);
  });

  it("markExpired clears tokens and sets authError \"expired\"", async () => {
    await auth.handleCallback("c", stateOf(auth.createAuthUrl()));
    await auth.markExpired();
    expect(await tokens.load()).toBeNull();
    expect(auth.isSignedIn()).toBe(false);
    expect(auth.authError).toBe("expired");
  });

  it("logout swallows revoke errors and clears tokens", async () => {
    await auth.handleCallback("c", stateOf(auth.createAuthUrl()));
    vi.spyOn(client, "revokeCredentials").mockRejectedValue(new Error("network"));
    await expect(auth.logout()).resolves.toBeUndefined();
    expect(await tokens.load()).toBeNull();
    expect(auth.isSignedIn()).toBe(false);
    expect(auth.authError).toBeUndefined();
  });
});
