import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { UserRole } from "@prisma/client";
import { validateBody } from "../../middlewares/validate";

const router = Router();

// Validation schemas
const createVillaSchema = z.object({
  villaNumber: z.string().min(1),
  floors: z.number().int().min(1).max(10),
  area: z.number().positive().optional(),
  block: z.string().optional(),
  ownerName: z.string().min(1),
  ownerEmail: z.string().email().optional(),
  ownerPhone: z.string().optional(),
  monthlyMaintenance: z.number().positive(),
});

const updateVillaSchema = z.object({
  floors: z.number().int().min(1).max(10).optional(),
  area: z.number().positive().optional(),
  block: z.string().optional(),
  ownerName: z.string().min(1).optional(),
  ownerEmail: z.string().email().optional(),
  ownerPhone: z.string().optional(),
  monthlyMaintenance: z.number().positive().optional(),
});

const bulkMaintenanceAmountSchema = z.object({
  defaultAmount: z.number().positive().optional(),
  overrides: z
    .array(
      z.object({
        villaId: z.string().cuid(),
        monthlyMaintenance: z.number().positive(),
      })
    )
    .optional()
    .default([]),
});

// GET /api/villas - List all villas
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const villas = await prisma.villa.findMany({
      where: { societyId },
      include: {
        users: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            moveInDate: true,
          },
        },
        _count: {
          select: {
            users: true,
            maintenance: { where: { status: "PENDING" } },
          },
        },
      },
      orderBy: { villaNumber: "asc" },
    });

    return res.json({ villas });
  } catch (error) {
    next(error);
  }
});

// GET /api/villas/:id - Get villa details
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const villa = await prisma.villa.findFirst({
      where: { id, societyId },
      include: {
        users: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            moveInDate: true,
            moveOutDate: true,
            isActive: true,
          },
        },
        maintenance: {
          orderBy: { createdAt: "desc" },
          take: 12,
        },
        maintenancePayments: {
          orderBy: { paymentDate: "desc" },
          take: 10,
          include: {
            bankAccount: {
              select: {
                bankName: true,
                accountNumber: true,
              },
            },
          },
        },
      },
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    return res.json({ villa });
  } catch (error) {
    next(error);
  }
});

// POST /api/villas - Create new villa
router.post(
  "/",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(createVillaSchema),
  async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const villa = await prisma.villa.create({
      data: {
        societyId,
        ...req.body,
      },
    });

    return res.status(201).json({ villa });
  } catch (error) {
    next(error);
  }
  }
);

// PATCH /api/villas/:id - Update villa
router.patch(
  "/:id",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(updateVillaSchema),
  async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const villa = await prisma.villa.updateMany({
      where: { id, societyId },
      data: req.body,
    });

    if (villa.count === 0) {
      return res.status(404).json({ message: "Villa not found" });
    }

    const updatedVilla = await prisma.villa.findUnique({
      where: { id },
    });

    return res.json({ villa: updatedVilla });
  } catch (error) {
    next(error);
  }
  }
);

// POST /api/villas/bulk-maintenance-amount - apply default and/or per-villa custom amounts
router.post(
  "/bulk-maintenance-amount",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(bulkMaintenanceAmountSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const { defaultAmount, overrides } =
        req.body as z.infer<typeof bulkMaintenanceAmountSchema>;

      if (defaultAmount == null && (!overrides || overrides.length === 0)) {
        return res.status(400).json({
          message: "Provide defaultAmount or at least one villa override",
        });
      }

      const overrideVillaIds = [...new Set((overrides ?? []).map((o) => o.villaId))];
      if (overrideVillaIds.length > 0) {
        const existing = await prisma.villa.findMany({
          where: { societyId, id: { in: overrideVillaIds } },
          select: { id: true },
        });
        const existingSet = new Set(existing.map((v) => v.id));
        const invalid = overrideVillaIds.filter((id) => !existingSet.has(id));
        if (invalid.length > 0) {
          return res.status(400).json({
            message: "Some villas are invalid for this society",
            invalidVillaIds: invalid,
          });
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        let defaultUpdated = 0;
        if (defaultAmount != null) {
          const upd = await tx.villa.updateMany({
            where: { societyId },
            data: { monthlyMaintenance: defaultAmount },
          });
          defaultUpdated = upd.count;
        }

        let overrideUpdated = 0;
        for (const row of overrides ?? []) {
          const upd = await tx.villa.updateMany({
            where: { societyId, id: row.villaId },
            data: { monthlyMaintenance: row.monthlyMaintenance },
          });
          overrideUpdated += upd.count;
        }

        return { defaultUpdated, overrideUpdated };
      });

      return res.json({
        message: "Maintenance amounts updated",
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/villas/:id - Delete villa
router.delete("/:id", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    // Check if villa has active residents
    const activeResidents = await prisma.user.count({
      where: { villaId: id, isActive: true },
    });

    if (activeResidents > 0) {
      return res.status(400).json({
        message: "Cannot delete villa with active residents. Please move out residents first.",
      });
    }

    await prisma.villa.deleteMany({
      where: { id, societyId },
    });

    return res.json({ message: "Villa deleted successfully" });
  } catch (error) {
    next(error);
  }
});

// GET /api/villas/:id/residents - Get villa residents
router.get("/:id/residents", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const residents = await prisma.user.findMany({
      where: {
        villaId: id,
        societyId,
        role: "RESIDENT",
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        moveInDate: true,
        moveOutDate: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { moveInDate: "desc" },
    });

    return res.json({ residents });
  } catch (error) {
    next(error);
  }
});

// GET /api/villas/:id/occupancy-history - Get move-in/out history
router.get("/:id/occupancy-history", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const history = await prisma.user.findMany({
      where: {
        villaId: id,
        societyId,
        role: "RESIDENT",
      },
      select: {
        id: true,
        name: true,
        email: true,
        moveInDate: true,
        moveOutDate: true,
        isActive: true,
      },
      orderBy: { moveInDate: "desc" },
    });

    return res.json({ history });
  } catch (error) {
    next(error);
  }
});

export default router;
