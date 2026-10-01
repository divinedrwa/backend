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
import { Prisma, UserRole } from "@prisma/client";
import { localMonthKey } from "../../lib/societyTime";
import {
  excludeNonEnrolledVillasFromCycle,
  restoreReenrolledVillaCycles,
} from "../billing-cycle/billing-collection-link";
import { invalidateReconcileCache } from "../billing-cycle/services/resident-pending-dues";
import { getVillaCreditBalancesBulk } from "../maintenance-management/credit-walker";
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

const maintenanceEnrollmentSchema = z
  .object({
    villaIds: z.array(z.string().min(1)).min(1).max(500),
    enrolled: z.boolean(),
    /** Why billing stops (vacant, under construction, …) — required when stopping. */
    reason: z.string().trim().max(200).optional(),
  })
  .refine((b) => b.enrolled || (b.reason?.length ?? 0) >= 2, {
    message: "A reason is required to stop billing",
    path: ["reason"],
  });

const enrollmentPreviewSchema = z.object({
  villaIds: z.array(z.string().min(1)).min(1).max(500),
});

/** First collection period a stop/resume made now applies to: the next cycle not yet created. */
async function nextUncreatedCyclePeriod(societyId: string): Promise<string> {
  const latestCycle = await prisma.maintenanceCollectionCycle.findFirst({
    where: { societyId },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    select: { periodYear: true, periodMonth: true },
  });
  return latestCycle
    ? nextMonthKey(`${latestCycle.periodYear}-${String(latestCycle.periodMonth).padStart(2, "0")}`)
    : localMonthKey(new Date());
}

/**
 * What stopping billing leaves behind per villa: dues already raised (stay payable), advance
 * credit on record (kept; used when billing resumes) and residents who become visitor-only
 * once those dues are cleared.
 */
async function loadEnrollmentImpact(societyId: string, villaIds: string[]) {
  const [openSnapshots, credits, residents] = await Promise.all([
    prisma.villaMaintenanceSnapshot.findMany({
      where: { villaId: { in: villaIds }, cycle: { societyId }, status: { notIn: ["PAID", "WAIVED"] } },
      select: { villaId: true, expectedAmount: true, lateFeeAmount: true, paidAmount: true },
    }),
    getVillaCreditBalancesBulk(prisma, { societyId }),
    prisma.user.groupBy({
      by: ["villaId"],
      where: { societyId, villaId: { in: villaIds }, role: UserRole.RESIDENT, isActive: true },
      _count: { _all: true },
    }),
  ]);
  const oldDues = new Map<string, number>();
  for (const s of openSnapshots) {
    const remaining = Number(s.expectedAmount) + Number(s.lateFeeAmount ?? 0) - Number(s.paidAmount);
    if (remaining > 0) oldDues.set(s.villaId, (oldDues.get(s.villaId) ?? 0) + remaining);
  }
  const residentCount = new Map(residents.map((r) => [r.villaId, r._count._all]));
  const round = (n: number) => Math.round(n * 100) / 100;
  return new Map(
    villaIds.map((id) => [
      id,
      {
        oldDues: round(oldDues.get(id) ?? 0),
        advanceCredit: round(Math.max(0, credits.get(id) ?? 0)),
        residents: residentCount.get(id) ?? 0,
      },
    ]),
  );
}

function nextMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// GET /api/villas - List all villas (?search= or ?q= filters villaNumber, block, ownerName;
// ?maintenance=paying|not_paying filters by maintenance enrollment)
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
    const maintenanceFilter = req.query.maintenance;

    const where: Prisma.VillaWhereInput = { societyId };
    if (search.length > 0) {
      where.OR = [
        { villaNumber: { contains: search, mode: "insensitive" } },
        { block: { contains: search, mode: "insensitive" } },
        { ownerName: { contains: search, mode: "insensitive" } },
      ];
    }
    if (maintenanceFilter === "paying") where.maintenanceExemptFromPeriod = null;
    if (maintenanceFilter === "not_paying") where.maintenanceExemptFromPeriod = { not: null };
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
        orderBy: [{ block: "asc" }, { villaNumber: "asc" }, { id: "asc" }],
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

// POST /api/villas/maintenance-enrollment/preview - what stopping billing would leave per villa
// (old dues, advance credit, residents affected) so the admin sees it before confirming.
router.post(
  "/maintenance-enrollment/preview",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(enrollmentPreviewSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const ids = [...new Set((req.body as z.infer<typeof enrollmentPreviewSchema>).villaIds)];
      const villas = await prisma.villa.findMany({
        where: { societyId, id: { in: ids } },
        select: { id: true, villaNumber: true, block: true },
      });
      const villaIds = villas.map((v) => v.id);
      const [fromPeriod, impact] = await Promise.all([
        nextUncreatedCyclePeriod(societyId),
        loadEnrollmentImpact(societyId, villaIds),
      ]);
      return res.json({
        fromPeriod,
        villas: villas.map((v) => ({ villaId: v.id, villaNumber: v.villaNumber, block: v.block, ...impact.get(v.id)! })),
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/villas/maintenance-enrollment - mark villas as paying / not paying maintenance.
// Takes effect from the next collection cycle not yet created; dues already raised stay payable.
router.post(
  "/maintenance-enrollment",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(maintenanceEnrollmentSchema),
  async (req, res, next) => {
    try {
      const { societyId, userId } = req.auth!;
      const { villaIds, enrolled, reason } = req.body as z.infer<typeof maintenanceEnrollmentSchema>;
      const ids = [...new Set(villaIds)];

      const villas = await prisma.villa.findMany({
        where: { societyId, id: { in: ids } },
        select: { id: true, villaNumber: true, maintenanceExemptFromPeriod: true },
      });
      if (villas.length !== ids.length) {
        const found = new Set(villas.map((v) => v.id));
        return res.status(400).json({
          message: "Some villas are invalid for this society",
          invalidVillaIds: ids.filter((id) => !found.has(id)),
        });
      }

      const currentPeriod = localMonthKey(new Date());
      // A month's cycle is created after the month ends (September's on ~1 October), so
      // "from next calendar month" still billed a villa switched off during September for
      // September. The change applies from the next cycle that has not been created yet.
      const fromPeriod = await nextUncreatedCyclePeriod(societyId);
      const changing = villas.filter((v) =>
        enrolled ? v.maintenanceExemptFromPeriod != null : v.maintenanceExemptFromPeriod == null,
      );
      const changingIds = changing.map((v) => v.id);

      // A villa that was never billed has no dues to keep, so it stops from this month at
      // the latest (e.g. a newly added villa); villas already billed stop from the next
      // cycle not yet created.
      const billedVillaIds = new Set<string>();
      if (!enrolled && changingIds.length > 0) {
        const billed = await prisma.villaMaintenanceSnapshot.findMany({
          where: { villaId: { in: changingIds }, expectedAmount: { gt: 0 } },
          select: { villaId: true },
          distinct: ["villaId"],
        });
        billed.forEach((s) => billedVillaIds.add(s.villaId));
      }
      const neverBilledFrom = currentPeriod < fromPeriod ? currentPeriod : fromPeriod;
      const stopPeriodFor = (villaId: string) =>
        billedVillaIds.has(villaId) ? fromPeriod : neverBilledFrom;

      const futureCycleRowsUpdated = await prisma.$transaction(
        async (tx) => {
          if (changingIds.length === 0) return 0;
          let rows = 0;
          if (!enrolled) {
            const groups = new Map<string, string[]>();
            for (const id of changingIds) {
              const period = stopPeriodFor(id);
              groups.set(period, [...(groups.get(period) ?? []), id]);
            }
            for (const [period, groupIds] of groups) {
              const [year, month] = period.split("-").map(Number);
              await tx.villa.updateMany({
                where: { id: { in: groupIds } },
                data: { maintenanceExemptFromPeriod: period, maintenanceExemptReason: reason ?? null },
              });
              const futureCycles = await tx.maintenanceCollectionCycle.findMany({
                where: {
                  societyId,
                  OR: [
                    { periodYear: { gt: year } },
                    { periodYear: year, periodMonth: { gte: month } },
                  ],
                },
                select: { id: true },
              });
              for (const c of futureCycles) {
                const excluded = await excludeNonEnrolledVillasFromCycle(tx, {
                  societyId,
                  maintenanceCycleId: c.id,
                  villaIds: groupIds,
                });
                rows += excluded.length;
              }
            }
          } else {
            for (const villaId of changingIds) {
              rows += await restoreReenrolledVillaCycles(tx, { societyId, villaId, fromPeriod });
            }
            await tx.villa.updateMany({
              where: { id: { in: changingIds } },
              data: { maintenanceExemptFromPeriod: null, maintenanceExemptReason: null },
            });
          }
          return rows;
        },
        { timeout: 60_000 },
      );

      const effectiveFromPeriod =
        !enrolled && changingIds.length > 0 && changingIds.every((id) => !billedVillaIds.has(id))
          ? neverBilledFrom
          : fromPeriod;

      changingIds.forEach(invalidateReconcileCache);
      if (changingIds.length > 0) {
        // One entry per villa so each villa's history shows its own stop / resume record,
        // with the dues and advance credit it had at that moment.
        const impact = enrolled ? null : await loadEnrollmentImpact(societyId, changingIds);
        for (const v of changing) {
          auditFromRequest(req, {
            societyId,
            adminId: userId,
            action: enrolled ? "VILLA_MAINTENANCE_ENROLLED" : "VILLA_MAINTENANCE_UNENROLLED",
            entityType: "Villa",
            entityId: v.id,
            metadata: {
              villaNumbers: [v.villaNumber],
              effectiveFromPeriod: enrolled ? fromPeriod : stopPeriodFor(v.id),
              ...(enrolled ? {} : { reason, ...impact?.get(v.id) }),
              batchSize: changing.length,
            },
          });
        }
      }

      return res.json({
        message: enrolled
          ? `Maintenance billing resumes from ${fromPeriod}`
          : `Maintenance billing stops from ${effectiveFromPeriod}; existing dues stay payable`,
        updated: changingIds.length,
        unchanged: ids.length - changingIds.length,
        effectiveFromPeriod,
        futureCycleRowsUpdated,
      });
    } catch (error) {
      next(error);
    }
  },
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
