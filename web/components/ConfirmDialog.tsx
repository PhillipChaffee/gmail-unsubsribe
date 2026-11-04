import { useLayoutEffect, useRef, useState } from "react";
import type { CleanupMode, Method, Subscription } from "../../shared/types";

export interface ConfirmDialogProps {
  subs: Subscription[];
  onCancel: () => void;
  onConfirm: (cleanup: CleanupMode) => void;
}

/** One line per method, in §3.4's order and words. */
const METHOD_LINES: { method: Method; text: (n: number) => string }[] = [
  { method: "one-click", text: (n) => `${n} by one-click` },
  { method: "mailto", text: (n) => `${n} by email: sends an unsubscribe email from your account` },
  { method: "manual", text: (n) => `${n} manual: you'll finish in your browser` },
];

const CLEANUP_OPTIONS: { mode: CleanupMode; label: string }[] = [
  { mode: "leave", label: "Leave them" },
  { mode: "archive", label: "Archive" },
  { mode: "trash", label: "Move to Trash" },
];

/**
 * The confirm dialog (§3.4): per-method counts and the cleanup choice, default Leave. It is the user
 * consent RFC 8058 requires before a one-click POST. A modal <dialog>, so Escape cancels and the page
 * behind it can't be used meanwhile.
 */
export function ConfirmDialog({ subs, onCancel, onConfirm }: ConfirmDialogProps) {
  const [cleanup, setCleanup] = useState<CleanupMode>("leave");
  const ref = useRef<HTMLDialogElement>(null);

  // A layout effect, so the cleanup's close() runs before React removes the element and focus goes back to the opener.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  const count = (method: Method) => subs.filter((s) => s.method === method).length;

  return (
    <dialog
      ref={ref}
      className="confirm"
      data-testid="confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault(); // the parent closes it by unmounting
        onCancel();
      }}
    >
      <h2 id="confirm-title">
        Unsubscribe from {subs.length} {subs.length === 1 ? "sender" : "senders"}?
      </h2>
      <ul className="confirm-counts">
        {METHOD_LINES.map(({ method, text }) => {
          const n = count(method);
          return n === 0 ? null : (
            <li key={method} data-testid={`confirm-count-${method}`}>
              {text(n)}
            </li>
          );
        })}
      </ul>
      <fieldset className="confirm-cleanup">
        <legend>Existing emails from these senders:</legend>
        <div className="confirm-options">
          {CLEANUP_OPTIONS.map(({ mode, label }) => (
            <label key={mode}>
              <input
                type="radio"
                name="cleanup"
                value={mode}
                data-testid={`cleanup-${mode}`}
                checked={cleanup === mode}
                onChange={() => setCleanup(mode)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="confirm-actions">
        <button type="button" data-testid="confirm-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-primary" data-testid="confirm-submit" onClick={() => onConfirm(cleanup)}>
          Unsubscribe
        </button>
      </div>
    </dialog>
  );
}
