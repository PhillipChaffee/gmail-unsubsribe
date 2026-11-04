import type { Subscription } from "../../shared/types";

export interface StatusCellProps {
  sub: Subscription;
  /** The sender is part of the running unsubscribe job. */
  pending: boolean;
  onManualDone: (sender: string) => void;
}

/** The Status column (§3.3): blank, Unsubscribing…, ✅, ❌ with the reason, ↗ Manual with Open and Mark done, or ⚠. */
export function StatusCell({ sub, pending, onManualDone }: StatusCellProps) {
  const state = pending ? "pending" : sub.status;
  return (
    <div className={`status status-${state}`} data-testid="status-cell">
      <StatusContent sub={sub} pending={pending} onManualDone={onManualDone} />
    </div>
  );
}

function StatusContent({ sub, pending, onManualDone }: StatusCellProps) {
  if (pending) return <>Unsubscribing…</>;
  switch (sub.status) {
    case "active":
      return null;
    case "unsubscribed":
      return <>✅ Unsubscribed</>;
    case "still-sending":
      return <>⚠ Still sending</>;
    case "failed": {
      const text = sub.lastAttempt?.detail ? `❌ Failed: ${sub.lastAttempt.detail}` : "❌ Failed";
      return (
        <span className="status-detail" title={text}>
          {text}
        </span>
      );
    }
    case "manual": {
      const url = sub.lastAttempt?.manualUrl ?? sub.targets.webUrl;
      return (
        <>
          <span>↗ Manual</span>
          {url && (
            <a className="button button-small" data-testid="manual-open" href={url} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          )}
          <button type="button" className="button-small" data-testid="manual-done" onClick={() => onManualDone(sub.sender)}>
            Mark done
          </button>
        </>
      );
    }
  }
}
