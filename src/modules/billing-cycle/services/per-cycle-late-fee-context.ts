import { MaintenanceBillingRole } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import {
  LedgerSnapshotInput,
  resolveLedgerCycleExpected,
} from "../domain/amountDue";
import { publishedBillingCycleFilter } from "./cycle-service";

type BillingCycleLateFeeRow = {
  id: string;
  financialYearId: string | null;
  cycleKey: string;
  amount: unknown;
  lateFee: unknown;
  paymentEndDate: Date;
  gracePeriodDays: number;
};

export type PerCycleLateFeeContext = {
  billingCycleByFyKey: Map<string, BillingCycleLateFeeRow>;
  primaryUserByVillaId: Map<string, string>;
  waivedUserCycleKeys: Set<string>;
};

export async function loadPerCycleLateFeeContext(societyId: string): Promise<PerCycleLateFeeContext> {
  const billingCycles = await prisma.billingCycle.findMany({
    where: { societyId, ...publishedBillingCycleFilter },
    select: {
      id: true,
      financialYearId: true,
      cycleKey: true,
      amount: true,
      lateFee: true,
      paymentEndDate: true,
      gracePeriodDays: true,
    },
  });

  const billingCycleByFyKey = new Map<string, BillingCycleLateFeeRow>();
  for (const bc of billingCycles) {
    if (!bc.financialYearId) continue;
    billingCycleByFyKey.set(`${bc.financialYearId}:${bc.cycleKey}`, bc);
  }

  const primaryUsers = await prisma.user.findMany({
    where: { societyId, maintenanceBillingRole: MaintenanceBillingRole.PRIMARY },
    select: { id: true, villaId: true },
  });
  const primaryUserByVillaId = new Map(
    primaryUsers
      .filter((u): u is typeof u & { villaId: string } => Boolean(u.villaId))
      .map((u) => [u.villaId, u.id] as const),
  );

  const cycleIds = billingCycles.map((c) => c.id);
  const userIds = primaryUsers.map((u) => u.id);
  const waivers =
    cycleIds.length > 0 && userIds.length > 0
      ? await prisma.billingLateFeeWaiver.findMany({
          where: { cycleId: { in: cycleIds }, userId: { in: userIds } },
          select: { cycleId: true, userId: true },
        })
      : [];
  const waivedUserCycleKeys = new Set(waivers.map((w) => `${w.userId}:${w.cycleId}`));

  return { billingCycleByFyKey, primaryUserByVillaId, waivedUserCycleKeys };
}

export function resolveSnapshotCycleTotals(
  ctx: PerCycleLateFeeContext,
  params: {
    villaId: string;
    financialYearId: string;
    periodKey: string;
    snapshot: LedgerSnapshotInput;
    nowUtc: Date;
  },
): { baseExpectedAmount: number; lateFeeAmount: number; totalExpected: number } {
  const billingCycle = ctx.billingCycleByFyKey.get(`${params.financialYearId}:${params.periodKey}`);
  if (!billingCycle) {
    const baseExpectedAmount = Number(params.snapshot.expectedAmount);
    const lateFeeAmount = Number(params.snapshot.lateFeeAmount ?? 0);
    return {
      baseExpectedAmount,
      lateFeeAmount,
      totalExpected: baseExpectedAmount + lateFeeAmount,
    };
  }

  const userId = ctx.primaryUserByVillaId.get(params.villaId);
  const waived = Boolean(
    userId && ctx.waivedUserCycleKeys.has(`${userId}:${billingCycle.id}`),
  );
  const totals = resolveLedgerCycleExpected(
    billingCycle,
    params.snapshot,
    params.nowUtc,
    waived,
  );
  return {
    baseExpectedAmount: totals.baseAmount,
    lateFeeAmount: totals.lateFeeAmount,
    totalExpected: totals.totalExpected,
  };
}
