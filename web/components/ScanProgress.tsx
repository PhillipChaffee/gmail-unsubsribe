import type { Job } from "../../shared/types";

const n = (v: number) => v.toLocaleString("en-US");

/** "Scanning… 412 / 980 emails" (§3.3). The total is 0 while the message list is still being fetched. */
export function ScanProgress({ progress }: { progress: Job["progress"] }) {
  const { done, total } = progress;
  return (
    <div className="notice scan-progress" data-testid="scan-progress" role="status">
      <span>{total > 0 ? `Scanning… ${n(done)} / ${n(total)} emails` : "Scanning…"}</span>
      <progress max={total || undefined} value={total > 0 ? done : undefined} aria-hidden="true" />
    </div>
  );
}
