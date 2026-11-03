import { useCallback, useEffect, useRef, useState } from "react";
import { statusFromResult } from "../shared/status";
import type { CleanupMode, HistoryEntry, Job, SenderResult, StatusResponse, Subscription } from "../shared/types";
import { ApiError, api, pollJob } from "./api";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Header } from "./components/Header";
import { ResultsPanel } from "./components/ResultsPanel";
import { SetupNotice } from "./components/SetupNotice";
import { SignIn } from "./components/SignIn";
import { SubscriptionTable } from "./components/SubscriptionTable";

const NONE: ReadonlySet<string> = new Set();

const ENTRY_OUTCOME: Record<SenderResult["outcome"], HistoryEntry["outcome"]> = {
  unsubscribed: "unsubscribed",
  manual: "manual-pending",
  failed: "failed",
};

/**
 * Rows after senders finished, matching what the server records (§8 steps 2 and 4): the new status, and
 * the attempt the Status cell reads its failure reason and manual link from.
 */
function applyResults(rows: Subscription[], results: SenderResult[], at: number): Subscription[] {
  const bySender = new Map(results.map((r) => [r.sender, r]));
  return rows.map((row) => {
    const r = bySender.get(row.sender);
    if (!r) return row;
    const lastAttempt: HistoryEntry = { outcome: ENTRY_OUTCOME[r.outcome], at, detail: r.detail };
    if (r.methodUsed) lastAttempt.method = r.methodUsed;
    if (r.manualUrl) lastAttempt.manualUrl = r.manualUrl;
    return { ...row, status: statusFromResult(r), lastAttempt };
  });
}

/** A manual result after Mark done: it counts as unsubscribed, as the server now records it. */
function markedDone(r: SenderResult): SenderResult {
  const { manualUrl: _manualUrl, ...rest } = r;
  return { ...rest, outcome: "unsubscribed", detail: "marked done by user" };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Shown when starting an unsubscribe finds another job running (409). It lasts only until that job ends. */
const BUSY_NOTICE = "Another job is already running. Try again when it finishes.";
const withoutBusyNotice = (e: string | null) => (e === BUSY_NOTICE ? null : e);

/** The app shell (§3): setup, sign-in, or the signed-in header and subscriptions table. */
export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Subscription[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [hiddenAtLoad, setHiddenAtLoad] = useState<ReadonlySet<string>>(NONE);
  const [showUnsubscribed, setShowUnsubscribed] = useState(false);
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [visibleSelected, setVisibleSelected] = useState<string[]>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  /** The running job this page follows; null when none is running. */
  const [job, setJob] = useState<Job | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(NONE);
  const [restarted, setRestarted] = useState(false);
  /** The senders the confirm dialog is asking about; null when it is closed. */
  const [confirming, setConfirming] = useState<Subscription[] | null>(null);
  /** The results of the last finished unsubscribe job, until dismissed or the next scan. */
  const [results, setResults] = useState<SenderResult[] | null>(null);

  const stopPolling = useRef<() => void>(() => {});
  /** How many results of which unsubscribe job are already applied to the rows (results only grow). */
  const applied = useRef({ jobId: "", count: 0 });

  // The functions below touch only state setters, refs and the API, so a closure from any render works.

  function fail(err: unknown): void {
    // A 401 means the sign-in ended meanwhile: show the screen the server now reports.
    if (err instanceof ApiError && err.status === 401) {
      api.status().then(
        (s) => {
          setStatus(s);
          if (s.signedIn) setError(message(err));
        },
        () => setError(message(err)),
      );
      return;
    }
    setError(message(err));
  }

  function resetSession(): void {
    setError(null);
    setRows(null);
    setSkipped(0);
    setHiddenAtLoad(NONE);
    setShowUnsubscribed(false);
    setSelection({});
    setGlobalFilter("");
    setJob(null);
    setPending(NONE);
    setRestarted(false);
    setConfirming(null);
    setResults(null);
  }

  /** Loads the server's scan. Hidden-at-load is fixed here, so rows changed later in the session stay visible (§3.3). */
  async function loadScan(): Promise<void> {
    const scan = await api.latestScan();
    if (!scan) {
      setRestarted(true); // the server no longer holds a scan
      return;
    }
    setRows(scan.subscriptions);
    setSkipped(scan.skipped);
    setHiddenAtLoad(new Set(scan.subscriptions.filter((s) => s.status === "unsubscribed").map((s) => s.sender)));
    setSelection({});
  }

  /**
   * Applies one update of the followed job, scan or unsubscribe: progress, pending rows, results, errors.
   * Every job lands here, whether this page started it or resumed it after a reload.
   */
  async function onJob(j: Job | null): Promise<void> {
    // The followed job ended (or is gone), so a busy notice asking to wait for it no longer applies.
    if (j?.state !== "running") setError(withoutBusyNotice);
    if (!j) {
      setJob(null);
      setPending(NONE);
      setRestarted(true);
      return;
    }
    const running = j.state === "running";
    setJob(running ? j : null);
    if (j.kind === "unsubscribe") {
      const from = applied.current.jobId === j.id ? applied.current.count : 0;
      applied.current = { jobId: j.id, count: j.results.length };
      const fresh = j.results.slice(from);
      const at = Date.now();
      if (fresh.length > 0) setRows((rs) => rs && applyResults(rs, fresh, at));
      const finished = new Set(j.results.map((r) => r.sender));
      setPending(running ? new Set(j.senders.filter((s) => !finished.has(s))) : NONE);
    }
    if (j.state === "error") {
      // An expired sign-in shows the reconnect screen (§10).
      if (j.error?.code === "AUTH_EXPIRED") setStatus(await api.status());
      else setError(`${j.kind === "scan" ? "Scan" : "Unsubscribe"} failed: ${j.error?.message ?? "unknown error"}`);
    } else if (j.state === "done") {
      if (j.kind === "scan") {
        await loadScan();
      } else {
        setResults(j.results);
        setSelection({});
      }
    }
  }

  function follow(jobId: string): void {
    stopPolling.current();
    stopPolling.current = pollJob(jobId, (j) => void onJob(j).catch(fail));
  }

  async function startScan(): Promise<void> {
    setRestarted(false);
    setError(null);
    setResults(null); // its Mark done buttons belong to the scan being replaced
    const started = await api.startScan();
    follow(started.ok ? started.jobId : started.activeJobId);
  }

  /** Runs the confirmed unsubscribe: its senders show "Unsubscribing…" until their results arrive (§3.5). */
  async function startUnsubscribe(subs: Subscription[], cleanup: CleanupMode): Promise<void> {
    setConfirming(null);
    setError(null);
    setResults(null);
    const senders = subs.map((s) => s.sender);
    const started = await api.startUnsubscribe({ senders, cleanup });
    if (!started.ok) {
      setError(BUSY_NOTICE);
      follow(started.activeJobId);
      return;
    }
    setPending(new Set(senders));
    follow(started.jobId);
  }

  /**
   * Shows the screen for `s`. Signed in: loads the scan, then follows the active job, or starts a scan if there is none.
   * The scan loads even when a job is active (the brief's step 4 reads "else if"): a resumed unsubscribe job marks
   * its senders pending on these rows, so they must be there first.
   */
  async function enter(s: StatusResponse, cancelled: () => boolean = () => false): Promise<void> {
    setStatus(s);
    if (!s.configured || !s.signedIn) return;
    if (s.hasScan) await loadScan();
    if (cancelled()) return;
    if (s.activeJobId) follow(s.activeJobId);
    else if (!s.hasScan) await startScan();
  }

  async function signOut(): Promise<void> {
    stopPolling.current();
    await api.logout();
    resetSession();
    await enter(await api.status()); // demo mode stays signed in and scans again
  }

  useEffect(() => {
    let cancelled = false;
    api
      .status()
      .then((s) => (cancelled ? undefined : enter(s, () => cancelled)))
      .catch(fail);
    return () => {
      cancelled = true;
      stopPolling.current();
    };
  }, []);

  const onManualDone = useCallback((sender: string) => {
    api
      .manualDone(sender)
      .then(() => {
        setRows((rs) => rs && rs.map((r): Subscription => (r.sender === sender ? { ...r, status: "unsubscribed" } : r)));
        setResults((rs) => rs && rs.map((r) => (r.sender === sender && r.outcome === "manual" ? markedDone(r) : r)));
      })
      .catch(fail);
  }, []);

  if (!status) {
    return (
      <main className="screen">
        {error ? (
          <p className="notice notice-error" role="alert">
            Couldn't reach the server: {error}
          </p>
        ) : (
          <p>Loading…</p>
        )}
      </main>
    );
  }
  if (!status.configured) return <SetupNotice />;
  if (!status.signedIn) return <SignIn expired={status.authError === "expired"} />;

  // Pending senders mean an unsubscribe job is running, even before its first poll answers.
  const busy = job !== null || pending.size > 0;
  return (
    <div className="app">
      {status.demo && (
        <div className="demo-banner" data-testid="demo-banner">
          Demo mode: fake mailbox
        </div>
      )}
      <Header
        email={status.email}
        busy={busy}
        scanProgress={job?.kind === "scan" ? job.progress : null}
        skipped={skipped}
        restarted={restarted}
        onRescan={() => void startScan().catch(fail)}
        onSignOut={() => void signOut().catch(fail)}
      />
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {results && <ResultsPanel results={results} onManualDone={onManualDone} onDismiss={() => setResults(null)} />}
      {rows && (
        <>
          <div className="toolbar">
            <input
              type="search"
              className="search"
              data-testid="search-input"
              placeholder="Search by name, address or subject"
              aria-label="Search senders"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
            />
            <label className="toggle">
              <input
                type="checkbox"
                data-testid="show-unsubscribed"
                checked={showUnsubscribed}
                onChange={(e) => setShowUnsubscribed(e.target.checked)}
              />
              Show unsubscribed
            </label>
            <button
              type="button"
              className="button-primary"
              data-testid="unsubscribe-button"
              disabled={visibleSelected.length === 0 || busy}
              // Only the selected rows the search still shows (Review Focus 5).
              onClick={() => setConfirming(rows.filter((r) => visibleSelected.includes(r.sender)))}
            >
              Unsubscribe from {visibleSelected.length} selected
            </button>
          </div>
          <SubscriptionTable
            rows={rows}
            hiddenAtLoad={hiddenAtLoad}
            showUnsubscribed={showUnsubscribed}
            pending={pending}
            selection={selection}
            onSelectionChange={setSelection}
            globalFilter={globalFilter}
            onVisibleSelectedChange={setVisibleSelected}
            onManualDone={onManualDone}
          />
        </>
      )}
      {confirming && (
        <ConfirmDialog
          subs={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={(cleanup) => void startUnsubscribe(confirming, cleanup).catch(fail)}
        />
      )}
    </div>
  );
}
