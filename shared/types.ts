export type Method = "one-click" | "mailto" | "manual";
export type Status = "active" | "unsubscribed" | "still-sending" | "manual" | "failed";
export type CleanupMode = "leave" | "archive" | "trash";

/** oneClickUrl: set only when one-click eligible (§7.2). webUrl: first https URI, else first http URI. */
export interface UnsubTargets {
  oneClickUrl?: string;
  mailto?: string;
  webUrl?: string;
}

export interface HistoryEntry {
  outcome: "unsubscribed" | "manual-pending" | "manual-done" | "failed";
  method?: Method;
  at: number;
  detail: string;
  manualUrl?: string;
}

export interface Subscription {
  sender: string;
  name: string;
  count: number;
  lastReceived: number;
  latestSubject: string;
  method: Method;
  targets: UnsubTargets;
  status: Status;
  lastAttempt?: HistoryEntry;
}

export interface SenderResult {
  sender: string;
  outcome: "unsubscribed" | "manual" | "failed";
  methodUsed?: Method;
  detail: string;
  manualUrl?: string;
  cleanup?: { mode: CleanupMode; ok: boolean; count?: number; error?: string };
}

export interface JobError {
  code: "AUTH_EXPIRED" | "GMAIL_ERROR" | "INTERNAL";
  message: string;
}

export interface Job {
  id: string;
  kind: "scan" | "unsubscribe";
  state: "running" | "done" | "error";
  progress: { done: number; total: number };
  results: SenderResult[];
  /** The job's sender list (empty for scans); lets the UI mark rows "Unsubscribing…" after a reload. */
  senders: string[];
  error?: JobError;
  startedAt: number;
  finishedAt?: number;
}

export interface ScanResult {
  scannedAt: number;
  subscriptions: Subscription[];
  skipped: number;
}

export interface StatusResponse {
  configured: boolean;
  signedIn: boolean;
  demo: boolean;
  email?: string;
  authError?: "expired";
  activeJobId?: string;
  hasScan: boolean;
}

export interface UnsubscribeRequest {
  senders: string[];
  cleanup: CleanupMode;
}

export interface JobStartResponse {
  jobId: string;
}

export interface BusyResponse {
  activeJobId: string;
}
