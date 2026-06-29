import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BillingCycleStatus } from "@prisma/client";
import { deriveCycleStatusUtc } from "./cycleStatus";

describe("deriveCycleStatusUtc", () => {
  const start = new Date("2026-06-01T00:00:00.000Z");
  const end = new Date("2026-06-15T23:59:59.999Z");

  it("returns UPCOMING before paymentStartDate", () => {
    assert.equal(
      deriveCycleStatusUtc(new Date("2026-05-31T23:59:59.999Z"), start, end),
      BillingCycleStatus.UPCOMING,
    );
  });

  it("returns OPEN on and before paymentEndDate", () => {
    assert.equal(
      deriveCycleStatusUtc(new Date("2026-06-01T00:00:00.000Z"), start, end),
      BillingCycleStatus.OPEN,
    );
    assert.equal(
      deriveCycleStatusUtc(new Date("2026-06-15T23:59:59.999Z"), start, end),
      BillingCycleStatus.OPEN,
    );
  });

  it("returns CLOSED after paymentEndDate", () => {
    assert.equal(
      deriveCycleStatusUtc(new Date("2026-06-16T00:00:00.000Z"), start, end),
      BillingCycleStatus.CLOSED,
    );
  });
});
