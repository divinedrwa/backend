import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BillingCycleStatus } from "@prisma/client";
import {
  deriveCycleStatus,
  deriveCycleStatusUtc,
  isAppVisibleBillingCycle,
  normalizeBillingPaymentWindow,
} from "./cycleStatus";

const IST = "Asia/Kolkata";

describe("deriveCycleStatus (IST calendar days)", () => {
  const { paymentStartDate: start, paymentEndDate: end } = normalizeBillingPaymentWindow(
    new Date("2026-06-01T12:00:00.000Z"),
    new Date("2026-06-15T12:00:00.000Z"),
    IST,
  );

  it("returns UPCOMING before the local start date", () => {
    // May 31 8pm IST — still May 31 locally
    assert.equal(
      deriveCycleStatus(new Date("2026-05-31T14:30:00.000Z"), start, end, IST),
      BillingCycleStatus.UPCOMING,
    );
  });

  it("returns OPEN from local start through local end (inclusive)", () => {
    // June 1 1am IST
    assert.equal(
      deriveCycleStatus(new Date("2026-05-31T19:30:00.000Z"), start, end, IST),
      BillingCycleStatus.OPEN,
    );
    // June 15 11pm IST (= 17:30 UTC)
    assert.equal(
      deriveCycleStatus(new Date("2026-06-15T17:30:00.000Z"), start, end, IST),
      BillingCycleStatus.OPEN,
    );
  });

  it("returns CLOSED after the local end date", () => {
    // June 16 1am IST
    assert.equal(
      deriveCycleStatus(new Date("2026-06-15T19:30:00.000Z"), start, end, IST),
      BillingCycleStatus.CLOSED,
    );
  });

  it("deriveCycleStatusUtc alias matches deriveCycleStatus", () => {
    const now = new Date("2026-06-10T06:00:00.000Z");
    assert.equal(deriveCycleStatusUtc(now, start, end), deriveCycleStatus(now, start, end));
  });
});

describe("isAppVisibleBillingCycle", () => {
  const publishedAt = new Date("2026-05-20T00:00:00.000Z");

  it("hides draft and UPCOMING cycles", () => {
    const { paymentStartDate: start, paymentEndDate: end } = normalizeBillingPaymentWindow(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-15T23:59:59.999Z"),
      IST,
    );
    assert.equal(
      isAppVisibleBillingCycle(new Date("2026-05-31T14:30:00.000Z"), {
        publishedAt: null,
        paymentStartDate: start,
        paymentEndDate: end,
      }),
      false,
    );
    assert.equal(
      isAppVisibleBillingCycle(new Date("2026-05-31T14:30:00.000Z"), {
        publishedAt,
        paymentStartDate: start,
        paymentEndDate: end,
      }),
      false,
    );
  });

  it("shows OPEN and CLOSED published cycles", () => {
    const { paymentStartDate: start, paymentEndDate: end } = normalizeBillingPaymentWindow(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-15T23:59:59.999Z"),
      IST,
    );
    assert.equal(
      isAppVisibleBillingCycle(new Date("2026-06-10T06:00:00.000Z"), {
        publishedAt,
        paymentStartDate: start,
        paymentEndDate: end,
      }),
      true,
    );
    assert.equal(
      isAppVisibleBillingCycle(new Date("2026-06-20T06:00:00.000Z"), {
        publishedAt,
        paymentStartDate: start,
        paymentEndDate: end,
      }),
      true,
    );
  });

  it("treats Aug 1 as open all day IST even when stored with a midday UTC timestamp", () => {
    const augStart = new Date("2026-08-01T11:43:00.000Z");
    const augEnd = new Date("2026-08-10T11:43:00.000Z");
    const aug1MorningIst = new Date("2026-07-31T20:00:00.000Z"); // Aug 1 01:30 IST
    const jul31EveningIst = new Date("2026-07-31T17:00:00.000Z"); // Jul 31 22:30 IST

    assert.equal(
      isAppVisibleBillingCycle(jul31EveningIst, {
        publishedAt: new Date("2026-08-01T03:46:00.000Z"),
        paymentStartDate: augStart,
        paymentEndDate: augEnd,
      }),
      false,
    );
    assert.equal(
      isAppVisibleBillingCycle(aug1MorningIst, {
        publishedAt: new Date("2026-08-01T03:46:00.000Z"),
        paymentStartDate: augStart,
        paymentEndDate: augEnd,
      }),
      true,
    );
  });
});

describe("normalizeBillingPaymentWindow", () => {
  it("snaps to IST local day boundaries", () => {
    const { paymentStartDate, paymentEndDate } = normalizeBillingPaymentWindow(
      new Date("2026-08-01T11:43:00.000Z"),
      new Date("2026-08-10T15:00:00.000Z"),
      IST,
    );
    assert.equal(paymentStartDate.toISOString(), "2026-07-31T18:30:00.000Z");
    assert.equal(paymentEndDate.toISOString(), "2026-08-10T18:29:59.999Z");
  });
});
