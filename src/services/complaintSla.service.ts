import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { notifySocietyRoles, notifyUser } from "./notification.service";

/**
 * Finds complaints whose SLA deadline has passed while still OPEN or IN_PROGRESS,
 * and notifies society admins about the breach.
 *
 * Called once per hour from the billing cron job.
 */
export async function checkComplaintSlaBreaches(): Promise<number> {
  const now = new Date();

  // Find complaints past their SLA that are still unresolved
  const breached = await prisma.complaint.findMany({
    where: {
      slaDeadline: { lt: now },
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    select: {
      id: true,
      title: true,
      priority: true,
      slaDeadline: true,
      societyId: true,
      villa: { select: { villaNumber: true } },
    },
  });

  if (breached.length === 0) return 0;

  // Group by society to send one notification per society
  const bySociety = new Map<string, typeof breached>();
  for (const c of breached) {
    const list = bySociety.get(c.societyId) ?? [];
    list.push(c);
    bySociety.set(c.societyId, list);
  }

  for (const [societyId, complaints] of bySociety) {
    const count = complaints.length;
    const preview = complaints
      .slice(0, 3)
      .map((c) => `• ${c.title} (Villa ${c.villa.villaNumber})`)
      .join("\n");
    const body =
      count <= 3
        ? preview
        : `${preview}\n…and ${count - 3} more`;

    await notifySocietyRoles({
      societyId,
      roles: ["ADMIN"],
      category: "COMPLAINT",
      title: `${count} complaint${count > 1 ? "s" : ""} past SLA deadline`,
      body,
      data: { type: "COMPLAINT_SLA_BREACH" },
    });
  }

  logger.info({ breachedCount: breached.length }, "[sla-cron] Complaint SLA breach notifications sent");
  return breached.length;
}

const AUTO_CLOSE_DAYS = 7;

/**
 * Auto-closes complaints that have been RESOLVED for more than 7 days.
 * Notifies the filing resident when their complaint is auto-closed.
 *
 * Called once per hour from the billing cron job.
 */
export async function autoCloseResolvedComplaints(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - AUTO_CLOSE_DAYS);

  const stale = await prisma.complaint.findMany({
    where: {
      status: "RESOLVED",
      resolvedAt: { lt: cutoff },
    },
    select: { id: true, title: true, residentId: true },
  });

  if (stale.length === 0) return 0;

  await prisma.complaint.updateMany({
    where: { id: { in: stale.map((c) => c.id) } },
    data: { status: "CLOSED" },
  });

  // Notify residents whose complaints were auto-closed
  for (const c of stale) {
    if (c.residentId) {
      void notifyUser(c.residentId, {
        title: "Complaint closed",
        body: `Your complaint "${c.title}" has been automatically closed after ${AUTO_CLOSE_DAYS} days in resolved status.`,
        data: { type: "COMPLAINT_AUTO_CLOSED", complaintId: c.id },
      }, { category: "COMPLAINT" });
    }
  }

  logger.info({ closedCount: stale.length }, "[sla-cron] Auto-closed resolved complaints");
  return stale.length;
}
