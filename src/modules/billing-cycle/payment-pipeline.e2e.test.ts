/**
 * C1 — Payment pipeline E2E (unit-level harness).
 *
 * Documents the production path:
 *   create-order → gateway webhook/callback → recordPaymentAndSyncLedgers /
 *   syncLedgerForPayment → computeSocietyMoneySnapshot → reconcileSocietyLedger
 *
 * Full HTTP integration runs against local sandbox via `npm run smoke:mobile-apis`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { BillingUserPaymentStatus } from "@prisma/client";
import {
  classifyRazorpayOrderAndPayments,
  isRazorpayWebhookSettleEvent,
  mergeRazorpayStatusWithLocal,
} from "../../services/razorpay-status.js";
import { reconcileSocietyLedger } from "../../lib/reconciliation.js";
import { findLikelyDuplicateMaintenancePayment } from "../../lib/paymentDuplicateGuard.js";

type Snapshot = {
  villaId: string;
  cycleId: string;
  expectedAmount: number;
  paidAmount: number;
  status: "PENDING" | "PAID" | "PARTIAL" | "OVERDUE" | "WAIVED";
  cycle: { id: string; title: string; periodMonth: number; periodYear: number; societyId: string };
};

type MaintenancePayment = {
  villaId: string;
  maintenanceCollectionCycleId: string | null;
  amount: number;
  paymentDate: Date;
  month: number;
  year: number;
  reversedAt?: Date | null;
  reversalOfPaymentId?: string | null;
};

function fakeReconcilePrisma(opts: {
  snapshots: Snapshot[];
  maintenancePayments: MaintenancePayment[];
  userCyclePayments?: Array<{
    cycle: { financialYearId: string; cycleKey: string; societyId: string };
    user: { villaId: string; societyId: string };
    amountPaid: number;
  }>;
  maintenanceCycles: Array<{
    id: string;
    financialYearId: string;
    periodKey: string;
    periodMonth: number;
    periodYear: number;
  }>;
}): PrismaClient {
  const alerts: Array<{
    id: string;
    societyId: string;
    cycleId: string;
    villaSum: number;
    societyCash: number;
    difference: number;
    severity: string;
    resolvedAt: Date | null;
  }> = [];
  let alertSeq = 0;

  const groupBy = async (args: { by: string[]; where?: Record<string, unknown> }) => {
    const where = args.where ?? {};
    const mcFilter = Object.prototype.hasOwnProperty.call(where, "maintenanceCollectionCycleId")
      ? (where.maintenanceCollectionCycleId as { in?: string[] } | null)
      : undefined;
    const rows = opts.maintenancePayments.filter((mp) => {
      if (mcFilter === undefined) return true;
      if (mcFilter === null) return mp.maintenanceCollectionCycleId === null;
      if (Array.isArray(mcFilter.in)) {
        return (
          mp.maintenanceCollectionCycleId !== null &&
          mcFilter.in.includes(mp.maintenanceCollectionCycleId)
        );
      }
      return true;
    });
    const groups = new Map<string, { key: Record<string, unknown>; sum: number }>();
    for (const mp of rows) {
      const rec = mp as unknown as Record<string, unknown>;
      const key = args.by.map((f) => String(rec[f])).join("|");
      const g = groups.get(key) ?? {
        key: Object.fromEntries(args.by.map((f) => [f, rec[f]])),
        sum: 0,
      };
      g.sum += mp.amount;
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({ ...g.key, _sum: { amount: g.sum } }));
  };

  return {
    villaMaintenanceSnapshot: {
      findMany: async () => opts.snapshots,
    },
    maintenancePayment: {
      findMany: async ({ where }: { where?: { societyId?: string } }) =>
        opts.maintenancePayments.filter((mp) =>
          where?.societyId ? true : true,
        ),
      groupBy,
    },
    userCyclePayment: {
      findMany: async () =>
        (opts.userCyclePayments ?? []).map((ucp) => ({
          ...ucp,
          paymentStatus: BillingUserPaymentStatus.SUCCESS,
        })),
    },
    maintenanceCollectionCycle: {
      findMany: async () => opts.maintenanceCycles,
    },
    additionalFund: { findMany: async () => [] },
    expense: { findMany: async () => [] },
    billingCycle: { findMany: async () => [] },
    reconciliationAlert: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { societyId: string; cycleId: string; resolvedAt: null };
        data: { resolvedAt: Date };
      }) => {
        let count = 0;
        for (const a of alerts) {
          if (
            a.societyId === where.societyId &&
            a.cycleId === where.cycleId &&
            a.resolvedAt === null
          ) {
            a.resolvedAt = data.resolvedAt;
            count++;
          }
        }
        return { count };
      },
      findFirst: async ({
        where,
      }: {
        where: { societyId: string; cycleId: string; resolvedAt: null };
      }) =>
        alerts.find(
          (a) =>
            a.societyId === where.societyId &&
            a.cycleId === where.cycleId &&
            a.resolvedAt === null,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: {
          societyId: string;
          cycleId: string;
          villaSum: number;
          societyCash: number;
          difference: number;
          severity: string;
        };
      }) => {
        const row = { id: `alert-${++alertSeq}`, ...data, resolvedAt: null };
        alerts.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<{
          villaSum: number;
          societyCash: number;
          difference: number;
          severity: string;
        }>;
      }) => {
        const row = alerts.find((a) => a.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
  } as unknown as PrismaClient;
}

describe("payment pipeline E2E harness (C1)", () => {
  it("webhook settle event + captured payment maps to SUCCESS", () => {
    assert.equal(isRazorpayWebhookSettleEvent("payment.captured"), true);
    const classified = classifyRazorpayOrderAndPayments({
      orderStatus: "paid",
      payments: [{ id: "pay_mock_1", status: "captured" }],
    });
    assert.equal(classified.paymentStatus, "SUCCESS");
    assert.equal(classified.gatewayTransactionId, "pay_mock_1");

    const merged = mergeRazorpayStatusWithLocal(
      {
        outcome: "completed",
        paymentStatus: "SUCCESS",
        rawState: "captured",
        gatewayReachable: true,
        gatewaySuccessFlag: true,
        gatewayTransactionId: "pay_mock_1",
      },
      BillingUserPaymentStatus.PENDING,
    );
    assert.equal(merged.outcome, "completed");
    assert.equal(merged.paymentStatus, "SUCCESS");
  });

  it("reconciliation passes when snapshot paidAmount matches cash ledger", async () => {
    const db = fakeReconcilePrisma({
      snapshots: [
        {
          villaId: "v1",
          cycleId: "mc1",
          expectedAmount: 500,
          paidAmount: 500,
          status: "PAID",
          cycle: {
            id: "mc1",
            title: "Mar 2026",
            periodMonth: 3,
            periodYear: 2026,
            societyId: "s1",
          },
        },
      ],
      maintenancePayments: [
        {
          villaId: "v1",
          maintenanceCollectionCycleId: "mc1",
          amount: 500,
          paymentDate: new Date("2026-03-15"),
          month: 3,
          year: 2026,
        },
      ],
      maintenanceCycles: [
        {
          id: "mc1",
          financialYearId: "fy1",
          periodKey: "2026-03",
          periodMonth: 3,
          periodYear: 2026,
        },
      ],
    });

    const result = await reconcileSocietyLedger("s1", db);
    assert.equal(result.matched, true);
    assert.equal(result.cycleResults.length, 1);
    assert.equal(result.cycleResults[0]?.matched, true);
    assert.equal(result.alertsCreated, 0);
  });

  it("credit-only gap does not create an alert (A6)", async () => {
    const db = fakeReconcilePrisma({
      snapshots: [
        {
          villaId: "v1",
          cycleId: "mc1",
          expectedAmount: 500,
          paidAmount: 500,
          status: "PAID",
          cycle: {
            id: "mc1",
            title: "Mar 2026",
            periodMonth: 3,
            periodYear: 2026,
            societyId: "s1",
          },
        },
      ],
      maintenancePayments: [
        {
          villaId: "v1",
          maintenanceCollectionCycleId: "mc1",
          amount: 300,
          paymentDate: new Date("2026-03-15"),
          month: 3,
          year: 2026,
        },
      ],
      maintenanceCycles: [
        {
          id: "mc1",
          financialYearId: "fy1",
          periodKey: "2026-03",
          periodMonth: 3,
          periodYear: 2026,
        },
      ],
    });

    const result = await reconcileSocietyLedger("s1", db);
    assert.equal(result.matched, true);
    assert.equal(result.alertsCreated, 0);
    assert.equal(result.cycleResults[0]?.creditApplied, 200);
  });

  it("reconciliation creates alert when cash exceeds snapshot settled total", async () => {
    const db = fakeReconcilePrisma({
      snapshots: [
        {
          villaId: "v1",
          cycleId: "mc1",
          expectedAmount: 500,
          paidAmount: 300,
          status: "PARTIAL",
          cycle: {
            id: "mc1",
            title: "Mar 2026",
            periodMonth: 3,
            periodYear: 2026,
            societyId: "s1",
          },
        },
      ],
      maintenancePayments: [
        {
          villaId: "v1",
          maintenanceCollectionCycleId: "mc1",
          amount: 500,
          paymentDate: new Date("2026-03-15"),
          month: 3,
          year: 2026,
        },
      ],
      maintenanceCycles: [
        {
          id: "mc1",
          financialYearId: "fy1",
          periodKey: "2026-03",
          periodMonth: 3,
          periodYear: 2026,
        },
      ],
    });

    const result = await reconcileSocietyLedger("s1", db);
    assert.equal(result.matched, false);
    assert.equal(result.alertsCreated, 1);
    assert.ok(result.cycleResults[0]!.unexplainedDifference > 0);
  });

  it("duplicate guard skips reversed payments", async () => {
    const payments: Array<{
      id: string;
      societyId: string;
      villaId: string;
      month: number;
      year: number;
      amount: { toNumber: () => number };
      paymentMode: string;
      paymentDate: Date;
      receiptNumber: string;
      reversedAt: Date | null;
      reversalOfPaymentId: string | null;
    }> = [
      {
        id: "p1",
        societyId: "s1",
        villaId: "v1",
        month: 3,
        year: 2026,
        amount: { toNumber: () => 500 },
        paymentMode: "CASH",
        paymentDate: new Date("2026-07-07T10:00:00Z"),
        receiptNumber: "RCP-1",
        reversedAt: new Date(),
        reversalOfPaymentId: null,
      },
    ];

    const tx = {
      maintenancePayment: {
        findFirst: async ({ where }: { where: { reversedAt: null } }) => {
          const row = payments.find((p) => p.reversedAt === where.reversedAt);
          return row ?? null;
        },
      },
    };

    const dup = await findLikelyDuplicateMaintenancePayment(tx as never, {
      societyId: "s1",
      villaId: "v1",
      month: 3,
      year: 2026,
      amount: 500,
      paymentMode: "CASH",
      paymentDate: new Date("2026-07-07T10:05:00Z"),
    });
    assert.equal(dup, null);
  });
});
