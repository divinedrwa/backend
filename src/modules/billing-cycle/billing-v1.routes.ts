import { Router } from "express";
import { z } from "zod";
import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  NotificationCategory,
  UserRole,
} from "@prisma/client";
import PDFDocument from "pdfkit";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { clearExcludedResidentsUserCyclePayments } from "../../lib/maintenanceBillingRole";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  ensureVillaLedgersAligned,
  postMarkCashToMaintenanceLedger,
} from "./billing-collection-link";
import { deriveCycleStatusUtc } from "./domain/cycleStatus";
import {
  buildCurrentCycleResponse,
  computeUserBillingLedger,
  invalidateDisplayCycleHint,
  syncAllBillingCycleStatuses,
} from "./services/cycle-service";
import { writeAdminAuditLog } from "./services/audit-log";
import { notifyVillaMaintenanceLedgerUpdate } from "../../lib/maintenanceLedgerNotify";
import { notifySociety } from "../../services/notification.service";
import phonePeRoutes from "./billing-v1-phonepe.routes";
import razorpayRoutes from "./billing-v1-razorpay.routes";

const router = Router();

function mustMatchSociety(authSociety: string, requested: string): boolean {
  return authSociety === requested;
}

// --- GET /api/v1/cycles/current ---
router.get("/cycles/current", requireAuth, async (req, res, next) => {
  try {
    const societyId = typeof req.query.societyId === "string" ? req.query.societyId : "";
    if (!societyId) {
      res.status(400).json({ message: "societyId is required" });
      return;
    }
    const { societyId: authSociety, userId, role } = req.auth!;
    if (!mustMatchSociety(authSociety, societyId)) {
      res.status(403).json({ message: "societyId mismatch" });
      return;
    }
    if (role === UserRole.RESIDENT) {
      /* ok */
    } else if (role === UserRole.ADMIN) {
      /* ok */
    } else {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    const billingCycleId =
      typeof req.query.billingCycleId === "string" ? req.query.billingCycleId.trim() : "";
    try {
      const payload = await buildCurrentCycleResponse({
        societyId,
        userId,
        billingCycleId: billingCycleId || undefined,
      });
      res.json(payload);
    } catch (err) {
      if (err instanceof Error && err.message === "BILLING_CYCLE_NOT_FOUND") {
        res.status(404).json({ message: "Billing cycle not found" });
        return;
      }
      throw err;
    }
  } catch (e) {
    next(e);
  }
});

const createCycleSchema = z.object({
  societyId: z.string().optional(),
  financialYearId: z.string().min(1),
  cycleMonth: z.string().regex(/^\d{4}-\d{2}$/),
  title: z.string().min(1).max(200),
  amount: z.number().positive(),
  paymentStartDate: z.string().datetime(),
  paymentEndDate: z.string().datetime(),
  lateFee: z.number().min(0),
  gracePeriodDays: z.number().int().min(0).max(365),
});

router.post(
  "/admin/cycles",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(createCycleSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createCycleSchema>;
      const {
        financialYearId,
        cycleMonth,
        title,
        amount,
        paymentStartDate,
        paymentEndDate,
        lateFee,
        gracePeriodDays,
      } = body;
      const auth = req.auth!;
      // societyId is the only field that gets defaulted from the auth
      // context, so it stays mutable while everything else is `const`.
      let societyId = body.societyId;
      if (!societyId) {
        societyId = auth.societyId;
      }
      if (!mustMatchSociety(auth.societyId, societyId)) {
        res.status(403).json({ message: "societyId mismatch" });
        return;
      }
      const fy = await prisma.financialYear.findFirst({
        where: { id: financialYearId, societyId },
        select: { id: true, startDate: true, endDate: true, label: true },
      });
      if (!fy) {
        res.status(404).json({ message: "Financial year not found" });
        return;
      }

      const [yearStr, monthStr] = cycleMonth.split("-");
      const y = Number(yearStr);
      const m = Number(monthStr);
      const startDate = new Date(Date.UTC(y, m - 1, 1));
      const endDate = new Date(Date.UTC(y, m, 0));
      if (startDate < fy.startDate || endDate > fy.endDate) {
        res.status(400).json({
          message: `Selected month is outside financial year ${fy.label}`,
        });
        return;
      }

      const pStart = new Date(paymentStartDate);
      const pEnd = new Date(paymentEndDate);
      const status = deriveCycleStatusUtc(new Date(), pStart, pEnd);

      const existing = await prisma.billingCycle.findUnique({
        where: { societyId_cycleKey: { societyId, cycleKey: cycleMonth } },
      });
      if (existing) {
        res.status(409).json({ message: "Cycle already exists for this month" });
        return;
      }

      const cycle = await prisma.billingCycle.create({
        data: {
          societyId,
          financialYearId,
          cycleKey: cycleMonth,
          title,
          amount,
          startDate,
          endDate,
          paymentStartDate: pStart,
          paymentEndDate: pEnd,
          lateFee,
          gracePeriodDays,
          status,
        },
      });

      await invalidateDisplayCycleHint(societyId);
      await writeAdminAuditLog({
        societyId,
        adminId: auth.userId,
        action: "billing_cycle.create",
        entityType: "BillingCycle",
        entityId: cycle.id,
        metadata: { cycleKey: cycleMonth, financialYearId },
      });

      await syncAllBillingCycleStatuses();

      try {
        await notifySociety(
          societyId,
          {
            title: "New maintenance billing cycle",
            body: `${title} (${cycleMonth}) has been generated. Please review and pay within the cycle window.`,
            data: {
              type: "BILLING_CYCLE_CREATED",
              cycleId: cycle.id,
              cycleKey: cycleMonth,
            },
          },
          UserRole.RESIDENT,
          { category: NotificationCategory.MAINTENANCE },
        );
      } catch (notifyErr) {
        logger.error({ err: notifyErr }, "[billing-cycle.create] resident notify failed");
      }

      res.status(201).json({ cycle });
    } catch (e) {
      next(e);
    }
  }
);

const updateCycleSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  amount: z.number().positive().optional(),
  paymentStartDate: z.string().datetime().optional(),
  paymentEndDate: z.string().datetime().optional(),
  lateFee: z.number().min(0).optional(),
  gracePeriodDays: z.number().int().min(0).max(365).optional(),
});

router.put(
  "/admin/cycles/:id",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(updateCycleSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const auth = req.auth!;
      const body = req.body as z.infer<typeof updateCycleSchema>;

      const found = await prisma.billingCycle.findFirst({ where: { id, societyId: auth.societyId } });
      if (!found) {
        res.status(404).json({ message: "Cycle not found" });
        return;
      }

      const data: Parameters<typeof prisma.billingCycle.update>[0]["data"] = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.amount !== undefined) data.amount = body.amount;
      if (body.lateFee !== undefined) data.lateFee = body.lateFee;
      if (body.gracePeriodDays !== undefined) data.gracePeriodDays = body.gracePeriodDays;
      if (body.paymentStartDate !== undefined) data.paymentStartDate = new Date(body.paymentStartDate);
      if (body.paymentEndDate !== undefined) data.paymentEndDate = new Date(body.paymentEndDate);

      if (body.paymentStartDate !== undefined || body.paymentEndDate !== undefined) {
        const pStart = body.paymentStartDate ? new Date(body.paymentStartDate) : found.paymentStartDate;
        const pEnd = body.paymentEndDate ? new Date(body.paymentEndDate) : found.paymentEndDate;
        data.status = deriveCycleStatusUtc(new Date(), pStart, pEnd);
      }

      const cycle = await prisma.billingCycle.update({
        where: { id },
        data,
      });

      await invalidateDisplayCycleHint(auth.societyId);
      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing_cycle.update",
        entityType: "BillingCycle",
        entityId: id,
        metadata: body as Record<string, unknown>,
      });
      await syncAllBillingCycleStatuses();
      res.json({ cycle });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  "/admin/cycles/:id",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { id } = req.params;
      const found = await prisma.billingCycle.findFirst({
        where: { id, societyId: auth.societyId },
      });
      if (!found) {
        res.status(404).json({ message: "Cycle not found" });
        return;
      }

      const paymentCount = await prisma.userCyclePayment.count({
        where: { cycleId: id },
      });
      if (paymentCount > 0) {
        res.status(409).json({
          message: "Cannot delete cycle with payment records. Close it instead.",
        });
        return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.billingLateFeeWaiver.deleteMany({ where: { cycleId: id } });
        await tx.billingPaymentLog.deleteMany({ where: { cycleId: id } });
        await tx.billingCycle.delete({ where: { id } });
      });

      await invalidateDisplayCycleHint(auth.societyId);
      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing_cycle.delete",
        entityType: "BillingCycle",
        entityId: id,
        metadata: { cycleKey: found.cycleKey, title: found.title },
      });
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Financial years for the authenticated society (read-only).
 * Used by admin billing UI and resident mobile to pick a year before choosing a billing cycle month.
 */
router.get(
  "/financial-years",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const rows = await prisma.financialYear.findMany({
        where: { societyId: auth.societyId },
        orderBy: { startDate: "desc" },
        select: {
          id: true,
          label: true,
          startDate: true,
          endDate: true,
          status: true,
        },
      });
      res.json({ financialYears: rows });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Billing cycles that exist for a financial year (same source as web "Billing cycles").
 * Query: financialYearId (required). Residents only see their society's data via JWT.
 */
router.get(
  "/billing-cycles",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const financialYearId =
        typeof req.query.financialYearId === "string" ? req.query.financialYearId.trim() : "";
      if (!financialYearId) {
        res.status(400).json({ message: "financialYearId is required" });
        return;
      }
      const fy = await prisma.financialYear.findFirst({
        where: { id: financialYearId, societyId: auth.societyId },
        select: { id: true, label: true },
      });
      if (!fy) {
        res.status(404).json({ message: "Financial year not found" });
        return;
      }
      const cycles = await prisma.billingCycle.findMany({
        where: { societyId: auth.societyId, financialYearId },
        orderBy: { cycleKey: "asc" },
        select: {
          id: true,
          cycleKey: true,
          title: true,
          amount: true,
          paymentStartDate: true,
          paymentEndDate: true,
          lateFee: true,
          gracePeriodDays: true,
        },
      });
      const nowUtc = new Date();
      const rows = cycles.map((c) => ({
        id: c.id,
        cycleKey: c.cycleKey,
        title: c.title,
        amount: Number(c.amount),
        status: deriveCycleStatusUtc(nowUtc, c.paymentStartDate, c.paymentEndDate),
        paymentStartDate: c.paymentStartDate.toISOString(),
        paymentEndDate: c.paymentEndDate.toISOString(),
        lateFee: Number(c.lateFee),
        gracePeriodDays: c.gracePeriodDays,
      }));
      res.json({
        financialYear: { id: fy.id, label: fy.label },
        cycles: rows,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Resolve a billing cycle to its financial year (same society as JWT).
 * Used for deep links that only pass `billingCycleId` (no month/year).
 */
router.get(
  "/billing-cycles/context",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const billingCycleId =
        typeof req.query.billingCycleId === "string" ? req.query.billingCycleId.trim() : "";
      if (!billingCycleId) {
        res.status(400).json({ message: "billingCycleId is required" });
        return;
      }
      const cycle = await prisma.billingCycle.findFirst({
        where: { id: billingCycleId, societyId: auth.societyId },
        select: {
          id: true,
          cycleKey: true,
          title: true,
          financialYearId: true,
          financialYear: { select: { id: true, label: true } },
        },
      });
      if (!cycle?.financialYearId || !cycle.financialYear) {
        res.status(404).json({ message: "Billing cycle not found" });
        return;
      }
      res.json({
        financialYear: { id: cycle.financialYear.id, label: cycle.financialYear.label },
        billingCycle: {
          id: cycle.id,
          cycleKey: cycle.cycleKey,
          title: cycle.title,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get("/admin/cycles", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const cycles = await prisma.billingCycle.findMany({
      where: { societyId: auth.societyId },
      orderBy: { paymentStartDate: "desc" },
      take: 120,
      include: {
        financialYear: { select: { id: true, label: true } },
      },
    });

    const residentCount = await prisma.user.count({
      where: { societyId: auth.societyId, role: UserRole.RESIDENT, isActive: true },
    });

    const rows = await Promise.all(
      cycles.map(async (c) => {
        const paidCount = await prisma.userCyclePayment.count({
          where: { cycleId: c.id, paymentStatus: BillingUserPaymentStatus.SUCCESS },
        });
        return {
          id: c.id,
          cycleKey: c.cycleKey,
          month: c.cycleKey,
          financialYearId: c.financialYearId,
          financialYearLabel: c.financialYear?.label ?? null,
          title: c.title,
          amount: Number(c.amount),
          status: deriveCycleStatusUtc(new Date(), c.paymentStartDate, c.paymentEndDate),
          storedStatus: c.status,
          paymentStartDate: c.paymentStartDate.toISOString(),
          paymentEndDate: c.paymentEndDate.toISOString(),
          paymentWindow: `${c.paymentStartDate.toISOString()} — ${c.paymentEndDate.toISOString()}`,
          paidUsersCount: paidCount,
          pendingUsersCount: Math.max(0, residentCount - paidCount),
          lateFee: Number(c.lateFee),
          gracePeriodDays: c.gracePeriodDays,
        };
      })
    );

    res.json({ cycles: rows, residentCount });
  } catch (e) {
    next(e);
  }
});

const createFinancialYearSchema = z.object({
  label: z.string().min(2).max(80),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

router.post(
  "/admin/financial-years",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(createFinancialYearSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const body = req.body as z.infer<typeof createFinancialYearSchema>;
      const startDate = new Date(body.startDate);
      const endDate = new Date(body.endDate);
      if (startDate >= endDate) {
        res.status(400).json({ message: "startDate must be before endDate" });
        return;
      }
      const fy = await prisma.financialYear.create({
        data: {
          societyId: auth.societyId,
          label: body.label,
          startDate,
          endDate,
        },
      });

      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "financial_year.create",
        entityType: "FinancialYear",
        entityId: fy.id,
        metadata: { label: body.label, startDate: body.startDate, endDate: body.endDate },
      });

      res.status(201).json({ financialYear: fy });
    } catch (e) {
      next(e);
    }
  }
);

router.get("/admin/financial-years", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const rows = await prisma.financialYear.findMany({
      where: { societyId: auth.societyId },
      orderBy: { startDate: "desc" },
      select: {
        id: true,
        label: true,
        startDate: true,
        endDate: true,
        status: true,
      },
    });
    res.json({ financialYears: rows });
  } catch (e) {
    next(e);
  }
});

const updateFinancialYearSchema = z.object({
  label: z.string().min(2).max(80),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

router.put(
  "/admin/financial-years/:id",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(updateFinancialYearSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { id } = req.params;
      const body = req.body as z.infer<typeof updateFinancialYearSchema>;
      const found = await prisma.financialYear.findFirst({
        where: { id, societyId: auth.societyId },
      });
      if (!found) {
        res.status(404).json({ message: "Financial year not found" });
        return;
      }
      const startDate = new Date(body.startDate);
      const endDate = new Date(body.endDate);
      if (startDate >= endDate) {
        res.status(400).json({ message: "startDate must be before endDate" });
        return;
      }

      const updated = await prisma.financialYear.update({
        where: { id },
        data: {
          label: body.label,
          startDate,
          endDate,
        },
      });

      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "financial_year.update",
        entityType: "FinancialYear",
        entityId: id,
        metadata: { label: body.label, startDate: body.startDate, endDate: body.endDate },
      });

      res.json({ financialYear: updated });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  "/admin/financial-years/:id",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { id } = req.params;
      const found = await prisma.financialYear.findFirst({
        where: { id, societyId: auth.societyId },
      });
      if (!found) {
        res.status(404).json({ message: "Financial year not found" });
        return;
      }

      const [legacyCycleCount, collectionCycleCount] = await Promise.all([
        prisma.billingCycle.count({ where: { financialYearId: id } }),
        prisma.maintenanceCollectionCycle.count({ where: { financialYearId: id } }),
      ]);
      if (legacyCycleCount > 0 || collectionCycleCount > 0) {
        res.status(409).json({
          message: "Cannot delete financial year with billing cycles. Delete cycles first.",
        });
        return;
      }

      await prisma.financialYear.delete({ where: { id } });
      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "financial_year.delete",
        entityType: "FinancialYear",
        entityId: id,
        metadata: { label: found.label },
      });
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  }
);

const markCashSchema = z.object({
  userId: z.string().min(1),
  cycleId: z.string().min(1),
  amountPaid: z.number().positive(),
  note: z.string().max(500).optional(),
});

router.post(
  "/admin/payments/mark-cash",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(markCashSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { userId, cycleId, amountPaid, note } = req.body as z.infer<typeof markCashSchema>;

      const cycle = await prisma.billingCycle.findFirst({
        where: { id: cycleId, societyId: auth.societyId },
      });
      if (!cycle) {
        res.status(404).json({ message: "Cycle not found" });
        return;
      }
      const user = await prisma.user.findFirst({
        where: { id: userId, societyId: auth.societyId, ...residentLikeRoleFilter },
      });
      if (!user) {
        res.status(404).json({ message: "Resident or admin occupant not found" });
        return;
      }
      if (user.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED) {
        res.status(400).json({
          message:
            "This resident is not the maintenance billing contact for their villa. Record cash against the primary resident instead.",
          code: "MAINTENANCE_BILLING_EXCLUDED",
        });
        return;
      }

      const paidAt = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        // Row-level lock to prevent concurrent mark-cash calls from
        // reading the same amountPaid and double-counting.
        const [existing] = await tx.$queryRawUnsafe<
          { amountPaid: string }[] | []
        >(
          `SELECT "amountPaid"::text FROM "user_payments" WHERE "userId" = $1 AND "cycleId" = $2 FOR UPDATE`,
          userId,
          cycleId,
        );
        const updatedAmount = Number(existing?.amountPaid ?? 0) + amountPaid;

        const payment = await tx.userCyclePayment.update({
          where: {
            id:
              (
                await tx.userCyclePayment.upsert({
                  where: { userId_cycleId: { userId, cycleId } },
                  create: {
                    userId,
                    cycleId,
                    amountPaid: 0,
                    paymentStatus: BillingUserPaymentStatus.SUCCESS,
                    source: BillingPaymentSource.CASH_MANUAL,
                    manualMarkedByAdminId: auth.userId,
                    paidAt,
                    paymentGatewayOrderId: null,
                  },
                  update: {},
                  select: { id: true },
                })
              ).id,
          },
          data: {
            amountPaid: updatedAmount,
            paymentStatus: BillingUserPaymentStatus.SUCCESS,
            source: BillingPaymentSource.CASH_MANUAL,
            manualMarkedByAdminId: auth.userId,
            paidAt,
          },
        });

        if (user.villaId && cycle.financialYearId) {
          await postMarkCashToMaintenanceLedger(tx, {
            societyId: auth.societyId,
            villaId: user.villaId,
            billingCycleId: cycleId,
            cashAmount: amountPaid,
            paidAt,
            note,
          });
          await ensureVillaLedgersAligned(tx, {
            societyId: auth.societyId,
            villaId: user.villaId,
            billingCycleId: cycleId,
            note,
          });
        }

        if (user.villaId) {
          await clearExcludedResidentsUserCyclePayments(tx, {
            societyId: auth.societyId,
            villaId: user.villaId,
            billingCycleId: cycleId,
          });
        }

        return payment;
      });

      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing.mark_cash",
        entityType: "UserCyclePayment",
        entityId: updated.id,
        metadata: { userId, cycleId, amountPaid, totalAmountAfter: Number(updated.amountPaid), note },
      });

      if (user.villaId) {
        void notifyVillaMaintenanceLedgerUpdate({
          societyId: auth.societyId,
          villaId: user.villaId,
          type: "MAINTENANCE_PAYMENT_RECORDED",
          title: "Maintenance payment recorded",
          body: `Admin recorded a cash payment of ₹${amountPaid} for ${cycle.cycleKey}.`,
        });
      }

      res.json({ payment: updated });
    } catch (e) {
      next(e);
    }
  }
);

const waiveSchema = z.object({
  userId: z.string().min(1),
  cycleId: z.string().min(1),
  remark: z.string().max(500).optional(),
});

router.post(
  "/admin/cycles/waive-late-fee",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(waiveSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { userId, cycleId, remark } = req.body as z.infer<typeof waiveSchema>;

      const cycle = await prisma.billingCycle.findFirst({
        where: { id: cycleId, societyId: auth.societyId },
      });
      if (!cycle) {
        res.status(404).json({ message: "Cycle not found" });
        return;
      }

      const waiveUser = await prisma.user.findFirst({
        where: { id: userId, societyId: auth.societyId, role: UserRole.RESIDENT },
        select: { maintenanceBillingRole: true },
      });
      if (!waiveUser) {
        res.status(404).json({ message: "Resident not found" });
        return;
      }
      if (waiveUser.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED) {
        res.status(400).json({
          message:
            "Late fee waivers apply to the primary maintenance billing resident for this villa.",
          code: "MAINTENANCE_BILLING_EXCLUDED",
        });
        return;
      }

      const row = await prisma.billingLateFeeWaiver.upsert({
        where: { cycleId_userId: { cycleId, userId } },
        create: { cycleId, userId, remark },
        update: { remark },
      });

      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing.waive_late_fee",
        entityType: "BillingLateFeeWaiver",
        entityId: row.id,
        metadata: { userId, cycleId },
      });

      res.json({ waiver: row });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/admin/cycles/:id/reopen",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { id } = req.params;
      const body = z
        .object({
          paymentEndDate: z.string().datetime(),
        })
        .parse(req.body ?? {});

      const found = await prisma.billingCycle.findFirst({ where: { id, societyId: auth.societyId } });
      if (!found) {
        res.status(404).json({ message: "Cycle not found" });
        return;
      }

      const pEnd = new Date(body.paymentEndDate);
      const cycle = await prisma.billingCycle.update({
        where: { id },
        data: {
          paymentEndDate: pEnd,
          status: deriveCycleStatusUtc(new Date(), found.paymentStartDate, pEnd),
        },
      });

      await invalidateDisplayCycleHint(auth.societyId);
      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing_cycle.reopen",
        entityType: "BillingCycle",
        entityId: id,
        metadata: { paymentEndDate: body.paymentEndDate },
      });
      res.json({ cycle });
    } catch (e) {
      next(e);
    }
  }
);

router.get("/admin/residents/payments", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const cycleMonth = typeof req.query.cycleMonth === "string" ? req.query.cycleMonth : undefined;
    const paidFilter = typeof req.query.status === "string" ? req.query.status : undefined;

    const cycleWhere = cycleMonth
      ? { societyId: auth.societyId, cycleKey: cycleMonth }
      : { societyId: auth.societyId };

    const cycles = await prisma.billingCycle.findMany({
      where: cycleWhere,
      orderBy: { paymentStartDate: "desc" },
      take: 24,
      select: { id: true, cycleKey: true, title: true },
    });

    const cycleIds = cycles.map((c) => c.id);
    const users = await prisma.user.findMany({
      where: { societyId: auth.societyId, role: UserRole.RESIDENT, isActive: true },
      select: { id: true, name: true, email: true, phone: true, villa: { select: { villaNumber: true } } },
    });

    const payments = await prisma.userCyclePayment.findMany({
      where: { cycleId: { in: cycleIds } },
    });
    const payMap = new Map<string, (typeof payments)[number]>();
    for (const p of payments) {
      payMap.set(`${p.userId}:${p.cycleId}`, p);
    }

    const ledgerByUser = new Map<string, Awaited<ReturnType<typeof computeUserBillingLedger>>>();
    for (const u of users) {
      try {
        ledgerByUser.set(u.id, await computeUserBillingLedger(auth.societyId, u.id));
      } catch (ledgerErr) {
        logger.warn(
          { err: ledgerErr, userId: u.id, societyId: auth.societyId },
          "[admin/residents/payments] Ledger compute failed for user; row omitted",
        );
      }
    }

      const rows: Array<Record<string, unknown>> = [];
      for (const u of users) {
        const userLedger = ledgerByUser.get(u.id);
        for (const c of cycles) {
          const p = payMap.get(`${u.id}:${c.id}`);
          const ledgerRow = userLedger?.cycles.find((row) => row.cycleId === c.id);
          const expectedAmount = ledgerRow?.expectedAmount ?? 0;
          const cashPaidAmount = ledgerRow?.cashPaidAmount ?? 0;
          const paidAmount = ledgerRow?.paidAmount ?? 0;
          const deltaAmount = ledgerRow?.deltaAmount ?? 0;
          const effectiveStatus = deltaAmount > 0 ? "CREDIT" : deltaAmount < 0 ? "DUE" : "SETTLED";
          const settledByLedger = paidAmount >= expectedAmount - 0.005;
          if (paidFilter === "PAID" && !settledByLedger) continue;
          if (paidFilter === "UNPAID" && settledByLedger) continue;
          if (paidFilter === "CREDIT" && effectiveStatus !== "CREDIT") continue;
          if (paidFilter === "DUE" && effectiveStatus !== "DUE") continue;
          if (paidFilter === "SETTLED" && effectiveStatus !== "SETTLED") continue;

        rows.push({
          userId: u.id,
          name: u.name,
          email: u.email,
          phone: u.phone,
          flat: u.villa?.villaNumber ?? null,
          cycleId: c.id,
          cycleKey: c.cycleKey,
          cycleTitle: c.title,
          paymentStatus: p?.paymentStatus ?? "NONE",
          amountPaid: p ? Number(p.amountPaid) : null,
          paidAt: p?.paidAt?.toISOString() ?? null,
          expectedAmount,
          cashPaidAmount,
          effectivePaidAmount: paidAmount,
          paidAmount,
          deltaAmount,
          statusBadge: effectiveStatus,
          carryForwardBalance: ledgerRow?.balanceAfter ?? 0,
        });
      }
    }

    const sortBy = typeof req.query.sortBy === "string" ? req.query.sortBy : "";
    if (sortBy === "highest_due") {
      rows.sort((a, b) => Number((b.deltaAmount as number) < 0 ? Math.abs(b.deltaAmount as number) : 0) - Number((a.deltaAmount as number) < 0 ? Math.abs(a.deltaAmount as number) : 0));
    } else if (sortBy === "highest_credit") {
      rows.sort((a, b) => Number((b.deltaAmount as number) > 0 ? b.deltaAmount : 0) - Number((a.deltaAmount as number) > 0 ? a.deltaAmount : 0));
    }

    const totals = rows.reduce<{
      totalExpected: number;
      totalCollected: number;
      totalShortfall: number;
      totalAdvanceCredit: number;
    }>(
      (acc, row) => {
        const expected = Number(row.expectedAmount ?? 0);
        // "Collected" on admin billing dashboard should reflect actual cash received.
        const collected = Number(row.cashPaidAmount ?? row.amountPaid ?? 0);
        const delta = Number(row.deltaAmount ?? 0);
        acc.totalExpected += expected;
        acc.totalCollected += collected;
        if (delta < 0) acc.totalShortfall += Math.abs(delta);
        if (delta > 0) acc.totalAdvanceCredit += delta;
        return acc;
      },
      {
        totalExpected: 0,
        totalCollected: 0,
        totalShortfall: 0,
        totalAdvanceCredit: 0,
      }
    );

    res.json({ rows, cycles, totals });
  } catch (e) {
    next(e);
  }
});

router.get("/admin/audit-logs", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const take = Math.min(Number(req.query.limit ?? 50), 200);
    const logs = await prisma.adminAuditLog.findMany({
      where: { societyId: auth.societyId },
      orderBy: { createdAt: "desc" },
      take,
    });
    res.json({ logs });
  } catch (e) {
    next(e);
  }
});

router.get(
  "/payments/:paymentId/invoice.pdf",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { paymentId } = req.params;

      const payment = await prisma.userCyclePayment.findFirst({
        where: {
          id: paymentId,
          cycle: { societyId: auth.societyId },
          ...(auth.role !== "ADMIN" ? { userId: auth.userId } : {}),
        },
        include: {
          cycle: true,
          user: { include: { villa: { select: { villaNumber: true, ownerName: true } } } },
        },
      });
      if (!payment || payment.paymentStatus !== BillingUserPaymentStatus.SUCCESS) {
        res.status(404).json({ message: "Invoice not found" });
        return;
      }

      const doc = new PDFDocument({ margin: 40 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="invoice-${paymentId}.pdf"`);
      doc.pipe(res as unknown as NodeJS.WritableStream);

      doc.fontSize(18).text("Maintenance payment invoice", { underline: true });
      doc.moveDown();
      doc.fontSize(11).text(`Invoice ref: ${payment.id}`);
      doc.text(`Paid at (UTC): ${payment.paidAt?.toISOString() ?? "-"}`);
      doc.text(`Cycle: ${payment.cycle.title} (${payment.cycle.cycleKey})`);
      doc.text(`Amount: ${Number(payment.amountPaid).toFixed(2)}`);
      doc.text(`Resident: ${payment.user?.name ?? "Unknown"}`);
      doc.text(`Unit: ${payment.user?.villa?.villaNumber ?? "-"}`);
      doc.end();
    } catch (e) {
      next(e);
    }
  }
);

// ── Sub-routers (split from this file for maintainability) ───────
router.use(phonePeRoutes);
router.use(razorpayRoutes);

export default router;
