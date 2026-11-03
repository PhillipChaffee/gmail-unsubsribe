import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { Credentials } from "google-auth-library";
import { GMAIL_SCOPE, OAUTH_STATE_TTL_MS } from "../constants";
import type { TokenStore } from "../store/tokens";

export class InvalidStateError extends Error {}

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokens: TokenStore;
  now?: () => number;
  oauthClient?: OAuth2Client;
}

export class GoogleAuth {
  readonly client: OAuth2Client;
  private _authError: "expired" | undefined;
  private readonly tokens: TokenStore;
  private readonly now: () => number;
  private readonly states = new Map<string, number>();
  private listening = false;

  constructor(opts: GoogleAuthOptions) {
    this.tokens = opts.tokens;
    this.now = opts.now ?? Date.now;
    this.client =
      opts.oauthClient ?? new OAuth2Client({ clientId: opts.clientId, clientSecret: opts.clientSecret, redirectUri: opts.redirectUri });
  }

  get authError(): "expired" | undefined {
    return this._authError;
  }

  /** Loads persisted tokens into the client and persists refreshed tokens as the client emits them. */
  async init(): Promise<void> {
    const stored = await this.tokens.load();
    if (stored) this.client.setCredentials(stored);
    if (this.listening) return;
    this.listening = true;
    this.client.on("tokens", (t: Credentials) => {
      // TokenStore.save merges, so a refresh without refresh_token keeps the stored one.
      this.tokens.save(t).catch((err: unknown) => console.warn("Failed to persist refreshed tokens:", err));
    });
  }

  createAuthUrl(): string {
    this.pruneStates();
    const state = randomBytes(32).toString("hex");
    this.states.set(state, this.now() + OAUTH_STATE_TTL_MS);
    return this.client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GMAIL_SCOPE], state });
  }

  async handleCallback(code: string | undefined, state: string | undefined): Promise<void> {
    const expiresAt = state ? this.states.get(state) : undefined;
    if (state) this.states.delete(state); // single use, even when expired
    if (expiresAt === undefined || this.now() > expiresAt) throw new InvalidStateError("Invalid or expired OAuth state");
    if (!code) throw new InvalidStateError("Missing authorization code");
    const { tokens } = await this.client.getToken(code);
    this.client.setCredentials(tokens);
    await this.tokens.save(tokens);
    this._authError = undefined;
  }

  isSignedIn(): boolean {
    return Boolean(this.client.credentials.refresh_token);
  }

  async markExpired(): Promise<void> {
    await this.tokens.clear();
    this.client.setCredentials({});
    this._authError = "expired";
  }

  async logout(): Promise<void> {
    try {
      // Prefer the refresh token: it revokes the whole grant and, unlike the access token, never expires.
      const { refresh_token, access_token } = this.client.credentials;
      const token = refresh_token ?? access_token;
      if (token) await this.client.revokeToken(token);
    } catch {
      // best effort
    }
    await this.tokens.clear();
    this.client.setCredentials({});
    this._authError = undefined;
  }

  private pruneStates(): void {
    const t = this.now();
    for (const [s, exp] of this.states) if (t > exp) this.states.delete(s);
  }
}
