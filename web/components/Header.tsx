import type { Job } from "../../shared/types";
import { ScanProgress } from "./ScanProgress";

export interface HeaderProps {
  email?: string;
  /** A job is running: no rescan until it finishes. */
  busy: boolean;
  /** Progress of the running scan, if one is running. */
  scanProgress: Job["progress"] | null;
  /** Emails the last scan couldn't read (§10). */
  skipped: number;
  /** A followed job vanished (404): the server restarted (§10). */
  restarted: boolean;
  onRescan: () => void;
  onSignOut: () => void;
}

/** The signed-in header (§3.2) and the scan notices under it. */
export function Header({ email, busy, scanProgress, skipped, restarted, onRescan, onSignOut }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-bar">
        <h1>Gmail Bulk Unsubscribe</h1>
        <div className="header-account">
          {email && (
            <span className="account-email" data-testid="account-email">
              {email}
            </span>
          )}
          <button type="button" data-testid="rescan-button" onClick={onRescan} disabled={busy}>
            Rescan
          </button>
          <button type="button" data-testid="signout-button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
      {scanProgress && <ScanProgress progress={scanProgress} />}
      {skipped > 0 && (
        <p className="notice notice-warn" data-testid="skipped-notice">
          {skipped === 1 ? "1 email couldn't be read" : `${skipped.toLocaleString("en-US")} emails couldn't be read`}
        </p>
      )}
      {restarted && (
        <p className="notice notice-warn" data-testid="restart-notice">
          The server restarted, rescan to continue.
        </p>
      )}
    </header>
  );
}
