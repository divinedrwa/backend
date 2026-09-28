import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  excludeNonEnrolledVillasFromCycle,
  NOT_ENROLLED_EXCLUSION_REASON,
  restoreReenrolledVillaCycles,
} from "./billing-collection-link";

function recorder() {
  const calls: Record<string, unknown[]> = {};
  const log =
    (name: string, result: unknown = { id: `${name}-id` }) =>
    async (args: unknown) => {
      (calls[name] ??= []).push(args);
      return result;
    };
  return { calls, log };
}

const novCycle = {
  id: "c-nov",
  periodYear: 2026,
  periodMonth: 11,
  periodKey: "2026-11",
  financialYearId: "fy1",
};

describe("excludeNonEnrolledVillasFromCycle", () => {
  it("waives villas exempt on or before the cycle period, skipping ones with money recorded", async () => {
    const { calls, log } = recorder();
    let villaWhere: Record<string, unknown> | undefined;
    const tx = {
      maintenanceCollectionCycle: { findUnique: async () => novCycle },
      villa: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          villaWhere = args.where;
          return [{ id: "v-free" }, { id: "v-new" }, { id: "v-paid" }, { id: "v-snap-paid" }, { id: "v-done" }];
        },
      },
      cycleVillaExclusion: {
        findMany: async () => [{ villaId: "v-done" }],
        createMany: log("exclusionCreateMany"),
      },
      maintenancePayment: { findMany: async () => [{ villaId: "v-paid" }] },
      villaMaintenanceSnapshot: {
        findMany: async (args: { where: { paidAmount?: unknown } }) =>
          args.where.paidAmount ? [{ villaId: "v-snap-paid" }] : [{ id: "snap-free", villaId: "v-free" }],
        updateMany: log("snapshotUpdateMany"),
        createMany: log("snapshotCreateMany"),
      },
      villaCycleChargeLine: { deleteMany: log("chargeLinesDelete") },
      billingCycle: { findFirst: async () => ({ id: "bc-nov" }) },
      user: {
        findMany: async () => [
          { id: "u-primary", isActive: true, maintenanceBillingRole: "PRIMARY" },
          { id: "u-inactive", isActive: false, maintenanceBillingRole: "PRIMARY" },
          { id: "u-excluded", isActive: true, maintenanceBillingRole: "EXCLUDED" },
        ],
      },
      userCyclePayment: {
        deleteMany: log("ucpDelete"),
        createMany: log("ucpCreateMany"),
        updateMany: log("ucpUpdateMany"),
      },
    };

    const excluded = await excludeNonEnrolledVillasFromCycle(tx as never, {
      societyId: "s1",
      maintenanceCycleId: "c-nov",
    });

    assert.deepEqual(excluded, ["v-free", "v-new"]);
    assert.deepEqual(villaWhere?.maintenanceExemptFromPeriod, { not: null, lte: "2026-11" });

    const exclusions = calls.exclusionCreateMany?.[0] as { data: Array<{ villaId: string; reason: string }> };
    assert.deepEqual(exclusions.data.map((d) => d.villaId), ["v-free", "v-new"]);
    assert.ok(exclusions.data.every((d) => d.reason === NOT_ENROLLED_EXCLUSION_REASON));

    const updated = calls.snapshotUpdateMany?.[0] as { where: { id: { in: string[] } }; data: { status: string } };
    assert.deepEqual(updated.where.id.in, ["snap-free"]);
    assert.equal(updated.data.status, "WAIVED");
    assert.deepEqual(calls.chargeLinesDelete, [{ where: { snapshotId: { in: ["snap-free"] } } }]);
    const created = calls.snapshotCreateMany?.[0] as { data: Array<{ villaId: string; expectedAmount: Prisma.Decimal }> };
    assert.deepEqual(created.data.map((d) => d.villaId), ["v-new"]);
    assert.equal(Number(created.data[0].expectedAmount), 0);

    assert.deepEqual(calls.ucpDelete, [{ where: { cycleId: "bc-nov", userId: { in: ["u-excluded"] } } }]);
    const ucp = calls.ucpUpdateMany?.[0] as { where: { userId: { in: string[] } }; data: { paymentStatus: string } };
    assert.deepEqual(ucp.where.userId.in, ["u-primary"]);
    assert.equal(ucp.data.paymentStatus, "SUCCESS");
  });

  it("does nothing when no villa is exempt for the period", async () => {
    const tx = {
      maintenanceCollectionCycle: { findUnique: async () => ({ ...novCycle, periodMonth: 9, periodKey: "2026-09" }) },
      villa: { findMany: async () => [] },
    };
    const excluded = await excludeNonEnrolledVillasFromCycle(tx as never, {
      societyId: "s1",
      maintenanceCycleId: "c-nov",
    });
    assert.deepEqual(excluded, []);
  });
});

describe("restoreReenrolledVillaCycles", () => {
  const rule = {
    ruleType: "FIXED_PER_FLAT",
    baseAmount: new Prisma.Decimal(1500),
    perSqftRate: null,
    customAmounts: null,
  };
  const cycle = (id: string, month: number) => ({
    id,
    periodYear: 2026,
    periodMonth: month,
    periodKey: `2026-${String(month).padStart(2, "0")}`,
    financialYearId: "fy1",
    dueDate: new Date("2027-01-15T00:00:00.000Z"),
    rule,
  });

  function txFor(primaryCount: number) {
    const { calls, log } = recorder();
    let exclusionWhere: Record<string, unknown> | undefined;
    const tx = {
      cycleVillaExclusion: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          exclusionWhere = args.where;
          return [{ cycle: cycle("c-oct", 10) }, { cycle: cycle("c-dec", 12) }];
        },
        delete: log("exclusionDelete"),
      },
      villa: {
        findUnique: async () => ({ id: "v1", area: null, monthlyMaintenance: new Prisma.Decimal(1500) }),
      },
      society: { findUnique: async () => ({ useChargeHeads: false, chargeHeads: [] }) },
      user: { count: async () => primaryCount, findMany: async () => [] },
      villaMaintenanceSnapshot: { upsert: log("snapshotUpsert"), deleteMany: log("snapshotDelete") },
      villaCycleChargeLine: { deleteMany: log("chargeLinesDelete"), createMany: log("chargeLinesCreate") },
      billingCycle: { findFirst: async () => null },
    };
    return { tx, calls, where: () => exclusionWhere };
  }

  it("re-bills only automatic exclusions from the given period onward", async () => {
    const { tx, calls, where } = txFor(1);
    const restored = await restoreReenrolledVillaCycles(tx as never, {
      societyId: "s1",
      villaId: "v1",
      fromPeriod: "2026-11",
    });

    assert.equal(restored, 1);
    assert.equal(where()?.reason, NOT_ENROLLED_EXCLUSION_REASON);
    assert.deepEqual(calls.exclusionDelete, [
      { where: { cycleId_villaId: { cycleId: "c-dec", villaId: "v1" } } },
    ]);
    const upsert = calls.snapshotUpsert?.[0] as { update: { status: string; expectedAmount: Prisma.Decimal } };
    assert.equal(Number(upsert.update.expectedAmount), 1500);
    assert.equal(upsert.update.status, "PENDING");
  });

  it("drops the zero row instead of billing a villa that billing cycles would not bill", async () => {
    const { tx, calls } = txFor(0);
    (tx.billingCycle as { findFirst: () => Promise<unknown> }).findFirst = async () => ({ id: "bc-dec" });
    await restoreReenrolledVillaCycles(tx as never, { societyId: "s1", villaId: "v1", fromPeriod: "2026-11" });
    assert.equal(calls.snapshotUpsert, undefined);
    assert.deepEqual(calls.snapshotDelete, [{ where: { cycleId: "c-dec", villaId: "v1", paidAmount: 0 } }]);
  });
});
