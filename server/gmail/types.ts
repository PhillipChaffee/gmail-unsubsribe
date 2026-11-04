export interface MessageMeta {
  id: string;
  internalDate: number;
  /** Header names are lowercased. */
  headers: Record<string, string[]>;
}

export interface GmailClient {
  getProfileEmail(): Promise<string>;
  /** All pages. */
  listMessageIds(query: string): Promise<string[]>;
  getMessageMetadata(id: string): Promise<MessageMeta>;
  sendRaw(rfc822: string): Promise<void>;
  archive(ids: string[]): Promise<void>;
  trash(ids: string[]): Promise<void>;
}

export const METADATA_HEADERS = [
  "From",
  "Subject",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "Authentication-Results",
  "DKIM-Signature",
] as const;

export class AuthExpiredError extends Error {
  readonly code = "AUTH_EXPIRED";
  constructor(message = "Google sign-in expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}
