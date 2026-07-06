import { Prisma, PrismaClient } from "@prisma/client";
import {
  BillingCycleDueFields,
  LedgerSnapshotInput,
  resolveCreditWalkCycleExpected,
} from "../billing-cycle/domain/amountDue";

type ReadDb = PrismaClient | Prisma.TransactionClient;

type McCycleRef = {
  id: string;
  financialYearId: string;
  periodKey: string;
};

export type CreditWalkBillingContext = {
  billingByFyKey: Map<string, BillingCycleDueFields & { id: string }>;
  waivedBillingCycleIds: Set<string>;
};

export async function loadCreditWalkBillingContext(
  db: ReadDb,
  societyId: string,
  villaIds?: string[],
): Promise<CreditWalkBillingContext> {
  const billingCycles = await db.billingCycle.findMany({
    where: { societyId },
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

  const billingByFyKey = new Map<string, BillingCycleDueFields & { id: string }>();
  for (const bc of billingCycles) {
    if (!bc.financialYearId) continue;
    billingByFyKey.set(`${bc.financialYearId}:${bc.cycleKey}`, bc);
  }

  const waivedBillingCycleIds = new Set<string>();
  if (villaIds && villaIds.length > 0 && billingCycles.length > 0) {
    const users = await db.user.findMany({
      where: { societyId, villaId: { in: villaIds } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      const waivers = await db.billingLateFeeWaiver.findMany({
        where: {
          userId: { in: userIds },
          cycleId: { in: billingCycles.map((b) => b.id) },
        },
        select: { cycleId: true },
      });
      for (const w of waivers) waivedBillingCycleIds.add(w.cycleId);
    }
  }

  return { billingByFyKey, waivedBillingCycleIds };
}

export function resolveWalkExpectedForCycle(
  ctx: CreditWalkBillingContext,
  cycle: McCycleRef,
  snap: LedgerSnapshotInput,
  nowUtc: Date,
): number {
  const billing = ctx.billingByFyKey.get(`${cycle.financialYearId}:${cycle.periodKey}`);
  const waived = billing ? ctx.waivedBillingCycleIds.has(billing.id) : false;
  return resolveCreditWalkCycleExpected(snap, billing ?? null, nowUtc, waived);
}
