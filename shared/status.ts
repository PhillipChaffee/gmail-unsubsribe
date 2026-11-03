import type { SenderResult, Status } from "./types";

const STATUS_BY_OUTCOME: Record<SenderResult["outcome"], Status> = {
  unsubscribed: "unsubscribed",
  manual: "manual",
  failed: "failed",
};

/** The row status a finished sender shows. Pure: shared by the server and the web UI. */
export function statusFromResult(r: SenderResult): Status {
  return STATUS_BY_OUTCOME[r.outcome];
}
