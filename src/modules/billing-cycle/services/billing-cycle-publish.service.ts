import { BillingCycle, BillingCycleStatus, NotificationCategory } from "@prisma/client";
import { logger } from "../../../lib/logger";
import { prisma } from "../../../lib/prisma";
import { RESIDENT_LIKE_ROLES } from "../../../lib/residentLike";
import { notifySocietyRoles } from "../../../services/notification.service";
import { generateSnapshotsForBillingCycle } from "../billing-collection-link";
import { deriveCycleStatusUtc } from "../domain/cycleStatus";
import { invalidateDisplayCycleHint } from "./cycle-service";
import { invalidateReconcileCache } from "./resident-pending-dues";

export type PublishBillingCycleOpts = {
  societyId: string;
  cycleId: string;
  publishedAt?: Date;
  /** When false, skip resident push (e.g. bulk auto-publish may batch later). Default true. */
  notifyResidents?: boolean;
};

/**
 * Publish a draft billing cycle: set publishedAt, generate villa snapshots, notify residents.
 * Idempotent when the cycle is already published.
 */
export async function publishBillingCycle(opts: PublishBillingCycleOpts): Promise<BillingCycle> {
  const publishedAt = opts.publishedAt ?? new Date();
  const found = await prisma.billingCycle.findFirst({
    where: { id: opts.cycleId, societyId: opts.societyId },
  });
  if (!found) {
    throw new Error("BILLING_CYCLE_NOT_FOUND");
  }
  if (found.publishedAt) {
    return found;
  }

  const status = deriveCycleStatusUtc(
    publishedAt,
    found.paymentStartDate,
    found.paymentEndDate,
  );

  const cycle = await prisma.billingCycle.update({
    where: { id: opts.cycleId },
    data: { publishedAt, status },
  });

  if (found.financialYearId) {
    try {
      await prisma.$transaction((tx) =>
        generateSnapshotsForBillingCycle(tx, {
          societyId: opts.societyId,
          billingCycleId: opts.cycleId,
          cycleAmount: Number(found.amount),
        }),
      );
    } catch (snapErr) {
      logger.error(
        { err: snapErr, cycleId: opts.cycleId },
        "[billing-cycle.publish] maintenance snapshot generation failed",
      );
    }
  }

  if (opts.notifyResidents !== false) {
    try {
      await notifySocietyRoles({
        societyId: opts.societyId,
        roles: [...RESIDENT_LIKE_ROLES],
        category: NotificationCategory.MAINTENANCE,
        title: "New maintenance billing cycle",
        body: `${found.title} (${found.cycleKey}) has been published. Please review and pay within the cycle window.`,
        data: {
          type: "BILLING_CYCLE_CREATED",
          cycleId: cycle.id,
          cycleKey: found.cycleKey,
        },
      });
    } catch (notifyErr) {
      logger.error({ err: notifyErr, cycleId: opts.cycleId }, "[billing-cycle.publish] resident notify failed");
    }
  }

  await invalidateDisplayCycleHint(opts.societyId);
  await invalidateReconcileCache(opts.societyId);

  return cycle;
}

/**
 * Auto-publish draft cycles whose payment window has opened (`paymentStartDate <= now`).
 * Safe to run hourly (cron) or on resident reads (society-scoped).
 */
export async function autoPublishDueBillingCycles(
  nowUtc = new Date(),
  opts?: { societyId?: string },
): Promise<{ published: number; cycleIds: string[] }> {
  const drafts = await prisma.billingCycle.findMany({
    where: {
      publishedAt: null,
      ...(opts?.societyId ? { societyId: opts.societyId } : {}),
    },
    orderBy: { paymentStartDate: "asc" },
    take: 100,
  });

  const cycleIds: string[] = [];
  for (const draft of drafts) {
    if (
      deriveCycleStatusUtc(nowUtc, draft.paymentStartDate, draft.paymentEndDate) ===
      BillingCycleStatus.UPCOMING
    ) {
      continue;
    }
    try {
      await publishBillingCycle({
        societyId: draft.societyId,
        cycleId: draft.id,
        publishedAt: nowUtc,
      });
      cycleIds.push(draft.id);
      logger.info(
        { cycleId: draft.id, societyId: draft.societyId, cycleKey: draft.cycleKey },
        "[billing-cycle.auto-publish] draft cycle published",
      );
    } catch (err) {
      logger.error({ err, cycleId: draft.id }, "[billing-cycle.auto-publish] failed");
    }
  }

  return { published: cycleIds.length, cycleIds };
}
