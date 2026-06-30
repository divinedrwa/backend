import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

/**
 * Runs as part of the hourly billing cron.
 *
 * For each society with late fees configured:
 * 1. Find OVERDUE VillaMaintenanceSnapshots past the grace period
 * 2. Apply the late fee (percentage or fixed) if not already applied
 * 3. Update the snapshot's lateFeeAmount + lateFeeAppliedAt
 */
export async function applyLateFees(): Promise<void> {
  const societies = await prisma.society.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { lateFeePercentage: { gt: 0 } },
        { lateFeeFixedAmount: { gt: 0 } },
      ],
    },
    select: {
      id: true,
      lateFeePercentage: true,
      lateFeeFixedAmount: true,
      maintenanceGracePeriodDays: true,
    },
  });

  if (societies.length === 0) return;

  const now = new Date();

  for (const society of societies) {
    try {
      const graceCutoff = new Date(
        now.getTime() - society.maintenanceGracePeriodDays * 24 * 3600_000
      );

      // Find overdue snapshots past grace period that haven't had late fee applied
      const overdueSnapshots = await prisma.villaMaintenanceSnapshot.findMany({
        where: {
          cycle: {
            societyId: society.id,
            dueDate: { lt: graceCutoff },
          },
          status: { in: ["OVERDUE", "PENDING", "PARTIAL"] },
          lateFeeAppliedAt: null,
        },
        select: {
          id: true,
          expectedAmount: true,
          paidAmount: true,
        },
      });

      if (overdueSnapshots.length === 0) continue;

      let appliedCount = 0;
      for (const snap of overdueSnapshots) {
        let lateFee = 0;
        if (society.lateFeePercentage > 0) {
          lateFee = Math.round(Number(snap.expectedAmount) * (society.lateFeePercentage / 100) * 100) / 100;
        } else if (society.lateFeeFixedAmount > 0) {
          lateFee = society.lateFeeFixedAmount;
        }
        if (lateFee <= 0) continue;

        // Mini-transaction with FOR UPDATE: re-read the snapshot to ensure it
        // hasn't been paid (or had late fee applied) by a concurrent webhook.
        const applied = await prisma.$transaction(async (tx) => {
          const [locked] = await tx.$queryRawUnsafe<
            {
              id: string;
              status: string;
              paidAmount: string;
              expectedAmount: string;
              lateFeeAmount: string;
              lateFeeAppliedAt: Date | null;
            }[]
          >(
            `SELECT id, status, "paidAmount"::text, "expectedAmount"::text, "lateFeeAmount"::text, "lateFeeAppliedAt"
             FROM "villa_maintenance_snapshots"
             WHERE id = $1
             FOR UPDATE`,
            snap.id,
          );
          if (!locked) return false;
          if (locked.lateFeeAppliedAt) return false; // already applied
          if (locked.status === "PAID" || locked.status === "WAIVED") return false;
          const totalDue =
            Number(locked.expectedAmount) + Number(locked.lateFeeAmount ?? 0);
          if (Number(locked.paidAmount) >= totalDue) return false;

          await tx.villaMaintenanceSnapshot.update({
            where: { id: snap.id },
            data: { lateFeeAmount: lateFee, lateFeeAppliedAt: now },
          });
          return true;
        });

        if (applied) appliedCount++;
      }

      if (appliedCount > 0) {
        logger.info(
          { societyId: society.id, appliedCount },
          "[late-fee] Applied late fees"
        );
      }
    } catch (e) {
      logger.error({ err: e, societyId: society.id }, "[late-fee] Error applying late fees");
    }
  }
}
