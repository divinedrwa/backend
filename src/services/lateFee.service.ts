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
        const expected = Number(snap.expectedAmount);
        const paid = Number(snap.paidAmount);
        if (paid >= expected) continue; // Already paid in full

        let lateFee = 0;
        if (society.lateFeePercentage > 0) {
          lateFee = Math.round(expected * (society.lateFeePercentage / 100) * 100) / 100;
        } else if (society.lateFeeFixedAmount > 0) {
          lateFee = society.lateFeeFixedAmount;
        }

        if (lateFee <= 0) continue;

        await prisma.villaMaintenanceSnapshot.update({
          where: { id: snap.id },
          data: {
            lateFeeAmount: lateFee,
            lateFeeAppliedAt: now,
          },
        });
        appliedCount++;
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
