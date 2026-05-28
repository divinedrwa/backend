import { Prisma, ShiftType, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

/** Anchor `startTime` / `endTime` for recurring rows (sorting + legacy); active matching uses minute fields. */
function buildRecurringAnchorTimes(recurringStartMinutes: number, recurringEndMinutes: number): {
  startTime: Date;
  endTime: Date;
} {
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const startTime = new Date(base);
  startTime.setMinutes(recurringStartMinutes);

  const endTime = new Date(base);
  if (recurringEndMinutes <= recurringStartMinutes) {
    endTime.setDate(endTime.getDate() + 1);
  }
  endTime.setMinutes(recurringEndMinutes % (24 * 60));

  return { startTime, endTime };
}

// IDs are Prisma `String @id` — seed uses custom gate ids (e.g. `gate-1`), not only cuids.
const createShiftSchema = z
  .object({
    guardId: z.string().min(1),
    gateId: z.string().min(1),
    shiftType: z.nativeEnum(ShiftType),
    recurringDaily: z.boolean().optional().default(false),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    recurringStartMinutes: z.number().int().min(0).max(1439).optional(),
    recurringEndMinutes: z.number().int().min(0).max(1440).optional(),
    notes: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.recurringDaily) {
      if (data.recurringStartMinutes === undefined || data.recurringEndMinutes === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "recurringStartMinutes and recurringEndMinutes are required when recurringDaily is true",
          path: ["recurringStartMinutes"],
        });
      } else if (data.recurringStartMinutes === data.recurringEndMinutes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Recurring shift must have a non-zero duration",
          path: ["recurringEndMinutes"],
        });
      }
    } else if (!data.startTime || !data.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startTime and endTime are required when recurringDaily is false",
        path: ["startTime"],
      });
    }
  });

const updateShiftSchema = z.object({
  guardId: z.string().min(1).optional(),
  gateId: z.string().min(1).optional(),
  shiftType: z.nativeEnum(ShiftType).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  notes: z.string().trim().optional()
});

router.use(requireAuth);

// List shifts
router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { societyId: req.auth!.societyId };
    const [shifts, total] = await Promise.all([
      prisma.guardShift.findMany({
        where,
        include: {
          guard: { select: { id: true, name: true, email: true } },
          gate: { select: { id: true, name: true, location: true } },
        },
        orderBy: { startTime: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.guardShift.count({ where }),
    ]);
    return res.json({ shifts, ...paginationMeta(total, shifts.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// My shifts (for guards)
router.get("/my-shifts", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const daysBack = Math.min(Math.max(parseInt(req.query.days as string, 10) || 7, 1), 365);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const where: Prisma.GuardShiftWhereInput = {
      societyId: req.auth!.societyId,
      guardId: req.auth!.userId,
      OR: [{ recurringDaily: true }, { recurringDaily: false, startTime: { gte: startDate } }],
    };
    const [shifts, total] = await Promise.all([
      prisma.guardShift.findMany({
        where,
        include: { gate: { select: { id: true, name: true, location: true } } },
        orderBy: { startTime: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.guardShift.count({ where }),
    ]);
    return res.json({ shifts, ...paginationMeta(total, shifts.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// Create shift (Admin only)
router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createShiftSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createShiftSchema>;

      let startTime: Date;
      let endTime: Date;
      let recurringDaily = body.recurringDaily;
      let recurringStartMinutes: number | null = null;
      let recurringEndMinutes: number | null = null;

      if (body.recurringDaily && body.recurringStartMinutes !== undefined && body.recurringEndMinutes !== undefined) {
        recurringStartMinutes = body.recurringStartMinutes;
        recurringEndMinutes = body.recurringEndMinutes;
        const anchors = buildRecurringAnchorTimes(recurringStartMinutes, recurringEndMinutes);
        startTime = anchors.startTime;
        endTime = anchors.endTime;
      } else {
        recurringDaily = false;
        startTime = new Date(body.startTime!);
        endTime = new Date(body.endTime!);
      }

      // Verify guard exists and is a guard
      const guard = await prisma.user.findFirst({
        where: {
          id: body.guardId,
          societyId: req.auth!.societyId,
          role: UserRole.GUARD
        }
      });

      if (!guard) {
        return res.status(404).json({ message: "Guard not found" });
      }

      // Verify gate exists
      const gate = await prisma.gate.findFirst({
        where: {
          id: body.gateId,
          societyId: req.auth!.societyId
        }
      });

      if (!gate) {
        return res.status(404).json({ message: "Gate not found" });
      }

      // Check for overlapping shifts for the same guard
      const overlapping = await prisma.guardShift.findFirst({
        where: {
          guardId: body.guardId,
          societyId: req.auth!.societyId,
          OR: [
            { AND: [{ startTime: { lte: startTime } }, { endTime: { gt: startTime } }] },
            { AND: [{ startTime: { lt: endTime } }, { endTime: { gte: endTime } }] },
            { AND: [{ startTime: { gte: startTime } }, { endTime: { lte: endTime } }] },
          ],
        },
      });

      if (overlapping) {
        return res.status(409).json({ message: "Guard already has an overlapping shift during this time" });
      }

      const shift = await prisma.guardShift.create({
        data: {
          societyId: req.auth!.societyId,
          guardId: body.guardId,
          gateId: body.gateId,
          shiftType: body.shiftType,
          startTime,
          endTime,
          recurringDaily,
          recurringStartMinutes,
          recurringEndMinutes,
          notes: body.notes
        },
        include: {
          guard: {
            select: {
              id: true,
              name: true,
              email: true
            }
          },
          gate: {
            select: {
              id: true,
              name: true,
              location: true
            }
          }
        }
      });

      return res.status(201).json({ shift });
    } catch (error) {
      next(error);
    }
  }
);

// Update shift
router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateShiftSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateShiftSchema>;
      const { id } = req.params;

      const updateData: Prisma.GuardShiftUncheckedUpdateManyInput = {};
      if (body.guardId) updateData.guardId = body.guardId;
      if (body.gateId) updateData.gateId = body.gateId;
      if (body.shiftType) updateData.shiftType = body.shiftType;
      if (body.startTime) updateData.startTime = new Date(body.startTime);
      if (body.endTime) updateData.endTime = new Date(body.endTime);
      if (body.notes !== undefined) updateData.notes = body.notes;

      const shift = await prisma.guardShift.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: updateData
      });

      if (shift.count === 0) {
        return res.status(404).json({ message: "Shift not found" });
      }

      return res.json({ message: "Shift updated" });
    } catch (error) {
      next(error);
    }
  }
);

// Delete shift
router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const shift = await prisma.guardShift.deleteMany({
        where: {
          id,
          societyId: req.auth!.societyId
        }
      });

      if (shift.count === 0) {
        return res.status(404).json({ message: "Shift not found" });
      }

      return res.json({ message: "Shift deleted" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
