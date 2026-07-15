/**
 * A7 — Auto-generate next maintenance collection cycle from the latest cycle template.
 * Runs on hourly billing cron when AUTO_MAINTENANCE_CYCLES=true.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";

type Db = typeof prisma;

function nextPeriod(month: number, year: number): { month: number; year: number; periodKey: string } {
  const nm = month === 12 ? 1 : month + 1;
  const ny = month === 12 ? year + 1 : year;
  return { month: nm, year: ny, periodKey: `${ny}-${String(nm).padStart(2, "0")}` };
}

export async function autoGenerateNextMaintenanceCycles(db: Db = prisma): Promise<{
  societiesProcessed: number;
  cyclesCreated: number;
  snapshotsGenerated: number;
}> {
  if (process.env.AUTO_MAINTENANCE_CYCLES !== "true") {
    return { societiesProcessed: 0, cyclesCreated: 0, snapshotsGenerated: 0 };
  }

  let cyclesCreated = 0;
  let snapshotsGenerated = 0;

  const societies = await db.society.findMany({
    where: { status: "ACTIVE", archivedAt: null, isSandbox: false },
    select: { id: true, name: true },
  });

  for (const society of societies) {
    const latest = await db.maintenanceCollectionCycle.findFirst({
      where: { societyId: society.id },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      include: { rule: true, _count: { select: { snapshots: true } } },
    });
    if (!latest?.rule) continue;

    const { month, year, periodKey } = nextPeriod(latest.periodMonth, latest.periodYear);
    const exists = await db.maintenanceCollectionCycle.findFirst({
      where: { societyId: society.id, periodKey },
    });
    if (exists) continue;

    const dueDate = new Date(Date.UTC(year, month - 1, 15));
    const cycle = await db.maintenanceCollectionCycle.create({
      data: {
        societyId: society.id,
        financialYearId: latest.financialYearId,
        periodKey,
        title: `Maintenance ${periodKey}`,
        periodMonth: month,
        periodYear: year,
        dueDate,
        status: "OPEN",
      },
    });

    await db.maintenanceCycleRule.create({
      data: {
        cycleId: cycle.id,
        ruleType: latest.rule.ruleType,
        baseAmount: latest.rule.baseAmount,
        perSqftRate: latest.rule.perSqftRate,
        customAmounts: latest.rule.customAmounts ?? Prisma.JsonNull,
      },
    });

    cyclesCreated += 1;

    const villas = await db.villa.findMany({
      where: { societyId: society.id },
      select: { id: true, monthlyMaintenance: true, area: true },
    });

    for (const villa of villas) {
      let expected = Number(villa.monthlyMaintenance ?? 0);
      if (latest.rule.ruleType === "PER_SQFT" && latest.rule.perSqftRate != null) {
        expected = Number(villa.area ?? 0) * Number(latest.rule.perSqftRate);
      } else if (latest.rule.ruleType === "FIXED_PER_FLAT" && latest.rule.baseAmount != null) {
        expected = Number(latest.rule.baseAmount);
      }
      await db.villaMaintenanceSnapshot.upsert({
        where: { cycleId_villaId: { cycleId: cycle.id, villaId: villa.id } },
        create: {
          cycleId: cycle.id,
          villaId: villa.id,
          expectedAmount: expected,
          paidAmount: 0,
          status: "PENDING",
        },
        update: {},
      });
      snapshotsGenerated += 1;
    }

    logger.info(
      { societyId: society.id, cycleId: cycle.id, periodKey },
      "[auto-cycle] Created maintenance collection cycle",
    );
  }

  return { societiesProcessed: societies.length, cyclesCreated, snapshotsGenerated };
}
