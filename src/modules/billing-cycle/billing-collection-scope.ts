import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { isAppVisibleBillingCycle } from "./domain/cycleStatus";

type DbClient = typeof prisma | Prisma.TransactionClient;

/** BillingCycle.cycleKey values for a society (optionally scoped to one financial year). */
export async function loadBillingCyclePeriodKeys(
  db: DbClient,
  societyId: string,
  financialYearId?: string | null,
): Promise<string[]> {
  const rows = await db.billingCycle.findMany({
    where: {
      societyId,
      ...(financialYearId ? { financialYearId } : {}),
    },
    select: { cycleKey: true },
  });
  return rows.map((r) => r.cycleKey);
}

/** Prisma filter — only MaintenanceCollectionCycle rows mirrored by a BillingCycle v1 row. */
export function maintenanceCollectionBackedByBillingCycleWhere(
  societyId: string,
  periodKeys: string[],
  extra?: Prisma.MaintenanceCollectionCycleWhereInput,
): Prisma.MaintenanceCollectionCycleWhereInput {
  if (periodKeys.length === 0) {
    return { id: { in: [] }, ...extra };
  }
  return {
    societyId,
    periodKey: { in: periodKeys },
    ...extra,
  };
}

/** BillingCycle.cycleKey values visible on mobile (published OPEN/CLOSED). */
export async function loadAppVisibleBillingCyclePeriodKeys(
  db: DbClient,
  societyId: string,
  financialYearId?: string | null,
  nowUtc = new Date(),
): Promise<string[]> {
  const rows = await db.billingCycle.findMany({
    where: {
      societyId,
      ...(financialYearId ? { financialYearId } : {}),
      publishedAt: { not: null },
    },
    select: {
      cycleKey: true,
      publishedAt: true,
      paymentStartDate: true,
      paymentEndDate: true,
    },
  });
  return rows
    .filter((r) => isAppVisibleBillingCycle(nowUtc, r))
    .map((r) => r.cycleKey);
}

/** True when a BillingCycle row still exists for this collection periodKey. */
export async function isCollectionCycleBackedByBillingCycle(
  db: DbClient,
  societyId: string,
  periodKey: string,
): Promise<boolean> {
  const row = await db.billingCycle.findFirst({
    where: { societyId, cycleKey: periodKey },
    select: { id: true },
  });
  return row != null;
}
