import { describe, expect, it } from "vitest";
import { mapLimit } from "../../server/util/pool";

describe("mapLimit", () => {
  it("never runs more than limit at once", async () => {
    let inFlight = 0;
    let max = 0;
    await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(max).toBe(3);
  });

  it("preserves order and captures rejections as settled results", async () => {
    const res = await mapLimit([1, 2, 3, 4], 2, async (n, i) => {
      await new Promise((r) => setTimeout(r, 10 - n));
      if (n === 3) throw new Error("boom");
      return n * 10 + i;
    });
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect(res[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(res[3]).toEqual({ status: "fulfilled", value: 43 });
    expect((res[2] as PromiseRejectedResult).reason.message).toBe("boom");
  });
});
