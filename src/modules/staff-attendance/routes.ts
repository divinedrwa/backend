import { UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const checkInSchema = z.object({
  staffId: z.string().min(1),
  notes: z.string().trim().max(500).optional(),
});

const checkOutSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

router.use(requireAuth);

/**
 * GET /staff-attendance?date=YYYY-MM-DD
 * Returns all staff attendance for the given date (defaults to today).
 */
router.get("/", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const dateStr = req.query.date as string | undefined;
    const date = dateStr ? new Date(dateStr + "T00:00:00Z") : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

    const records = await prisma.staffAttendance.findMany({
      where: { societyId, date },
      include: {
        staff: { select: { id: true, name: true, type: true, phone: true, photo: true } },
        markedBy: { select: { id: true, name: true } },
      },
      orderBy: { checkIn: "asc" },
    });

    // Also get all active staff to show who hasn't checked in
    const allStaff = await prisma.staff.findMany({
      where: { societyId, isActive: true },
      select: { id: true, name: true, type: true, phone: true, photo: true },
      orderBy: { name: "asc" },
    });

    const checkedInIds = new Set(records.map((r) => r.staffId));
    const notCheckedIn = allStaff.filter((s) => !checkedInIds.has(s.id));

    return res.json({
      date: date.toISOString().slice(0, 10),
      attendance: records,
      notCheckedIn,
      summary: {
        total: allStaff.length,
        present: records.length,
        absent: notCheckedIn.length,
        checkedOut: records.filter((r) => r.checkOut).length,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /staff-attendance/monthly?staffId=...&month=YYYY-MM
 * Returns monthly attendance summary for a specific staff member.
 */
router.get("/monthly", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const staffId = req.query.staffId as string;
    const month = req.query.month as string; // YYYY-MM

    if (!staffId || !month) {
      return res.status(400).json({ message: "staffId and month (YYYY-MM) are required" });
    }

    const startDate = new Date(month + "-01T00:00:00Z");
    const endDate = new Date(startDate);
    endDate.setUTCMonth(endDate.getUTCMonth() + 1);

    const records = await prisma.staffAttendance.findMany({
      where: {
        societyId,
        staffId,
        date: { gte: startDate, lt: endDate },
      },
      orderBy: { date: "asc" },
    });

    const staff = await prisma.staff.findFirst({
      where: { id: staffId, societyId },
      select: { id: true, name: true, type: true, phone: true },
    });

    return res.json({
      staff,
      month,
      totalDays: records.length,
      records,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /staff-attendance/check-in
 * Mark a staff member as checked in for today.
 */
router.post(
  "/check-in",
  requireRole(UserRole.ADMIN, UserRole.GUARD),
  validateBody(checkInSchema),
  async (req, res, next) => {
    try {
      const { staffId, notes } = req.body as z.infer<typeof checkInSchema>;
      const societyId = req.auth!.societyId;

      const staff = await prisma.staff.findFirst({
        where: { id: staffId, societyId, isActive: true },
      });
      if (!staff) return res.status(404).json({ message: "Staff member not found" });

      const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

      const existing = await prisma.staffAttendance.findUnique({
        where: { staffId_date: { staffId, date: today } },
      });
      if (existing) {
        return res.status(409).json({ message: "Staff already checked in today" });
      }

      const record = await prisma.staffAttendance.create({
        data: {
          staffId,
          societyId,
          date: today,
          checkIn: new Date(),
          markedById: req.auth!.userId,
          notes: notes ?? null,
        },
        include: {
          staff: { select: { id: true, name: true, type: true } },
        },
      });

      return res.status(201).json({ attendance: record });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /staff-attendance/:id/check-out
 * Mark a staff member as checked out.
 */
router.post(
  "/:id/check-out",
  requireRole(UserRole.ADMIN, UserRole.GUARD),
  validateBody(checkOutSchema),
  async (req, res, next) => {
    try {
      const { notes } = req.body as z.infer<typeof checkOutSchema>;
      const existing = await prisma.staffAttendance.findFirst({
        where: { id: req.params.id, societyId: req.auth!.societyId },
      });
      if (!existing) return res.status(404).json({ message: "Attendance record not found" });
      if (existing.checkOut) return res.status(409).json({ message: "Already checked out" });

      const record = await prisma.staffAttendance.update({
        where: { id: req.params.id },
        data: {
          checkOut: new Date(),
          ...(notes && { notes }),
        },
        include: {
          staff: { select: { id: true, name: true, type: true } },
        },
      });

      return res.json({ attendance: record });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /staff-attendance/:id
 * Remove an attendance record (admin only).
 */
router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const result = await prisma.staffAttendance.deleteMany({
        where: { id: req.params.id, societyId: req.auth!.societyId },
      });
      if (result.count === 0) return res.status(404).json({ message: "Record not found" });
      return res.json({ message: "Attendance record deleted" });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
