/**
 * C7 — Finance regression fixtures.
 * Frozen scenarios for credit-vs-cash reconciliation and cash ledger totals.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  computeCycleReconciliationBreakdown,
  reconcileSocietyLedger,
} from "./reconciliation.js";
import { computeSocietyMoneySnapshot } from "./societyFinance.js";

type Snapshot = {
  villaId: string;
  cycleId: string;
  expectedAmount: number;
  paidAmount: number;
  status: "PENDING" | "PAID" | "PARTIAL" | "OVERDUE" | "WAIVED";
};

type MaintenancePayment = {
  villaId: string;
  maintenanceCollectionCycleId: string | null;
  amount: number;
  paymentDate: Date;
  month: number;
  year: number;
};

/** Fixture: June 2026-style credit settles snapshot without matching cash. */
const FIXTURE_CREDIT_ONLY_CYCLE: {
  snapshots: Snapshot[];
  payments: MaintenancePayment[];
  cycles: Array<{ id: string; financialYearId: string; periodKey: string; periodMonth: number; periodYear: number }>;
} = {
  snapshots: [
    { villaId: "v1", cycleId: "mc-may", expectedAmount: 1500, paidAmount: 2000, status: "PAID" },
    { villaId: "v1", cycleId: "mc-jun", expectedAmount: 1500, paidAmount: 1500, status: "PAID" },
  ],
  payments: [
    {
      villaId: "v1",
      maintenanceCollectionCycleId: "mc-may",
      amount: 2000,
      paymentDate: new Date("2026-05-10"),
      month: 5,
      year: 2026,
    },
  ],
  cycles: [
    { id: "mc-may", financialYearId: "fy26", periodKey: "2026-05", periodMonth: 5, periodYear: 2026 },
    { id: "mc-jun", financialYearId: "fy26", periodKey: "2026-06", periodMonth: 6, periodYear: 2026 },
  ],
};

function fixturePrisma(data: typeof FIXTURE_CREDIT_ONLY_CYCLE): PrismaClient {
  const groupBy = async () => [] as unknown[];
  return {
    villaMaintenanceSnapshot: {
      findMany: async () =>
        data.snapshots.map((s) => ({
          ...s,
          cycle: {
            id: s.cycleId,
            title: "Fixture cycle",
            periodMonth: 6,
            periodYear: 2026,
            societyId: "s-fixture",
          },
        })),
    },
    maintenancePayment: {
      findMany: async () => data.payments,
      groupBy,
    },
    userCyclePayment: { findMany: async () => [] },
    maintenanceCollectionCycle: { findMany: async () => data.cycles },
    additionalFund: { findMany: async () => [] },
    expense: { findMany: async () => [] },
    billingCycle: { findMany: async () => [] },
    reconciliationAlert: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async () => ({}),
      update: async () => ({}),
    },
  } as unknown as PrismaClient;
}

describe("finance regression fixtures (C7)", () => {
  it("FIXTURE_CREDIT_ONLY: June paid via credit does not raise reconciliation alert", async () => {
    const junBreakdown = computeCycleReconciliationBreakdown(1500, 0);
    assert.equal(junBreakdown.matched, true);
    assert.equal(junBreakdown.creditApplied, 1500);

    const db = fixturePrisma(FIXTURE_CREDIT_ONLY_CYCLE);
    const result = await reconcileSocietyLedger("s-fixture", db);
    assert.equal(result.matched, true);
    assert.equal(result.alertsCreated, 0);
    const junCycle = result.cycleResults.find((c) => c.cycleId === "mc-jun");
    assert.ok(junCycle);
    assert.equal(junCycle!.creditApplied, 1500);
  });

  it("FIXTURE_EXCESS_CASH: bank overpayment vs snapshot is auto-matched (advance credit)", async () => {
    const breakdown = computeCycleReconciliationBreakdown(300, 500);
    assert.equal(breakdown.matched, true);
    assert.equal(breakdown.advanceOverpayment, 200);
    assert.equal(breakdown.unexplainedDifference, 0);
  });

  it("FIXTURE_CASH_MATCH: MP cash equals snapshot paidAmount", async () => {
    const db = fixturePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 500, paidAmount: 500, status: "PAID" },
      ],
      payments: [
        {
          villaId: "v1",
          maintenanceCollectionCycleId: "mc1",
          amount: 500,
          paymentDate: new Date("2026-03-15"),
          month: 3,
          year: 2026,
        },
      ],
      cycles: [
        { id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 },
      ],
    });
    const snap = await computeSocietyMoneySnapshot(db, "s-fixture");
    assert.equal(snap.maintenanceCashAllTime, 500);
    const recon = await reconcileSocietyLedger("s-fixture", db);
    assert.equal(recon.matched, true);
  });

  it("K19 stale alert: re-run reconciliation refreshes open alert amounts", async () => {
    let alertVillaSum = 800;
    let alertSocietyCash = 400;
    const db = {
      villaMaintenanceSnapshot: {
        findMany: async () => [
          {
            villaId: "v1",
            cycleId: "mc-stale",
            expectedAmount: 1000,
            paidAmount: 600,
            status: "PARTIAL",
            cycle: {
              id: "mc-stale",
              title: "Stale cycle",
              periodMonth: 6,
              periodYear: 2026,
              societyId: "s-fixture",
            },
          },
        ],
      },
      maintenancePayment: {
        findMany: async () => [
          {
            villaId: "v1",
            maintenanceCollectionCycleId: "mc-stale",
            amount: 800,
            paymentDate: new Date("2026-06-10"),
            month: 6,
            year: 2026,
          },
        ],
        groupBy: async () => [],
      },
      userCyclePayment: { findMany: async () => [] },
      maintenanceCollectionCycle: {
        findMany: async () => [
          {
            id: "mc-stale",
            financialYearId: "fy1",
            periodKey: "2026-06",
            periodMonth: 6,
            periodYear: 2026,
          },
        ],
      },
      additionalFund: { findMany: async () => [] },
      expense: { findMany: async () => [] },
      billingCycle: { findMany: async () => [] },
      reconciliationAlert: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => ({
          id: "alert-stale",
          villaSum: alertVillaSum,
          societyCash: alertSocietyCash,
          severity: "CRITICAL",
        }),
        create: async () => ({}),
        update: async (args: {
          where: { id: string };
          data: { villaSum?: number; societyCash?: number; severity?: string };
        }) => {
          if (args.data.villaSum != null) alertVillaSum = args.data.villaSum;
          if (args.data.societyCash != null) alertSocietyCash = args.data.societyCash;
          return {};
        },
      },
    } as unknown as PrismaClient;

    const first = await reconcileSocietyLedger("s-fixture", db);
    assert.equal(first.alertsUpdated, 1);
    assert.equal(alertVillaSum, 600);
    assert.equal(alertSocietyCash, 800);
    assert.equal(first.matched, false);
  });
});
