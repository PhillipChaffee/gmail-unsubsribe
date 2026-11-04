import type { SenderResult } from "../../shared/types";

export interface ResultsPanelProps {
  results: SenderResult[];
  onManualDone: (sender: string) => void;
  onDismiss: () => void;
}

const SUMMARY_PARTS: { outcome: SenderResult["outcome"]; text: (n: number) => string }[] = [
  { outcome: "unsubscribed", text: (n) => `✅ ${n} unsubscribed` },
  { outcome: "failed", text: (n) => `❌ ${n} failed` },
  { outcome: "manual", text: (n) => `↗ ${n} needs you` },
];

const CLEANUP_VERB = { archive: "archive emails", trash: "move emails to Trash" } as const;

/** `✅ X unsubscribed · ❌ Y failed · ↗ Z needs you`, without the zero parts (§3.5). */
function summarize(results: SenderResult[]): string {
  return SUMMARY_PARTS.map(({ outcome, text }) => ({ n: results.filter((r) => r.outcome === outcome).length, text }))
    .filter(({ n }) => n > 0)
    .map(({ n, text }) => text(n))
    .join(" · ");
}

/** The cleanup error reported next to the unsubscribe result (§3.5), or null when there is none. */
function cleanupError({ outcome, cleanup }: SenderResult): string | null {
  if (!cleanup || cleanup.ok || cleanup.mode === "leave") return null;
  const what = CLEANUP_VERB[cleanup.mode];
  const reason = cleanup.error ?? "unknown error";
  // A manual sender isn't unsubscribed yet, so it doesn't get the "Unsubscribed, but" lead-in.
  return outcome === "unsubscribed" ? `Unsubscribed, but couldn't ${what}: ${reason}` : `Couldn't ${what}: ${reason}`;
}

function Outcome({ result, onManualDone }: { result: SenderResult; onManualDone: (sender: string) => void }) {
  switch (result.outcome) {
    case "unsubscribed":
      return (
        <>
          <span className="result-outcome">✅ Unsubscribed</span>
          <span className="result-detail">{result.detail}</span>
        </>
      );
    case "failed":
      return <span className="result-outcome result-failed">{`❌ Failed: ${result.detail}`}</span>;
    case "manual":
      return (
        <>
          <span className="result-outcome">↗ Manual</span>
          {result.manualUrl && (
            <a className="button button-small" data-testid="manual-open" href={result.manualUrl} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          )}
          <button type="button" className="button-small" data-testid="manual-done" onClick={() => onManualDone(result.sender)}>
            Mark done
          </button>
          <span className="result-detail">{result.detail}</span>
        </>
      );
  }
}

/** Shown when an unsubscribe job finishes (§3.5): the summary, then one line per sender. */
export function ResultsPanel({ results, onManualDone, onDismiss }: ResultsPanelProps) {
  return (
    <section className="results" data-testid="results-panel" aria-labelledby="results-summary">
      <div className="results-head">
        <h2 id="results-summary" className="results-summary" data-testid="results-summary">
          {summarize(results)}
        </h2>
        <button type="button" className="button-small" data-testid="results-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <ul className="results-list">
        {results.map((r) => {
          const problem = cleanupError(r);
          return (
            <li key={r.sender} className="result-row" data-testid="result-row" data-sender={r.sender}>
              <span className="result-sender" title={r.sender}>
                {r.sender}
              </span>
              <div className="result-body">
                <div className="result-line">
                  <Outcome result={r} onManualDone={onManualDone} />
                </div>
                {problem && <div className="result-cleanup">{problem}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
