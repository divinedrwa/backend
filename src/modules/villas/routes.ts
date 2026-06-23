import { Router } from "express";
import { z } from "zod";
import {
  ensureBillingAccountForProperty,
  normalizeDefaultUnitFlag,
  syncVillaOccupantUnits,
} from "../../lib/propertyInfrastructure";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { UserRole } from "@prisma/client";
import { RESIDENT_LIKE_ROLES } from "../../lib/residentLike";
import { validateBody } from "../../middlewares/validate";
import { auditFromRequest } from "../../services/audit.service";

const router = Router();

// Validation schemas
const unitInputSchema = z.object({
  unitCode: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

function assertUniqueUnitLabels(
  units: Array<{ label: string }> | undefined,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (!units?.length) return;
  const seen = new Set<string>();
  for (const u of units) {
    const t = u.label.trim().toLowerCase();
    if (!t) continue;
    if (seen.has(t)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate unit labels are not allowed (case-insensitive).",
        path,
      });
      return;
    }
    seen.add(t);
  }
}

const createVillaSchema = z
  .object({
    villaNumber: z.string().trim().min(1),
    floors: z.number().int().min(1).max(10),
    area: z.number().positive().optional(),
    block: z.string().trim().optional(),
    ownerName: z.string().trim().min(1),
    ownerEmail: z.string().trim().email().optional(),
    ownerPhone: z.string().trim().optional(),
    monthlyMaintenance: z.number().positive(),
    /** At least one occupant unit (e.g. suggested GF/FF or custom). No implicit `_DEFAULT` row. */
    units: z.array(unitInputSchema).min(1),
  })
  .superRefine((d, ctx) => assertUniqueUnitLabels(d.units, ctx, ["units"]));

const updateVillaSchema = z
  .object({
    floors: z.number().int().min(1).max(10).optional(),
    area: z.number().positive().optional(),
    block: z.string().trim().optional(),
    ownerName: z.string().trim().min(1).optional(),
    ownerEmail: z.string().trim().email().optional(),
    ownerPhone: z.string().trim().optional(),
    monthlyMaintenance: z.number().positive().optional(),
    /** Upsert units by `unitCode`. With `unitsSync`, removes units not listed and reassigns residents/visitors. */
    units: z.array(unitInputSchema).optional(),
    unitsSync: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.unitsSync === true && (!d.units || d.units.length < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "When unitsSync is true, provide at least one unit in `units`.",
        path: ["units"],
      });
    }
  })
  .superRefine((d, ctx) => {
    if (d.units?.length) assertUniqueUnitLabels(d.units, ctx, ["units"]);
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

// GET /api/villas - List all villas (?search= or ?q= filters villaNumber, block, ownerName)
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const pagination = getPagination(req);

    const rawSearch =
      typeof req.query.search === "string"
        ? req.query.search
        : typeof req.query.q === "string"
          ? req.query.q
          : "";
    const search = rawSearch.trim();

    const where =
      search.length > 0
        ? {
            societyId,
            OR: [
              { villaNumber: { contains: search, mode: "insensitive" as const } },
              { block: { contains: search, mode: "insensitive" as const } },
              { ownerName: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : { societyId };
    const [villas, total] = await Promise.all([
      prisma.villa.findMany({
        where,
        include: {
          users: {
            where: { isActive: true },
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              residentType: true,
              moveInDate: true,
              unitId: true,
              unit: { select: { id: true, unitCode: true, label: true } },
            },
          },
          units: { orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }] },
          billingAccount: { select: { id: true, scope: true, villaId: true } },
          _count: {
            select: {
              users: true,
              maintenance: { where: { status: "PENDING" } },
            },
          },
        },
        orderBy: { villaNumber: "asc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.villa.count({ where }),
    ]);

    return res.json({
      villas: villas.map((v) => ({
        ...v,
        propertyId: v.id,
      })),
      ...paginationMeta(total, villas.length, pagination),
    });
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
        units: { orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }] },
        billingAccount: { select: { id: true, scope: true, metadata: true } },
        users: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            residentType: true,
            unitId: true,
            unit: { select: { id: true, unitCode: true, label: true } },
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

    return res.json({ villa: { ...villa, propertyId: villa.id } });
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
    const body = req.body as z.infer<typeof createVillaSchema>;
    const { units: extraUnits, ...villaFields } = body;

    const villa = await prisma.$transaction(async (tx) => {
      const v = await tx.villa.create({
        data: {
          societyId,
          ...villaFields,
        },
      });
      await ensureBillingAccountForProperty(tx, { societyId, villaId: v.id });
      const ordered = [...(extraUnits ?? [])].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
      );
      for (let i = 0; i < ordered.length; i++) {
        const u = ordered[i]!;
        if (u.unitCode === "_DEFAULT") continue;
        await tx.unit.create({
          data: {
            societyId,
            villaId: v.id,
            unitCode: u.unitCode,
            label: u.label,
            sortOrder: u.sortOrder ?? i * 10,
            isDefault: i === 0,
          },
        });
      }
      await normalizeDefaultUnitFlag(tx, v.id);
      return tx.villa.findUniqueOrThrow({
        where: { id: v.id },
        include: {
          units: { orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }] },
          billingAccount: { select: { id: true, scope: true } },
        },
      });
    });

    return res.status(201).json({ villa: { ...villa, propertyId: villa.id } });
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
    const body = req.body as z.infer<typeof updateVillaSchema>;
    const { units: patchUnits, unitsSync, ...villaPatch } = body;

    const exists = await prisma.villa.findFirst({
      where: { id, societyId },
      select: { id: true },
    });
    if (!exists) {
      return res.status(404).json({ message: "Villa not found" });
    }

    if (Object.keys(villaPatch).length > 0) {
      await prisma.villa.updateMany({
        where: { id, societyId },
        data: villaPatch,
      });
    }

    if (patchUnits?.length) {
      try {
        if (unitsSync) {
          await prisma.$transaction(async (tx) => {
            await syncVillaOccupantUnits(tx, {
              societyId,
              villaId: id,
              units: patchUnits,
            });
          });
        } else {
          await prisma.$transaction(async (tx) => {
            for (const u of patchUnits) {
              if (u.unitCode === "_DEFAULT") {
                await tx.unit.updateMany({
                  where: { villaId: id, unitCode: "_DEFAULT" },
                  data: { label: u.label, sortOrder: u.sortOrder ?? 0 },
                });
                continue;
              }
              await tx.unit.upsert({
                where: { villaId_unitCode: { villaId: id, unitCode: u.unitCode } },
                create: {
                  societyId,
                  villaId: id,
                  unitCode: u.unitCode,
                  label: u.label,
                  sortOrder: u.sortOrder ?? 10,
                  isDefault: false,
                },
                update: {
                  label: u.label,
                  sortOrder: u.sortOrder ?? undefined,
                },
              });
            }
          });
          await normalizeDefaultUnitFlag(prisma, id);
        }
      } catch (e) {
        return res.status(400).json({
          message: e instanceof Error ? e.message : "Could not update occupant units",
        });
      }
    }

    await ensureBillingAccountForProperty(prisma, { societyId, villaId: id });

    const updatedVilla = await prisma.villa.findUnique({
      where: { id },
      include: {
        units: { orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }] },
        billingAccount: { select: { id: true, scope: true } },
      },
    });

    return res.json({
      villa: updatedVilla ? { ...updatedVilla, propertyId: updatedVilla.id } : updatedVilla,
    });
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
      where: { villaId: id, isActive: true, societyId },
    });

    if (activeResidents > 0) {
      return res.status(400).json({
        message: "Cannot delete villa with active residents. Please move out residents first.",
      });
    }

    await prisma.villa.deleteMany({
      where: { id, societyId },
    });

    auditFromRequest(req, {
      societyId,
      adminId: req.auth!.userId,
      action: "VILLA_DELETE",
      entityType: "Villa",
      entityId: id,
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
        role: { in: RESIDENT_LIKE_ROLES },
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
        role: { in: RESIDENT_LIKE_ROLES },
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
