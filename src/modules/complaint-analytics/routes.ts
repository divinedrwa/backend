import { ComplaintStatus, Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import {
  endOfLocalCalendarDay,
  localMonthKey,
  localMonthKeysForLastMonths,
  parseLocalDateKey,
  startOfLocalDayDaysAgo,
  startOfLocalMonth,
} from "../../lib/societyTime";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyResidentsComplaintStatusChanged } from "../../services/complaintStatusNotification.service";
import { buildComplaintStatusUpdate } from "../../services/complaintLifecycle.service";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

/** Resolved complaints are auto-closed later, so CLOSED counts as resolved too. */
const DONE: ComplaintStatus[] = [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED];
const isDone = (s: ComplaintStatus) => DONE.includes(s);

const DAY_MS = 24 * 60 * 60 * 1000;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Days from filing to resolution, for done complaints that have a resolution time. */
function resolutionDays(c: { status: ComplaintStatus; createdAt: Date; resolvedAt: Date | null }) {
  if (!isDone(c.status) || !c.resolvedAt) return null;
  const d = (c.resolvedAt.getTime() - c.createdAt.getTime()) / DAY_MS;
  return d >= 0 ? d : null;
}

/** Period filter: explicit YYYY-MM-DD range (whole local days) or the last N days incl. today. */
function periodFilter(query: Record<string, unknown>) {
  const { startDate, endDate } = query;
  const days = Math.min(Math.max(parseInt(String(query.days ?? "")) || 30, 1), 365);
  if (typeof startDate === "string" && typeof endDate === "string" && startDate && endDate) {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? parseLocalDateKey(startDate) : new Date(startDate);
    const endBase = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? parseLocalDateKey(endDate) : new Date(endDate);
    const end = endOfLocalCalendarDay(endBase);
    return { start, end, days, where: { createdAt: { gte: start, lte: end } } };
  }
  const start = startOfLocalDayDaysAgo(days - 1);
  return { start, end: new Date(), days, where: { createdAt: { gte: start } } };
}

function performanceFor(avgDays: number, resolved: number) {
  if (resolved === 0) return { performance: "none", performanceStatus: "No resolutions yet" };
  if (avgDays > 5) return { performance: "slow", performanceStatus: "Slow" };
  if (avgDays > 3) return { performance: "fair", performanceStatus: "Fair" };
  return { performance: "good", performanceStatus: "Good" };
}

// GET /api/complaint-analytics/summary
router.get("/summary", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const period = periodFilter(req.query as Record<string, unknown>);

    const [complaints, openNow] = await Promise.all([
      prisma.complaint.findMany({
        where: { societyId, ...(period.where as Prisma.ComplaintWhereInput) },
        select: {
          status: true,
          priority: true,
          createdAt: true,
          resolvedAt: true,
          slaDeadline: true,
        },
      }),
      // Everything still open today, regardless of when it was filed.
      prisma.complaint.findMany({
        where: { societyId, status: { in: [ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS] } },
        select: { createdAt: true, slaDeadline: true },
      }),
    ]);

    const totalComplaints = complaints.length;
    const done = complaints.filter((c) => isDone(c.status));
    const resolvedCount = done.length;
    const inProgressCount = complaints.filter((c) => c.status === "IN_PROGRESS").length;
    const pendingCount = complaints.filter((c) => c.status === "OPEN").length;
    const times = complaints.map(resolutionDays).filter((d): d is number => d != null);

    const now = new Date();
    const slaBreached = openNow.filter((c) => c.slaDeadline && c.slaDeadline < now).length;
    const doneWithSla = done.filter((c) => c.slaDeadline && c.resolvedAt);
    const withinSla = doneWithSla.filter((c) => c.resolvedAt! <= c.slaDeadline!).length;

    return res.json({
      period: { startDate: period.start, endDate: period.end, days: period.days },
      summary: {
        totalComplaints,
        resolvedCount,
        inProgressCount,
        pendingCount,
        resolutionRate: pct(resolvedCount, totalComplaints),
        avgResolutionTime: times.length ? round1(times.reduce((s, d) => s + d, 0) / times.length) : 0,
        medianResolutionDays: round1(median(times)),
        slaBreached,
        /** Null when nothing with an SLA was resolved in the period (was a misleading 100%). */
        slaComplianceRate: doneWithSla.length > 0 ? pct(withinSla, doneWithSla.length) : null,
        openNow: openNow.length,
        openOver7Days: openNow.filter((c) => now.getTime() - c.createdAt.getTime() > 7 * DAY_MS).length,
        byPriority: {
          LOW: complaints.filter((c) => c.priority === "LOW").length,
          MEDIUM: complaints.filter((c) => c.priority === "MEDIUM").length,
          HIGH: complaints.filter((c) => c.priority === "HIGH").length,
          URGENT: complaints.filter((c) => c.priority === "URGENT").length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/complaint-analytics/by-category
router.get("/by-category", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const period = periodFilter(req.query as Record<string, unknown>);

    const complaints = await prisma.complaint.findMany({
      where: { societyId, ...(period.where as Prisma.ComplaintWhereInput) },
      select: { category: true, status: true, createdAt: true, resolvedAt: true },
    });

    const byCategory = new Map<string, typeof complaints>();
    for (const c of complaints) {
      const key = c.category || "Other";
      byCategory.set(key, [...(byCategory.get(key) ?? []), c]);
    }

    const categoryStats = [...byCategory.entries()].map(([category, list]) => {
      const resolvedCount = list.filter((c) => isDone(c.status)).length;
      const times = list.map(resolutionDays).filter((d): d is number => d != null);
      const avgResolutionTime = times.length
        ? round1(times.reduce((s, d) => s + d, 0) / times.length)
        : 0;
      return {
        category,
        totalCount: list.length,
        resolvedCount,
        pendingCount: list.filter((c) => c.status === "OPEN").length,
        inProgressCount: list.filter((c) => c.status === "IN_PROGRESS").length,
        avgResolutionTime,
        resolutionRate: pct(resolvedCount, list.length),
        ...performanceFor(avgResolutionTime, resolvedCount),
      };
    });

    categoryStats.sort((a, b) => b.totalCount - a.totalCount);
    return res.json({ categoryStats });
  } catch (error) {
    next(error);
  }
});

// GET /api/complaint-analytics/pending-list — open complaints, most urgent first.
router.get("/pending-list", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "")) || 20, 1), 200);

    const pendingComplaints = await prisma.complaint.findMany({
      where: { societyId, status: { in: [ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS] } },
      include: { villa: { select: { villaNumber: true, block: true, ownerName: true } } },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    const now = Date.now();
    const rank = { critical: 0, high: 1, normal: 2 } as const;
    const complaintsWithAge = pendingComplaints
      .map((complaint) => {
        const daysPending = Math.floor((now - complaint.createdAt.getTime()) / DAY_MS);
        const slaBreached = complaint.slaDeadline
          ? complaint.slaDeadline.getTime() < now
          : daysPending > 7;
        let urgencyLevel: keyof typeof rank = "normal";
        if (slaBreached) urgencyLevel = "critical";
        else if (complaint.priority === "URGENT" || complaint.priority === "HIGH" || daysPending > 3) {
          urgencyLevel = "high";
        }
        return { ...complaint, daysPending, urgencyLevel, slaBreached };
      })
      .sort((a, b) => rank[a.urgencyLevel] - rank[b.urgencyLevel] || b.daysPending - a.daysPending)
      .slice(0, limit);

    return res.json({ pendingComplaints: complaintsWithAge });
  } catch (error) {
    next(error);
  }
});

// GET /api/complaint-analytics/trend — monthly filed vs resolved.
router.get("/trend", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const monthsCount = Math.min(Math.max(parseInt(String(req.query.months ?? "")) || 6, 1), 24);
    const monthKeys = localMonthKeysForLastMonths(monthsCount);
    const startDate = startOfLocalMonth(monthKeys[0]!);

    const complaints = await prisma.complaint.findMany({
      where: { societyId, createdAt: { gte: startDate } },
      select: { createdAt: true, status: true, resolvedAt: true },
    });

    const byMonth = new Map<string, typeof complaints>();
    for (const c of complaints) {
      const key = localMonthKey(c.createdAt);
      byMonth.set(key, [...(byMonth.get(key) ?? []), c]);
    }

    const trendData = monthKeys.map((month) => {
      const list = byMonth.get(month) ?? [];
      const resolvedComplaints = list.filter((c) => isDone(c.status)).length;
      const times = list.map(resolutionDays).filter((d): d is number => d != null);
      return {
        month,
        totalComplaints: list.length,
        resolvedComplaints,
        avgResolutionTime: times.length ? round1(times.reduce((s, d) => s + d, 0) / times.length) : 0,
        resolutionRate: pct(resolvedComplaints, list.length),
      };
    });

    return res.json({ trendData });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/complaint-analytics/quick-update/:id
// Quick status update for complaints
const quickUpdateSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
  adminNotes: z.string().trim().optional(),
});

router.patch(
  "/quick-update/:id",
  validateBody(quickUpdateSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { societyId } = req.auth!;
      const { status, adminNotes } = req.body as z.infer<typeof quickUpdateSchema>;

      // Check if complaint exists
      const complaint = await prisma.complaint.findFirst({
        where: {
          id,
          societyId,
        },
      });

      if (!complaint) {
        return res.status(404).json({ message: "Complaint not found" });
      }

      const previousStatus = complaint.status;

      let updateData: Prisma.ComplaintUpdateInput;
      try {
        updateData = buildComplaintStatusUpdate(complaint, { status, adminNotes });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid status transition";
        return res.status(400).json({ message });
      }

      const updatedComplaint = await prisma.complaint.update({
        where: { id },
        data: updateData,
        include: {
          villa: {
            select: {
              villaNumber: true,
              ownerName: true,
            },
          },
        },
      });

      if (previousStatus !== status) {
        void notifyResidentsComplaintStatusChanged({
          complaintId: id,
          title: updatedComplaint.title,
          villaId: updatedComplaint.villaId,
          societyId,
          residentId: updatedComplaint.residentId,
          previousStatus,
          newStatus: status,
          actorUserId: req.auth!.userId,
        });
      }

      return res.json({
        message: "Complaint updated successfully",
        complaint: updatedComplaint,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
