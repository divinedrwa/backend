import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "./prisma";
import { isVisitorOnlyForVilla, isVisitorOnlyResident, villaIdsWithUnpaidDues } from "./visitorOnlyAccess";

/** Swaps one Prisma model delegate for a stub; undone after each test. */
const restorers: Array<() => void> = [];
function stubModel(model: "billingCycle" | "villaMaintenanceSnapshot", findMany: () => Promise<unknown>) {
  const client = prisma as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(client, model);
  const stub = { findMany };
  Object.defineProperty(client, model, { value: stub, configurable: true, writable: true });
  restorers.push(() => {
    if (original) Object.defineProperty(client, model, original);
    else delete client[model];
  });
  return stub;
}

const SOCIETY = "soc-1";
const D = (n: number) => new Prisma.Decimal(n);
const snap = (villaId: string, periodKey: string, expected: number, paid: number, lateFee = 0) => ({
  villaId,
  expectedAmount: D(expected),
  lateFeeAmount: D(lateFee),
  paidAmount: D(paid),
  cycle: { societyId: SOCIETY, periodKey },
});

/** Published, open billing cycle for each period key (visible in the app). */
function mockVisibleCycles(periodKeys: string[]) {
  const now = Date.now();
  stubModel("billingCycle", async () =>
    periodKeys.map((cycleKey) => ({
      cycleKey,
      publishedAt: new Date(now - 10 * 86_400_000),
      paymentStartDate: new Date(now - 10 * 86_400_000),
      paymentEndDate: new Date(now + 10 * 86_400_000),
    })),
  );
}

afterEach(() => restorers.splice(0).reverse().forEach((undo) => undo()));

describe("isVisitorOnlyResident", () => {
  it("restricts only residents of a villa with billing stopped and no old dues", () => {
    assert.equal(isVisitorOnlyResident(UserRole.RESIDENT, "2026-09"), true);
    assert.equal(isVisitorOnlyResident(UserRole.RESIDENT, "2026-09", true), false);
    assert.equal(isVisitorOnlyResident(UserRole.RESIDENT, null), false);
    assert.equal(isVisitorOnlyResident(UserRole.RESIDENT_CUM_ADMIN, "2026-09"), false);
  });
});

describe("villaIdsWithUnpaidDues", () => {
  it("returns villas still owing on an app-visible cycle, late fee included", async () => {
    stubModel("villaMaintenanceSnapshot", async () => [
      snap("owes", "2026-08", 1700, 0),
      snap("paid-base-owes-fee", "2026-08", 1700, 1700, 100),
      snap("settled", "2026-08", 1700, 1700),
      snap("draft-only", "2026-07", 1700, 0),
    ]);
    mockVisibleCycles(["2026-08"]);

    const owing = await villaIdsWithUnpaidDues(["owes", "paid-base-owes-fee", "settled", "draft-only"]);
    assert.deepEqual([...owing].sort(), ["owes", "paid-base-owes-fee"]);
  });

  it("keeps full access while old dues are open and goes visitor-only once paid", async () => {
    mockVisibleCycles(["2026-08"]);
    const snapshots = stubModel("villaMaintenanceSnapshot", async () => [
      snap("v1", "2026-08", 1700, 0),
    ]);
    const villa = { id: "v1", maintenanceExemptFromPeriod: "2026-09" };
    assert.equal(await isVisitorOnlyForVilla(UserRole.RESIDENT, villa), false);

    snapshots.findMany = async () => [];
    assert.equal(await isVisitorOnlyForVilla(UserRole.RESIDENT, villa), true);
  });
});
