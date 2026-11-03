const DAY_MS = 86_400_000;
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "Last received" (§3.3): relative within a week, otherwise `MMM d`. Counts local calendar days, so a
 * message from 23:59 yesterday is "Yesterday". Rounding absorbs the 23- or 25-hour days around DST
 * changes. A timestamp in the future (clock skew) reads "Today".
 */
export function formatReceived(ts: number, now: number): string {
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(ts)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 6) return `${days} days ago`;
  return MONTH_DAY.format(ts);
}
