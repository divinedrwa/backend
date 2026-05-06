import { MaintenanceStatus, Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const generateSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020),
  amount: z.number().positive()
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(MaintenanceStatus)
});

router.use(requireAuth);

// Deep flow: generate monthly entries for each flat.
router.post(
  "/generate",
  requireRole(UserRole.ADMIN),
  validateBody(generateSchema),
  async (req, res, next) => {
    try {
      const { month, year, amount } = req.body as z.infer<typeof generateSchema>;

      const villas = await prisma.villa.findMany({
        where: { societyId: req.auth!.societyId },
        select: { id: true, monthlyMaintenance: true }
      });

      if (villas.length === 0) {
        return res.status(400).json({ message: "No villas available for generation" });
      }

      const dueDate = new Date(year, month - 1, 5); // 5th of the month
      
      const entries = villas.map((villa) => {
        const villaAmount = Number(villa.monthlyMaintenance);
        const resolvedAmount =
          villaAmount > 0 && Math.abs(villaAmount - amount) > 0.0001
            ? villaAmount
            : amount;
        return {
        societyId: req.auth!.societyId,
        villaId: villa.id,
        month,
        year,
        amount: new Prisma.Decimal(resolvedAmount),
        dueDate,
        status: MaintenanceStatus.PENDING
        };
      });

      await prisma.maintenance.createMany({
        data: entries,
        skipDuplicates: true
      });

      return res.json({ message: `Generated ${villas.length} maintenance entries` });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id/status",
  requireRole(UserRole.ADMIN),
  validateBody(updateStatusSchema),
  async (req, res, next) => {
    try {
      const { status } = req.body as z.infer<typeof updateStatusSchema>;
      const { id } = req.params;

      const updated = await prisma.maintenance.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: { status }
      });

      if (updated.count === 0) {
        return res.status(404).json({ message: "Maintenance record not found" });
      }

      return res.json({ message: "Status updated" });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/report", async (req, res, next) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);

    if (!month || !year || isNaN(month) || isNaN(year)) {
      return res.status(400).json({ message: "Valid month and year query parameters are required" });
    }

    if (month < 1 || month > 12) {
      return res.status(400).json({ message: "Month must be between 1 and 12" });
    }

    const records = await prisma.maintenance.findMany({
      where: {
        societyId: req.auth!.societyId,
        month,
        year
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
            ownerName: true
          }
        }
      }
    });

    const totals = records.reduce(
      (acc, row) => {
        const amount = Number(row.amount);
        acc.total += amount;
        if (row.status === MaintenanceStatus.PAID) {
          acc.paid += amount;
        } else {
          acc.pending += amount;
        }
        return acc;
      },
      { total: 0, paid: 0, pending: 0 }
    );

    return res.json({ month, year, totals, records });
  } catch (error) {
    next(error);
  }
});

export default router;
