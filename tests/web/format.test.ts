import { describe, expect, it } from "vitest";
import { formatReceived } from "../../web/format";

/** Local wall-clock time, so the expectations hold in any time zone. */
const at = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
const NOW = at(11, 3); // Nov 3 2026, local noon

describe("formatReceived", () => {
  it('formatReceived same day → "Today"', () => {
    expect(formatReceived(at(11, 3, 0, 5), NOW)).toBe("Today");
  });

  it('previous day → "Yesterday"', () => {
    // Calendar days, not 24-hour periods: 12 hours ago, but on the previous day.
    expect(formatReceived(at(11, 2, 23, 59), NOW)).toBe("Yesterday");
  });

  it('3 days → "3 days ago"', () => {
    expect(formatReceived(at(10, 31), NOW)).toBe("3 days ago");
  });

  it('8 days → "Oct 26"', () => {
    expect(formatReceived(at(10, 26), NOW)).toBe("Oct 26");
  });

  it('the relative range ends at 6 days; 7 days → "Oct 27"', () => {
    expect(formatReceived(at(10, 28, 0, 1), NOW)).toBe("6 days ago");
    expect(formatReceived(at(10, 27, 23, 59), NOW)).toBe("Oct 27");
  });
});
