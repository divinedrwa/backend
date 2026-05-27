import crypto from "crypto";
import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  Prisma,
  UserRole,
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import {
  clearExcludedResidentsUserCyclePayments,
} from "../../lib/maintenanceBillingRole";
import { prisma } from "../../lib/prisma";
import { validateBody } from "../../middlewares/validate";
import { syncAllUserCyclePaymentsForMaintenanceCycle } from "../billing-cycle/billing-collection-link";
import {
  notifySocietyMaintenanceLedgerUpdate,
  notifyVillaMaintenanceLedgerUpdate,
} from "../../lib/maintenanceLedgerNotify";
import { applyVillaCreditAcrossSnapshots, getVillaCreditBalancesBulk } from "./credit-walker";
import { refreshSnapshotStatus } from "./snapshot-helpers";

const router = Router();

const createFinancialYearSchema = z.object({
  label: z.string().min(2).max(80),
  startDate: z.string(),
  endDate: z.string(),
});

const createCycleSchema = z.object({
  financialYearId: z.string().min(1),
  periodKey: z.string().min(2).max(40),
  title: z.string().min(1).max(120),
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2000).max(2100),
  dueDate: z.string(),
});

const upsertRuleSchema = z.object({
  ruleType: z.enum(["FIXED_PER_FLAT", "PER_SQFT", "CUSTOM"]),
  baseAmount: z.number().nonnegative().optional(),
  perSqftRate: z.number().nonnegative().optional(),
  customAmounts: z.record(z.string(), z.number().nonnegative()).optional(),
});

const upsertVillaCustomAmountSchema = z.object({
  villaId: z.string().min(1),
  amount: z.number().nonnegative(),
});

const villaGridRowSchema = z
  .object({
    villaId: z.string().min(1),
    expectedAmount: z.number().nonnegative().optional(),
    paidAmount: z.number().nonnegative().optional(),
  })
  .refine((d) => d.expectedAmount !== undefined || d.paidAmount !== undefined, {
    message: "Provide expectedAmount and/or paidAmount",
  });

async function syncUserCyclePaymentsFromSnapshot(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    adminId: string;
    villaId: string;
    cycle: { financialYearId: string; periodKey: string };
    newPaid: number;
    snapStatus: string;
  }
): Promise<void> {
  const billingCycle = await tx.billingCycle.findFirst({
    where: {
      societyId: params.societyId,
      financialYearId: params.cycle.financialYearId,
      cycleKey: params.cycle.periodKey,
    },
    select: { id: true },
  });
  if (!billingCycle) return;

  await clearExcludedResidentsUserCyclePayments(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    billingCycleId: billingCycle.id,
  });

  const primaryResidents = await tx.user.findMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: UserRole.RESIDENT,
      isActive: true,
      maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
    },
    select: { id: true },
  });

  const payStatus =
    params.snapStatus === "PAID" || params.snapStatus === "WAIVED"
      ? BillingUserPaymentStatus.SUCCESS
      : BillingUserPaymentStatus.PENDING;
  const paidAt = new Date();

  for (const u of primaryResidents) {
    await tx.userCyclePayment.upsert({
      where: { userId_cycleId: { userId: u.id, cycleId: billingCycle.id } },
      create: {
        userId: u.id,
        cycleId: billingCycle.id,
        amountPaid: new Prisma.Decimal(params.newPaid),
        paymentStatus: payStatus,
        source: BillingPaymentSource.CASH_MANUAL,
        manualMarkedByAdminId: params.adminId,
        paidAt,
      },
      update: {
        amountPaid: new Prisma.Decimal(params.newPaid),
        paymentStatus: payStatus,
        source: BillingPaymentSource.CASH_MANUAL,
        manualMarkedByAdminId: params.adminId,
        paidAt,
      },
    });
  }
}

function parseCycleKey(cycleKey: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(cycleKey);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function parseDateOnly(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid date");
  }
  return d;
}

function computeExpectedForVilla(
  rule: {
    ruleType: "FIXED_PER_FLAT" | "PER_SQFT" | "CUSTOM";
    baseAmount: Prisma.Decimal | null;
    perSqftRate: Prisma.Decimal | null;
    customAmounts: Prisma.JsonValue | null;
  },
  villa: { id: string; area: Prisma.Decimal | null; monthlyMaintenance: Prisma.Decimal }
): { expected: number; breakdown: Record<string, unknown> } {
  switch (rule.ruleType) {
    case "FIXED_PER_FLAT": {
      const n = Number(rule.baseAmount ?? 0);
      return { expected: n, breakdown: { ruleType: rule.ruleType, baseAmount: n } };
    }
    case "PER_SQFT": {
      const rate = Number(rule.perSqftRate ?? 0);
      const area = villa.area != null ? Number(villa.area) : 0;
      if (area > 0) {
        const raw = rate * area;
        const expected = Math.round(raw * 100) / 100;
        return { expected, breakdown: { ruleType: rule.ruleType, perSqftRate: rate, area } };
      }
      const fallback = Number(villa.monthlyMaintenance);
      return {
        expected: fallback,
        breakdown: { ruleType: rule.ruleType, perSqftRate: rate, area: null, fallbackMonthlyMaintenance: fallback },
      };
    }
    case "CUSTOM": {
      const map = rule.customAmounts as Record<string, number> | null;
      const fromMap = map && typeof map === "object" ? map[villa.id] : undefined;
      const expected =
        fromMap != null && Number.isFinite(Number(fromMap))
          ? Number(fromMap)
          : Number(rule.baseAmount ?? villa.monthlyMaintenance);
      return {
        expected,
        breakdown: {
          ruleType: rule.ruleType,
          fromCustomMap: fromMap != null,
          baseAmount: Number(rule.baseAmount ?? 0),
        },
      };
    }
    default:
      return { expected: 0, breakdown: {} };
  }
}

// GET /api/maintenance-management/collection/financial-years
router.get("/financial-years", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const rows = await prisma.financialYear.findMany({
      where: { societyId },
      orderBy: { startDate: "desc" },
      include: {
        _count: { select: { cycles: true } },
      },
    });
    return res.json({
      financialYears: rows.map((fy) => ({
        id: fy.id,
        label: fy.label,
        startDate: fy.startDate,
        endDate: fy.endDate,
        status: fy.status,
        cycleCount: fy._count.cycles,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/maintenance-management/collection/financial-years
router.post("/financial-years", validateBody(createFinancialYearSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const body = req.body as z.infer<typeof createFinancialYearSchema>;
    const startDate = parseDateOnly(body.startDate);
    const endDate = parseDateOnly(body.endDate);
    if (startDate >= endDate) {
      return res.status(400).json({ message: "startDate must be before endDate" });
    }
    const fy = await prisma.financialYear.create({
      data: {
        societyId,
        label: body.label,
        startDate,
        endDate,
      },
    });
    return res.status(201).json({ financialYear: fy });
  } catch (e) {
    next(e);
  }
});

// GET /api/maintenance-management/collection/financial-years/:fyId/cycles
router.get("/financial-years/:fyId/cycles", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { fyId } = req.params;
    const fy = await prisma.financialYear.findFirst({ where: { id: fyId, societyId } });
    if (!fy) return res.status(404).json({ message: "Financial year not found" });

    const cycles = await prisma.maintenanceCollectionCycle.findMany({
      where: { financialYearId: fyId },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
      include: {
        rule: true,
        _count: { select: { snapshots: true } },
      },
    });

    return res.json({
      financialYear: { id: fy.id, label: fy.label },
      cycles: cycles.map((c) => ({
        id: c.id,
        periodKey: c.periodKey,
        title: c.title,
        periodMonth: c.periodMonth,
        periodYear: c.periodYear,
        dueDate: c.dueDate,
        status: c.status,
        hasRule: !!c.rule,
        snapshotCount: c._count.snapshots,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/maintenance-management/collection/cycles
router.post("/cycles", validateBody(createCycleSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const body = req.body as z.infer<typeof createCycleSchema>;
    const fy = await prisma.financialYear.findFirst({
      where: { id: body.financialYearId, societyId },
    });
    if (!fy) return res.status(404).json({ message: "Financial year not found" });

    const dueDate = parseDateOnly(body.dueDate);
    const cycle = await prisma.maintenanceCollectionCycle.create({
      data: {
        societyId,
        financialYearId: body.financialYearId,
        periodKey: body.periodKey,
        title: body.title,
        periodMonth: body.periodMonth,
        periodYear: body.periodYear,
        dueDate,
      },
    });
    return res.status(201).json({ cycle });
  } catch (e) {
    next(e);
  }
});

// PUT /api/maintenance-management/collection/cycles/:cycleId/rule
router.put("/cycles/:cycleId/rule", validateBody(upsertRuleSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { cycleId } = req.params;
    const body = req.body as z.infer<typeof upsertRuleSchema>;

    const cycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { id: cycleId, societyId },
    });
    if (!cycle) return res.status(404).json({ message: "Cycle not found" });
    if (cycle.status === "LOCKED") {
      return res.status(400).json({ message: "Cannot change rule on a locked cycle" });
    }

    if (body.ruleType === "FIXED_PER_FLAT" && body.baseAmount == null) {
      return res.status(400).json({ message: "baseAmount required for FIXED_PER_FLAT" });
    }
    if (body.ruleType === "PER_SQFT" && body.perSqftRate == null) {
      return res.status(400).json({ message: "perSqftRate required for PER_SQFT" });
    }
    const data = {
      ruleType: body.ruleType,
      baseAmount:
        body.baseAmount != null ? new Prisma.Decimal(body.baseAmount) : null,
      perSqftRate:
        body.perSqftRate != null ? new Prisma.Decimal(body.perSqftRate) : null,
      customAmounts: body.ruleType === "CUSTOM" ? body.customAmounts ?? {} : Prisma.JsonNull,
    };

    const rule = await prisma.maintenanceCycleRule.upsert({
      where: { cycleId },
      create: { cycleId, ...data },
      update: data,
    });

    return res.json({ rule });
  } catch (e) {
    next(e);
  }
});

// PUT /api/maintenance-management/collection/cycles/:cycleId/custom-amount
router.put(
  "/cycles/:cycleId/custom-amount",
  validateBody(upsertVillaCustomAmountSchema),
  async (req, res, next) => {
    try {
      const { societyId, userId: adminId } = req.auth!;
      const { cycleId } = req.params;
      const body = req.body as z.infer<typeof upsertVillaCustomAmountSchema>;

      const cycle = await prisma.maintenanceCollectionCycle.findFirst({
        where: { id: cycleId, societyId },
      });
      if (!cycle) return res.status(404).json({ message: "Cycle not found" });
      if (cycle.status !== "OPEN") {
        return res.status(400).json({ message: "Only OPEN cycles can be edited" });
      }
      const villa = await prisma.villa.findFirst({
        where: { id: body.villaId, societyId },
        select: { id: true, area: true, monthlyMaintenance: true },
      });
      if (!villa) return res.status(404).json({ message: "Villa not found" });
      const payCount = await prisma.maintenancePayment.count({
        where: { maintenanceCollectionCycleId: cycleId },
      });

      const [existingRule, linkedBillingCycle] = await Promise.all([
        prisma.maintenanceCycleRule.findUnique({
          where: { cycleId },
        }),
        prisma.billingCycle.findFirst({
          where: {
            societyId,
            financialYearId: cycle.financialYearId,
            cycleKey: cycle.periodKey,
          },
          select: { amount: true },
        }),
      ]);
      const baseAmount = Number(
        existingRule?.baseAmount ?? linkedBillingCycle?.amount ?? 0
      );
      const currentMap =
        existingRule?.ruleType === "CUSTOM" &&
        existingRule.customAmounts &&
        typeof existingRule.customAmounts === "object"
          ? ({ ...(existingRule.customAmounts as Record<string, number>) } as Record<string, number>)
          : {};
      const nextMap: Record<string, number> = { ...currentMap };
      if (Math.abs(body.amount - baseAmount) < 0.0001) {
        delete nextMap[body.villaId];
      } else {
        nextMap[body.villaId] = body.amount;
      }

      const rule = await prisma.maintenanceCycleRule.upsert({
        where: { cycleId },
        create: {
          cycleId,
          ruleType: "CUSTOM",
          baseAmount: new Prisma.Decimal(baseAmount),
          customAmounts: nextMap,
        },
        update: {
          ruleType: "CUSTOM",
          baseAmount: new Prisma.Decimal(baseAmount),
          customAmounts: nextMap,
          perSqftRate: null,
        },
      });

      if (payCount > 0) {
        const snapshot = await prisma.villaMaintenanceSnapshot.findUnique({
          where: { cycleId_villaId: { cycleId, villaId: body.villaId } },
        });
        if (!snapshot) {
          return res.status(400).json({
            message:
              "No billing snapshot for this villa. Open this month from Maintenance Payment Management to sync.",
          });
        }
        const newExpected = body.amount;
        const paidSoFar = Number(snapshot.paidAmount);
        if (paidSoFar > newExpected + 0.009) {
          return res.status(400).json({
            message: `This villa already has ₹${paidSoFar.toFixed(2)} recorded. New expected (₹${newExpected.toFixed(2)}) cannot be below collected amount — use Edit row to adjust paid amount first.`,
          });
        }
        const snapStatus = refreshSnapshotStatus(newExpected, paidSoFar, cycle.dueDate);
        const maintStatus =
          snapStatus === "PAID" ? "PAID" : snapStatus === "OVERDUE" ? "OVERDUE" : "PENDING";
        const { breakdown } = computeExpectedForVilla(
          {
            ruleType: "CUSTOM",
            baseAmount: rule.baseAmount,
            perSqftRate: rule.perSqftRate,
            customAmounts: rule.customAmounts,
          },
          villa
        );

        await prisma.$transaction(async (tx) => {
          await tx.villaMaintenanceSnapshot.update({
            where: { id: snapshot.id },
            data: {
              expectedAmount: new Prisma.Decimal(newExpected),
              status: snapStatus,
              breakdown: breakdown as Prisma.InputJsonValue,
            },
          });
          await tx.maintenance.upsert({
            where: {
              villaId_month_year: {
                villaId: body.villaId,
                month: cycle.periodMonth,
                year: cycle.periodYear,
              },
            },
            create: {
              societyId,
              villaId: body.villaId,
              month: cycle.periodMonth,
              year: cycle.periodYear,
              amount: new Prisma.Decimal(newExpected),
              dueDate: cycle.dueDate,
              status: maintStatus,
            },
            update: {
              amount: new Prisma.Decimal(newExpected),
              dueDate: cycle.dueDate,
              status: maintStatus,
            },
          });
          await syncUserCyclePaymentsFromSnapshot(tx, {
            societyId,
            adminId,
            villaId: body.villaId,
            cycle: { financialYearId: cycle.financialYearId, periodKey: cycle.periodKey },
            newPaid: paidSoFar,
            snapStatus,
          });
        });
      } else {
        const newExpected = body.amount;
        const snapStatus = refreshSnapshotStatus(newExpected, 0, cycle.dueDate);
        const { breakdown } = computeExpectedForVilla(
          {
            ruleType: "CUSTOM",
            baseAmount: rule.baseAmount,
            perSqftRate: rule.perSqftRate,
            customAmounts: rule.customAmounts,
          },
          villa,
        );
        await prisma.$transaction(async (tx) => {
          await tx.villaMaintenanceSnapshot.upsert({
            where: { cycleId_villaId: { cycleId, villaId: body.villaId } },
            create: {
              cycleId,
              villaId: body.villaId,
              expectedAmount: new Prisma.Decimal(newExpected),
              paidAmount: new Prisma.Decimal(0),
              status: snapStatus,
              breakdown: breakdown as Prisma.InputJsonValue,
            },
            update: {
              expectedAmount: new Prisma.Decimal(newExpected),
              status: snapStatus,
              breakdown: breakdown as Prisma.InputJsonValue,
            },
          });
          await syncUserCyclePaymentsFromSnapshot(tx, {
            societyId,
            adminId,
            villaId: body.villaId,
            cycle: { financialYearId: cycle.financialYearId, periodKey: cycle.periodKey },
            newPaid: 0,
            snapStatus,
          });
        });
        void notifyVillaMaintenanceLedgerUpdate({
          societyId,
          villaId: body.villaId,
          type: "MAINTENANCE_LEDGER_UPDATED",
          title: "Maintenance amount updated",
          body: `Your maintenance for ${cycle.periodKey} was updated by admin.`,
        });
      }

      return res.json({ rule });
    } catch (e) {
      next(e);
    }
  }
);

// PUT /api/maintenance-management/collection/cycles/:cycleId/villa-grid-row
// Adjust expected and/or collected amount on a villa row after payments exist (manual correction).
router.put(
  "/cycles/:cycleId/villa-grid-row",
  validateBody(villaGridRowSchema),
  async (req, res, next) => {
    try {
      const { societyId, userId: adminId } = req.auth!;
      const { cycleId } = req.params;
      const body = req.body as z.infer<typeof villaGridRowSchema>;

      const cycle = await prisma.maintenanceCollectionCycle.findFirst({
        where: { id: cycleId, societyId },
      });
      if (!cycle) return res.status(404).json({ message: "Cycle not found" });
      if (cycle.status !== "OPEN") {
        return res.status(400).json({ message: "Only OPEN cycles can be edited" });
      }

      const [snapshot, villa, villaExclusion] = await Promise.all([
        prisma.villaMaintenanceSnapshot.findUnique({
          where: { cycleId_villaId: { cycleId, villaId: body.villaId } },
        }),
        prisma.villa.findFirst({
          where: { id: body.villaId, societyId },
          select: { id: true, area: true, monthlyMaintenance: true },
        }),
        prisma.cycleVillaExclusion.findUnique({
          where: { cycleId_villaId: { cycleId, villaId: body.villaId } },
          select: { id: true },
        }),
      ]);
      if (!snapshot) {
        return res.status(400).json({ message: "No billing snapshot for this villa." });
      }
      if (!villa) return res.status(404).json({ message: "Villa not found" });
      if (villaExclusion) {
        return res.status(400).json({ message: "Villa is excluded from this cycle. Re-include it first." });
      }

      const e0 = Number(snapshot.expectedAmount);
      const p0 = Number(snapshot.paidAmount);
      const e1 = body.expectedAmount !== undefined ? body.expectedAmount : e0;
      const p1 = body.paidAmount !== undefined ? body.paidAmount : p0;

      let rule = await prisma.maintenanceCycleRule.findUnique({ where: { cycleId } });

      if (body.expectedAmount !== undefined) {
        const [existingRule, linkedBillingCycle] = await Promise.all([
          prisma.maintenanceCycleRule.findUnique({ where: { cycleId } }),
          prisma.billingCycle.findFirst({
            where: {
              societyId,
              financialYearId: cycle.financialYearId,
              cycleKey: cycle.periodKey,
            },
            select: { amount: true },
          }),
        ]);
        const baseAmount = Number(
          existingRule?.baseAmount ?? linkedBillingCycle?.amount ?? 0
        );
        const currentMap =
          existingRule?.ruleType === "CUSTOM" &&
          existingRule.customAmounts &&
          typeof existingRule.customAmounts === "object"
            ? ({ ...(existingRule.customAmounts as Record<string, number>) } as Record<string, number>)
            : {};
        const nextMap: Record<string, number> = { ...currentMap };
        if (Math.abs(body.expectedAmount - baseAmount) < 0.0001) {
          delete nextMap[body.villaId];
        } else {
          nextMap[body.villaId] = body.expectedAmount;
        }
        rule = await prisma.maintenanceCycleRule.upsert({
          where: { cycleId },
          create: {
            cycleId,
            ruleType: "CUSTOM",
            baseAmount: new Prisma.Decimal(baseAmount),
            customAmounts: nextMap,
          },
          update: {
            ruleType: "CUSTOM",
            baseAmount: new Prisma.Decimal(baseAmount),
            customAmounts: nextMap,
            perSqftRate: null,
          },
        });
      }

      const ruleForBreakdown =
        rule ?? (await prisma.maintenanceCycleRule.findUnique({ where: { cycleId } }));
      if (!ruleForBreakdown) {
        return res.status(400).json({ message: "Configure a maintenance rule for this cycle first." });
      }

      const snapStatus = refreshSnapshotStatus(e1, p1, cycle.dueDate);
      const maintStatus =
        snapStatus === "PAID" ? "PAID" : snapStatus === "OVERDUE" ? "OVERDUE" : "PENDING";

      const breakdownJson: Prisma.InputJsonValue =
        body.expectedAmount !== undefined
          ? (computeExpectedForVilla(
              {
                ruleType: ruleForBreakdown.ruleType as "FIXED_PER_FLAT" | "PER_SQFT" | "CUSTOM",
                baseAmount: ruleForBreakdown.baseAmount,
                perSqftRate: ruleForBreakdown.perSqftRate,
                customAmounts: ruleForBreakdown.customAmounts,
              },
              villa
            ).breakdown as Prisma.InputJsonValue)
          : ((snapshot.breakdown as Prisma.InputJsonValue) ?? Prisma.JsonNull);

      await prisma.$transaction(async (tx) => {
        await tx.villaMaintenanceSnapshot.update({
          where: { id: snapshot.id },
          data: {
            expectedAmount: new Prisma.Decimal(e1),
            paidAmount: new Prisma.Decimal(p1),
            status: snapStatus,
            breakdown: breakdownJson,
          },
        });
        await tx.maintenance.upsert({
          where: {
            villaId_month_year: {
              villaId: body.villaId,
              month: cycle.periodMonth,
              year: cycle.periodYear,
            },
          },
          create: {
            societyId,
            villaId: body.villaId,
            month: cycle.periodMonth,
            year: cycle.periodYear,
            amount: new Prisma.Decimal(e1),
            dueDate: cycle.dueDate,
            status: maintStatus,
          },
          update: {
            amount: new Prisma.Decimal(e1),
            dueDate: cycle.dueDate,
            status: maintStatus,
          },
        });
        await syncUserCyclePaymentsFromSnapshot(tx, {
          societyId,
          adminId,
          villaId: body.villaId,
          cycle: { financialYearId: cycle.financialYearId, periodKey: cycle.periodKey },
          newPaid: p1,
          snapStatus,
        });

        // ── Sync MaintenancePayment records so the credit walker stays consistent ──
        // When the admin changes paidAmount via the grid, we must make the MP
        // ledger match — otherwise the credit walker will re-derive paidAmount
        // from stale MP records and override the admin's edit.
        if (body.paidAmount !== undefined && Math.abs(p1 - p0) > 0.005) {
          const existingMPs = await tx.maintenancePayment.findMany({
            where: {
              societyId,
              villaId: body.villaId,
              maintenanceCollectionCycleId: cycleId,
            },
            select: { id: true, amount: true },
          });
          const existingTotal = existingMPs.reduce(
            (sum, mp) => sum + Number(mp.amount),
            0,
          );

          if (Math.abs(p1 - existingTotal) > 0.005) {
            // Delete all existing MP records for this (villa, cycle) and
            // replace with a single record at the admin's intended amount.
            if (existingMPs.length > 0) {
              await tx.maintenancePayment.deleteMany({
                where: {
                  id: { in: existingMPs.map((mp) => mp.id) },
                },
              });
            }
            if (p1 > 0.005) {
              const maintenanceRow = await tx.maintenance.findFirst({
                where: {
                  villaId: body.villaId,
                  month: cycle.periodMonth,
                  year: cycle.periodYear,
                  societyId,
                },
                select: { id: true },
              });
              await tx.maintenancePayment.create({
                data: {
                  societyId,
                  villaId: body.villaId,
                  maintenanceId: maintenanceRow?.id ?? null,
                  month: cycle.periodMonth,
                  year: cycle.periodYear,
                  amount: new Prisma.Decimal(p1),
                  paymentDate: new Date(),
                  paymentMode: "CASH",
                  receiptNumber: `ADJ-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
                  remarks: `Admin grid edit: collected adjusted from ${p0} to ${p1}`,
                  maintenanceCollectionCycleId: cycleId,
                  villaMaintenanceSnapshotId: snapshot.id,
                },
              });
            }
          }
        }
      });

      return res.json({
        message: "Row updated",
        expectedAmount: e1,
        paidAmount: p1,
        status: snapStatus,
      });
    } catch (e) {
      next(e);
    }
  }
);

// POST /api/maintenance-management/collection/billing-cycles/:billingCycleId/sync
// Ensures a maintenance collection cycle exists for a billing cycle and bootstraps snapshots.
router.post("/billing-cycles/:billingCycleId/sync", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { billingCycleId } = req.params;

    const billingCycle = await prisma.billingCycle.findFirst({
      where: { id: billingCycleId, societyId },
      select: {
        id: true,
        cycleKey: true,
        title: true,
        amount: true,
        paymentEndDate: true,
        status: true,
        financialYearId: true,
      },
    });
    if (!billingCycle) return res.status(404).json({ message: "Billing cycle not found" });
    if (!billingCycle.financialYearId) {
      return res.status(400).json({ message: "Billing cycle has no linked financial year" });
    }

    const parsed = parseCycleKey(billingCycle.cycleKey);
    const periodMonth = parsed?.month ?? billingCycle.paymentEndDate.getMonth() + 1;
    const periodYear = parsed?.year ?? billingCycle.paymentEndDate.getFullYear();
    const periodKey =
      parsed != null
        ? billingCycle.cycleKey
        : `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
    const dueDate = new Date(
      Date.UTC(
        billingCycle.paymentEndDate.getUTCFullYear(),
        billingCycle.paymentEndDate.getUTCMonth(),
        billingCycle.paymentEndDate.getUTCDate()
      )
    );

    const maintenanceCycle = await prisma.maintenanceCollectionCycle.upsert({
      where: {
        financialYearId_periodKey: {
          financialYearId: billingCycle.financialYearId,
          periodKey,
        },
      },
      create: {
        societyId,
        financialYearId: billingCycle.financialYearId,
        periodKey,
        title: billingCycle.title,
        periodMonth,
        periodYear,
        dueDate,
        status: billingCycle.status === "CLOSED" ? "CLOSED" : "OPEN",
      },
      update: {
        title: billingCycle.title,
        periodMonth,
        periodYear,
        dueDate,
        status: billingCycle.status === "CLOSED" ? "CLOSED" : "OPEN",
      },
    });

    const [existingRule, paymentCount] = await Promise.all([
      prisma.maintenanceCycleRule.findUnique({ where: { cycleId: maintenanceCycle.id } }),
      prisma.maintenancePayment.count({ where: { maintenanceCollectionCycleId: maintenanceCycle.id } }),
    ]);

    if (paymentCount === 0) {
      const [villas, syncExclusions] = await Promise.all([
        prisma.villa.findMany({
          where: { societyId },
          select: { id: true, area: true, monthlyMaintenance: true },
        }),
        prisma.cycleVillaExclusion.findMany({
          where: { cycleId: maintenanceCycle.id },
          select: { villaId: true },
        }),
      ]);
      const villaIds = new Set(villas.map((v) => v.id));
      const syncExcludedIds = new Set(syncExclusions.map((e) => e.villaId));

      let existingCustomOverrides =
        existingRule?.ruleType === "CUSTOM" &&
        existingRule.customAmounts &&
        typeof existingRule.customAmounts === "object"
          ? (existingRule.customAmounts as Record<string, number>)
          : {};
      if (
        Object.keys(existingCustomOverrides).length >= villas.length &&
        existingRule?.baseAmount == null
      ) {
        // Legacy cleanup: old code stored defaults as full custom map.
        existingCustomOverrides = {};
      }

      const cycleBaseAmount = Number(billingCycle.amount);
      const mergedCustomMap: Record<string, number> = {};
      for (const [villaId, amount] of Object.entries(existingCustomOverrides)) {
        if (
          villaIds.has(villaId) &&
          Number.isFinite(Number(amount)) &&
          Math.abs(Number(amount) - cycleBaseAmount) > 0.0001
        ) {
          mergedCustomMap[villaId] = Number(amount);
        }
      }

      const rule = await prisma.maintenanceCycleRule.upsert({
        where: { cycleId: maintenanceCycle.id },
        create: {
          cycleId: maintenanceCycle.id,
          ruleType: "CUSTOM",
          baseAmount: new Prisma.Decimal(cycleBaseAmount),
          customAmounts: mergedCustomMap,
        },
        update: {
          ruleType: "CUSTOM",
          baseAmount: new Prisma.Decimal(cycleBaseAmount),
          customAmounts: mergedCustomMap,
          perSqftRate: null,
        },
      });

      await prisma.villaMaintenanceSnapshot.deleteMany({
        where: { cycleId: maintenanceCycle.id },
      });
      const rows = villas.map((v) => {
        if (syncExcludedIds.has(v.id)) {
          return {
            cycleId: maintenanceCycle.id,
            villaId: v.id,
            expectedAmount: new Prisma.Decimal(0),
            paidAmount: new Prisma.Decimal(0),
            status: "WAIVED" as const,
            breakdown: { excluded: true } as Prisma.InputJsonValue,
          };
        }
        const { expected, breakdown } = computeExpectedForVilla(rule, v);
        const status = refreshSnapshotStatus(expected, 0, maintenanceCycle.dueDate);
        return {
          cycleId: maintenanceCycle.id,
          villaId: v.id,
          expectedAmount: new Prisma.Decimal(expected),
          paidAmount: new Prisma.Decimal(0),
          status,
          breakdown: breakdown as Prisma.InputJsonValue,
        };
      });
      if (rows.length > 0) {
        await prisma.villaMaintenanceSnapshot.createMany({ data: rows });
      }

      await prisma.$transaction(async (tx) => {
        await syncAllUserCyclePaymentsForMaintenanceCycle(tx, {
          societyId,
          maintenanceCycleId: maintenanceCycle.id,
          financialYearId: maintenanceCycle.financialYearId,
          periodKey: maintenanceCycle.periodKey,
          source: BillingPaymentSource.CASH_MANUAL,
        });
      });

      // Reconcile snapshots with any payments that were already recorded
      // against this cycle (e.g. retroactive mark-paid via billing before
      // the maintenance collection cycle existed). Without this, snapshots
      // stay at paidAmount=0 even though cash was received.
      const linkedPayments = await prisma.maintenancePayment.groupBy({
        by: ["villaId"],
        where: { maintenanceCollectionCycleId: maintenanceCycle.id },
        _sum: { amount: true },
      });
      const villasWithCash = linkedPayments
        .filter((p) => Number(p._sum.amount || 0) > 0.005)
        .map((p) => p.villaId);
      if (villasWithCash.length > 0) {
        await prisma.$transaction(async (tx) => {
          for (const villaId of villasWithCash) {
            await applyVillaCreditAcrossSnapshots(tx, {
              societyId,
              villaId,
              financialYearId: maintenanceCycle.financialYearId,
            });
          }
          await syncAllUserCyclePaymentsForMaintenanceCycle(tx, {
            societyId,
            maintenanceCycleId: maintenanceCycle.id,
            financialYearId: maintenanceCycle.financialYearId,
            periodKey: maintenanceCycle.periodKey,
            source: BillingPaymentSource.CASH_MANUAL,
          });
        });
      }
    }

    return res.json({
      maintenanceCollectionCycleId: maintenanceCycle.id,
      periodKey,
      periodMonth,
      periodYear,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/maintenance-management/collection/cycles/:cycleId/generate-snapshots
router.post("/cycles/:cycleId/generate-snapshots", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { cycleId } = req.params;

    const cycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { id: cycleId, societyId },
      include: { rule: true },
    });
    if (!cycle) return res.status(404).json({ message: "Cycle not found" });
    if (!cycle.rule) {
      return res.status(400).json({ message: "Configure a rule before generating snapshots" });
    }
    if (cycle.status !== "OPEN") {
      return res.status(400).json({ message: "Only OPEN cycles can (re)generate snapshots" });
    }

    const payCount = await prisma.maintenancePayment.count({
      where: { maintenanceCollectionCycleId: cycleId },
    });
    if (payCount > 0) {
      return res.status(409).json({ message: "Cannot regenerate: payments already recorded for this cycle" });
    }

    const [villas, genExclusions] = await Promise.all([
      prisma.villa.findMany({
        where: { societyId },
        select: { id: true, area: true, monthlyMaintenance: true },
      }),
      prisma.cycleVillaExclusion.findMany({
        where: { cycleId },
        select: { villaId: true },
      }),
    ]);
    const genExcludedIds = new Set(genExclusions.map((e) => e.villaId));

    await prisma.$transaction(async (tx) => {
      await tx.villaMaintenanceSnapshot.deleteMany({ where: { cycleId } });
      const rows = villas.map((v) => {
        if (genExcludedIds.has(v.id)) {
          return {
            cycleId,
            villaId: v.id,
            expectedAmount: new Prisma.Decimal(0),
            paidAmount: new Prisma.Decimal(0),
            status: "WAIVED" as const,
            breakdown: { excluded: true } as Prisma.InputJsonValue,
          };
        }
        const { expected, breakdown } = computeExpectedForVilla(cycle.rule!, v);
        const status = refreshSnapshotStatus(expected, 0, cycle.dueDate);
        return {
          cycleId,
          villaId: v.id,
          expectedAmount: new Prisma.Decimal(expected),
          paidAmount: new Prisma.Decimal(0),
          status,
          breakdown: breakdown as Prisma.InputJsonValue,
        };
      });
      if (rows.length > 0) {
        await tx.villaMaintenanceSnapshot.createMany({ data: rows });
      }
      await syncAllUserCyclePaymentsForMaintenanceCycle(tx, {
        societyId,
        maintenanceCycleId: cycleId,
        financialYearId: cycle.financialYearId,
        periodKey: cycle.periodKey,
        source: BillingPaymentSource.CASH_MANUAL,
      });
    });

    void notifySocietyMaintenanceLedgerUpdate({
      societyId,
      type: "MAINTENANCE_LEDGER_UPDATED",
      title: "Maintenance billing updated",
      body: `Billing for ${cycle.periodKey} was updated. Open Maintenance to review your dues.`,
    });

    const count = await prisma.villaMaintenanceSnapshot.count({ where: { cycleId } });
    return res.json({ message: "Snapshots generated", count });
  } catch (e) {
    next(e);
  }
});

// GET /api/maintenance-management/collection/cycles/:cycleId/grid
router.get("/cycles/:cycleId/grid", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { cycleId } = req.params;

    const cycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { id: cycleId, societyId },
    });
    if (!cycle) return res.status(404).json({ message: "Cycle not found" });

    const [villas, snapshots, payments, existingRule, exclusions] = await Promise.all([
      prisma.villa.findMany({
        where: { societyId },
        select: {
          id: true,
          villaNumber: true,
          block: true,
          ownerName: true,
          area: true,
          monthlyMaintenance: true,
        },
        orderBy: { villaNumber: "asc" },
      }),
      prisma.villaMaintenanceSnapshot.findMany({
        where: { cycleId },
        include: { villa: { select: { villaNumber: true, ownerName: true } } },
      }),
      prisma.maintenancePayment.findMany({
        where: { societyId, maintenanceCollectionCycleId: cycleId },
        orderBy: { paymentDate: "desc" },
      }),
      prisma.maintenanceCycleRule.findUnique({
        where: { cycleId },
      }),
      prisma.cycleVillaExclusion.findMany({
        where: { cycleId },
        select: { villaId: true },
      }),
    ]);

    const excludedVillaIds = new Set(exclusions.map((e) => e.villaId));

    let snapshotsRows = snapshots;
    if (snapshotsRows.length === 0) {
      if (payments.length > 0) {
        return res.status(409).json({
          message:
            "Cycle has payments but no snapshots. Please contact support to reconcile cycle data.",
        });
      }
      const bootstrapRule =
        existingRule ??
        (await prisma.maintenanceCycleRule.create({
          data: {
            cycleId,
            ruleType: "CUSTOM",
            customAmounts: Object.fromEntries(
              villas.map((v) => [v.id, Number(v.monthlyMaintenance)])
            ),
          },
        }));

      await prisma.$transaction(async (tx) => {
        const rows = villas.map((v) => {
          if (excludedVillaIds.has(v.id)) {
            return {
              cycleId,
              villaId: v.id,
              expectedAmount: new Prisma.Decimal(0),
              paidAmount: new Prisma.Decimal(0),
              status: "WAIVED" as const,
              breakdown: { excluded: true } as Prisma.InputJsonValue,
            };
          }
          const { expected, breakdown } = computeExpectedForVilla(bootstrapRule, v);
          const status = refreshSnapshotStatus(expected, 0, cycle.dueDate);
          return {
            cycleId,
            villaId: v.id,
            expectedAmount: new Prisma.Decimal(expected),
            paidAmount: new Prisma.Decimal(0),
            status,
            breakdown: breakdown as Prisma.InputJsonValue,
          };
        });
        if (rows.length > 0) {
          await tx.villaMaintenanceSnapshot.createMany({ data: rows });
        }
      });

      snapshotsRows = await prisma.villaMaintenanceSnapshot.findMany({
        where: { cycleId },
        include: { villa: { select: { villaNumber: true, ownerName: true } } },
      });
    }

    const snapByVilla = new Map(snapshotsRows.map((s) => [s.villaId, s]));
    const lastPayByVilla = new Map<string, (typeof payments)[0]>();
    for (const p of payments) {
      if (!lastPayByVilla.has(p.villaId)) lastPayByVilla.set(p.villaId, p);
    }

    // Compute per-villa advance credit balances for the financial year
    const creditBalances = await getVillaCreditBalancesBulk(prisma, {
      societyId,
      financialYearId: cycle.financialYearId,
    });

    // Sum actual cash payments per villa for this cycle (excludes credit-applied portion)
    const cashByVilla = new Map<string, number>();
    for (const p of payments) {
      cashByVilla.set(p.villaId, (cashByVilla.get(p.villaId) ?? 0) + Number(p.amount));
    }

    const villaPayments = villas.map((villa) => {
      const s = snapByVilla.get(villa.id)!;
      const pay = lastPayByVilla.get(villa.id);
      const expected = Number(s.expectedAmount);
      const paidAmt = Number(s.paidAmount);

      let uiStatus: "PAID" | "PENDING" | "OVERDUE" | "PARTIAL" = "PENDING";
      if (s.status === "PAID") uiStatus = "PAID";
      else if (s.status === "PARTIAL") uiStatus = "PARTIAL";
      else if (s.status === "OVERDUE") uiStatus = "OVERDUE";
      else if (s.status === "PENDING") uiStatus = "PENDING";

      let daysOverdue = 0;
      if (s.status === "OVERDUE" && cycle.dueDate) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(cycle.dueDate);
        due.setHours(0, 0, 0, 0);
        daysOverdue = Math.max(0, Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));
      }

      return {
        villaId: villa.id,
        villaNumber: villa.villaNumber,
        block: villa.block,
        ownerName: villa.ownerName,
        amount: expected,
        paidTowardCycle: paidAmt,
        status: uiStatus,
        daysOverdue,
        maintenanceId: null,
        dueDate: cycle.dueDate,
        paymentDate: pay?.paymentDate ?? null,
        receiptNumber: pay?.receiptNumber ?? null,
        paymentMode: pay?.paymentMode ?? null,
        snapshotId: s.id,
        advanceCredit: creditBalances.get(villa.id) ?? 0,
        cashPaidThisCycle: cashByVilla.get(villa.id) ?? 0,
        isExcluded: excludedVillaIds.has(villa.id),
      };
    });

    const activeSnapshots = snapshotsRows.filter((s) => !excludedVillaIds.has(s.villaId));
    const excludedCount = snapshotsRows.filter((s) => excludedVillaIds.has(s.villaId)).length;
    const totalAmount = activeSnapshots.reduce((sum, s) => sum + Number(s.expectedAmount), 0);
    const collectedAmount = activeSnapshots.reduce((sum, s) => sum + Number(s.paidAmount), 0);
    const paidCount = activeSnapshots.filter((s) => s.status === "PAID").length;
    const overdueCount = activeSnapshots.filter((s) => s.status === "OVERDUE").length;
    const partialCount = activeSnapshots.filter((s) => s.status === "PARTIAL").length;
    const unpaidCount = activeSnapshots.length - paidCount;

    const pendingAmount = Math.max(0, totalAmount - collectedAmount);
    const collectionRate =
      totalAmount > 0 ? Math.round((collectedAmount / totalAmount) * 100) : 0;

    return res.json({
      cycle: {
        id: cycle.id,
        title: cycle.title,
        periodMonth: cycle.periodMonth,
        periodYear: cycle.periodYear,
        dueDate: cycle.dueDate,
        status: cycle.status,
      },
      summary: {
        year: cycle.periodYear,
        month: cycle.periodMonth,
        totalVillas: villas.length,
        paidCount,
        unpaidCount,
        overdueCount,
        partialCount,
        excludedCount,
        totalAmount,
        collectedAmount,
        pendingAmount,
        collectionRate,
      },
      villaPayments,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/maintenance-management/collection/financial-years/:fyId/year-report
router.get("/financial-years/:fyId/year-report", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { fyId } = req.params;
    const fy = await prisma.financialYear.findFirst({ where: { id: fyId, societyId } });
    if (!fy) return res.status(404).json({ message: "Financial year not found" });

    const cycles = await prisma.maintenanceCollectionCycle.findMany({
      where: { financialYearId: fyId },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
      select: { id: true, periodMonth: true, periodYear: true, title: true },
    });

    const monthlyData: Array<{
      month: number;
      year: number;
      totalAmount: number;
      collected: number;
      pending: number;
      collectionRate: number;
      paymentCount: number;
      cycleId: string | null;
    }> = [];

    let yearlyTotal = 0;
    let yearlyCollected = 0;

    for (const c of cycles) {
      const snaps = await prisma.villaMaintenanceSnapshot.findMany({
        where: { cycleId: c.id },
        select: { expectedAmount: true, paidAmount: true },
      });
      const totalAmount = snaps.reduce((s, x) => s + Number(x.expectedAmount), 0);
      const collected = snaps.reduce((s, x) => s + Number(x.paidAmount), 0);
      const paymentCount = await prisma.maintenancePayment.count({
        where: { maintenanceCollectionCycleId: c.id },
      });
      const pending = Math.max(0, totalAmount - collected);
      const collectionRate =
        totalAmount > 0 ? Math.round((collected / totalAmount) * 100) : 0;
      yearlyTotal += totalAmount;
      yearlyCollected += collected;
      monthlyData.push({
        month: c.periodMonth,
        year: c.periodYear,
        totalAmount,
        collected,
        pending,
        collectionRate,
        paymentCount,
        cycleId: c.id,
      });
    }

    const yearlyPending = Math.max(0, yearlyTotal - yearlyCollected);
    const yearlyRate =
      yearlyTotal > 0 ? Math.round((yearlyCollected / yearlyTotal) * 100) : 0;

    return res.json({
      year: fy.label,
      financialYearId: fy.id,
      yearlyTotal,
      yearlyCollected,
      yearlyPending,
      yearlyRate,
      monthlyData,
    });
  } catch (e) {
    next(e);
  }
});

// ── Villa exclusion from cycle ──

const excludeVillaSchema = z.object({
  villaId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

// POST /api/maintenance-management/collection/cycles/:cycleId/exclude-villa
router.post(
  "/cycles/:cycleId/exclude-villa",
  validateBody(excludeVillaSchema),
  async (req, res, next) => {
    try {
      const { societyId, userId: adminId } = req.auth!;
      const { cycleId } = req.params;
      const body = req.body as z.infer<typeof excludeVillaSchema>;

      const cycle = await prisma.maintenanceCollectionCycle.findFirst({
        where: { id: cycleId, societyId },
      });
      if (!cycle) return res.status(404).json({ message: "Cycle not found" });
      if (cycle.status !== "OPEN") {
        return res.status(400).json({ message: "Only OPEN cycles can be edited" });
      }

      const villa = await prisma.villa.findFirst({
        where: { id: body.villaId, societyId },
        select: { id: true },
      });
      if (!villa) return res.status(404).json({ message: "Villa not found" });

      const existing = await prisma.cycleVillaExclusion.findUnique({
        where: { cycleId_villaId: { cycleId, villaId: body.villaId } },
      });
      if (existing) {
        return res.status(409).json({ message: "Villa is already excluded from this cycle" });
      }

      const paymentCount = await prisma.maintenancePayment.count({
        where: { maintenanceCollectionCycleId: cycleId, villaId: body.villaId },
      });
      if (paymentCount > 0) {
        return res.status(400).json({ message: "Cannot exclude: payments already recorded for this villa in this cycle" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.cycleVillaExclusion.create({
          data: {
            cycleId,
            villaId: body.villaId,
            reason: body.reason ?? null,
            excludedBy: adminId,
          },
        });

        await tx.villaMaintenanceSnapshot.upsert({
          where: { cycleId_villaId: { cycleId, villaId: body.villaId } },
          create: {
            cycleId,
            villaId: body.villaId,
            expectedAmount: new Prisma.Decimal(0),
            paidAmount: new Prisma.Decimal(0),
            status: "WAIVED",
            breakdown: { excluded: true } as Prisma.InputJsonValue,
          },
          update: {
            expectedAmount: new Prisma.Decimal(0),
            paidAmount: new Prisma.Decimal(0),
            status: "WAIVED",
            breakdown: { excluded: true } as Prisma.InputJsonValue,
          },
        });

        await syncUserCyclePaymentsFromSnapshot(tx, {
          societyId,
          adminId,
          villaId: body.villaId,
          cycle: { financialYearId: cycle.financialYearId, periodKey: cycle.periodKey },
          newPaid: 0,
          snapStatus: "WAIVED",
        });
      });

      return res.json({ message: "Villa excluded from this cycle" });
    } catch (e) {
      next(e);
    }
  }
);

// DELETE /api/maintenance-management/collection/cycles/:cycleId/exclude-villa/:villaId
router.delete(
  "/cycles/:cycleId/exclude-villa/:villaId",
  async (req, res, next) => {
    try {
      const { societyId, userId: adminId } = req.auth!;
      const { cycleId, villaId } = req.params;

      const cycle = await prisma.maintenanceCollectionCycle.findFirst({
        where: { id: cycleId, societyId },
      });
      if (!cycle) return res.status(404).json({ message: "Cycle not found" });
      if (cycle.status !== "OPEN") {
        return res.status(400).json({ message: "Only OPEN cycles can be edited" });
      }

      const exclusion = await prisma.cycleVillaExclusion.findUnique({
        where: { cycleId_villaId: { cycleId, villaId } },
      });
      if (!exclusion) {
        return res.status(404).json({ message: "No exclusion found for this villa in this cycle" });
      }

      const villa = await prisma.villa.findFirst({
        where: { id: villaId, societyId },
        select: { id: true, area: true, monthlyMaintenance: true },
      });
      if (!villa) return res.status(404).json({ message: "Villa not found" });

      const rule = await prisma.maintenanceCycleRule.findUnique({ where: { cycleId } });
      if (!rule) {
        return res.status(400).json({ message: "No rule configured for this cycle" });
      }

      const { expected, breakdown } = computeExpectedForVilla(rule, villa);
      const snapStatus = refreshSnapshotStatus(expected, 0, cycle.dueDate);

      await prisma.$transaction(async (tx) => {
        await tx.cycleVillaExclusion.delete({
          where: { cycleId_villaId: { cycleId, villaId } },
        });

        await tx.villaMaintenanceSnapshot.upsert({
          where: { cycleId_villaId: { cycleId, villaId } },
          create: {
            cycleId,
            villaId,
            expectedAmount: new Prisma.Decimal(expected),
            paidAmount: new Prisma.Decimal(0),
            status: snapStatus,
            breakdown: breakdown as Prisma.InputJsonValue,
          },
          update: {
            expectedAmount: new Prisma.Decimal(expected),
            paidAmount: new Prisma.Decimal(0),
            status: snapStatus,
            breakdown: breakdown as Prisma.InputJsonValue,
          },
        });

        await syncUserCyclePaymentsFromSnapshot(tx, {
          societyId,
          adminId,
          villaId,
          cycle: { financialYearId: cycle.financialYearId, periodKey: cycle.periodKey },
          newPaid: 0,
          snapStatus,
        });
      });

      return res.json({ message: "Villa re-included in this cycle", expectedAmount: expected, status: snapStatus });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
