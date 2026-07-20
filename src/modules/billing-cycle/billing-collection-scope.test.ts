import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadAppVisibleBillingCyclePeriodKeys,
  loadBillingCyclePeriodKeys,
} from "./billing-collection-scope";

describe("billing-collection-scope", () => {
  it("loadBillingCyclePeriodKeys includes draft cycles", async () => {
    const db = {
      billingCycle: {
        findMany: async () => [
          { cycleKey: "2026-04" },
          { cycleKey: "2026-05" },
        ],
      },
    };
    const keys = await loadBillingCyclePeriodKeys(db as never, "s1");
    assert.deepEqual(keys, ["2026-04", "2026-05"]);
  });

  it("loadAppVisibleBillingCyclePeriodKeys excludes unpublished drafts", async () => {
    const now = new Date("2026-04-15T12:00:00.000Z");
    const db = {
      billingCycle: {
        findMany: async () => [
          {
            cycleKey: "2026-04",
            publishedAt: new Date("2026-04-01"),
            paymentStartDate: new Date("2026-04-01T00:00:00.000Z"),
            paymentEndDate: new Date("2026-04-30T23:59:59.999Z"),
          },
          {
            cycleKey: "2026-05",
            publishedAt: null,
            paymentStartDate: new Date("2026-05-01T00:00:00.000Z"),
            paymentEndDate: new Date("2026-05-31T23:59:59.999Z"),
          },
        ],
      },
    };
    const keys = await loadAppVisibleBillingCyclePeriodKeys(
      db as never,
      "s1",
      null,
      now,
    );
    assert.deepEqual(keys, ["2026-04"]);
  });
});
