import { Router } from "express";
import { z } from "zod";
import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  NotificationCategory,
  Prisma,
  UserRole,
} from "@prisma/client";
import PDFDocument from "pdfkit";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { clearExcludedResidentsUserCyclePayments } from "../../lib/maintenanceBillingRole";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import { requireAuth, requireRole, isAdminLikeRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  generateSnapshotsForBillingCycle,
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
import { reconcileVillaLedgersForRecentCycles, invalidateReconcileCache } from "./services/resident-pending-dues";
import { auditFromRequest } from "../../services/audit.service";
import { notifyVillaMaintenanceLedgerUpdate } from "../../lib/maintenanceLedgerNotify";
import { notifySocietyRoles } from "../../services/notification.service";
import { RESIDENT_LIKE_ROLES } from "../../lib/residentLike";
import phonePeRoutes from "./billing-v1-phonepe.routes";
import razorpayRoutes from "./billing-v1-razorpay.routes";
import { applyRateLimitIfEnabled, paymentLimiter } from "../../middlewares/rateLimiter";

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
    if (role === UserRole.RESIDENT || isAdminLikeRole(role)) {
      /* ok */
    } else {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    const billingCycleId =
      typeof req.query.billingCycleId === "string" ? req.query.billingCycleId.trim() : "";
    try {
      const billingSubject = await prisma.user.findFirst({
        where: { id: userId, societyId },
        select: { villaId: true, maintenanceBillingRole: true },
      });
      if (
        billingSubject?.villaId &&
        billingSubject.maintenanceBillingRole !== MaintenanceBillingRole.EXCLUDED
      ) {
        await reconcileVillaLedgersForRecentCycles(societyId, billingSubject.villaId);
      }
      const payload = await buildCurrentCycleResponse({
        societyId,
        userId,
        billingCycleId: billingCycleId || undefined,
      });
      res.setHeader("Cache-Control", "no-store");
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
  title: z.string().trim().min(1).max(200),
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
      auditFromRequest(req, {
        societyId,
        adminId: auth.userId,
        action: "billing_cycle.create",
        entityType: "BillingCycle",
        entityId: cycle.id,
        metadata: { cycleKey: cycleMonth, financialYearId },
      });

      await syncAllBillingCycleStatuses();

      res.status(201).json({ cycle });
    } catch (e) {
      next(e);
    }
  }
);

const updateCycleSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
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
      auditFromRequest(req, {
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
        where: { cycleId: id, cycle: { societyId: auth.societyId } },
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
      auditFromRequest(req, {
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

router.post(
  "/admin/cycles/:id/publish",
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
      if (found.publishedAt) {
        res.status(409).json({ message: "Cycle is already published" });
        return;
      }

      const cycle = await prisma.billingCycle.update({
        where: { id },
        data: { publishedAt: new Date() },
      });

      auditFromRequest(req, {
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing_cycle.publish",
        entityType: "BillingCycle",
        entityId: id,
        metadata: { cycleKey: found.cycleKey, title: found.title },
      });

      // Generate maintenance snapshots for every billed (primary-occupant) villa so
      // admin Outstanding Dues + reconciliation reflect the cycle immediately on publish.
      // Idempotent (collection cycle is upserted; per-villa snapshots skip when already
      // present, so existing/paid rows are never overwritten) and best-effort so a sync
      // failure never blocks publishing. Only runs when the cycle is linked to a financial year.
      if (found.financialYearId) {
        try {
          await prisma.$transaction((tx) =>
            generateSnapshotsForBillingCycle(tx, {
              societyId: auth.societyId,
              billingCycleId: id,
              cycleAmount: Number(found.amount),
            }),
          );
        } catch (snapErr) {
          logger.error(
            { err: snapErr },
            "[billing-cycle.publish] maintenance snapshot generation failed",
          );
        }
      }

      try {
        await notifySocietyRoles({
          societyId: auth.societyId,
          roles: [...RESIDENT_LIKE_ROLES],
          category: NotificationCategory.MAINTENANCE,
          title: "New maintenance billing cycle",
          body: `${found.title} (${found.cycleKey}) has been published. Please review and pay within the cycle window.`,
          data: {
            type: "BILLING_CYCLE_CREATED",
            cycleId: cycle.id,
            cycleKey: found.cycleKey,
          },
        });
      } catch (notifyErr) {
        logger.error({ err: notifyErr }, "[billing-cycle.publish] resident notify failed");
      }

      res.json({ cycle });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * One-time backfill: ensure maintenance snapshots exist for every ALREADY-published
 * billing cycle in the society (cycles published before snapshot-on-publish shipped).
 * Idempotent — safe to run repeatedly; existing/paid snapshots are never overwritten.
 */
router.post(
  "/admin/cycles/backfill-snapshots",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const cycles = await prisma.billingCycle.findMany({
        where: {
          societyId: auth.societyId,
          publishedAt: { not: null },
          financialYearId: { not: null },
        },
        select: { id: true, amount: true, cycleKey: true },
      });

      let cyclesProcessed = 0;
      let cyclesFailed = 0;
      let villasEnsured = 0;
      for (const c of cycles) {
        try {
          const n = await prisma.$transaction((tx) =>
            generateSnapshotsForBillingCycle(tx, {
              societyId: auth.societyId,
              billingCycleId: c.id,
              cycleAmount: Number(c.amount),
            }),
          );
          cyclesProcessed += 1;
          villasEnsured += n;
        } catch (err) {
          cyclesFailed += 1;
          logger.error(
            { err, cycleId: c.id, cycleKey: c.cycleKey },
            "[billing-cycle.backfill-snapshots] cycle failed",
          );
        }
      }

      auditFromRequest(req, {
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing_cycle.backfill_snapshots",
        entityType: "BillingCycle",
        entityId: "*",
        metadata: { cyclesProcessed, cyclesFailed, villasEnsured },
      });

      return res.json({
        message: "Snapshot backfill complete",
        publishedCycles: cycles.length,
        cyclesProcessed,
        cyclesFailed,
        villasEnsured,
      });
    } catch (e) {
      next(e);
    }
  },
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
      // Both admins and residents see every cycle for the financial year here,
      // including unpublished drafts — the picker is for viewing the expense
      // breakdown of any created/closed cycle, not for billing actions.
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
          publishedAt: true,
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
        publishedAt: c.publishedAt?.toISOString() ?? null,
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
      where: { societyId: auth.societyId, ...residentLikeRoleFilter, isActive: true },
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
          publishedAt: c.publishedAt?.toISOString() ?? null,
        };
      })
    );

    res.json({ cycles: rows, residentCount });
  } catch (e) {
    next(e);
  }
});

const createFinancialYearSchema = z.object({
  label: z.string().trim().min(2).max(80),
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

      auditFromRequest(req, {
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
  label: z.string().trim().min(2).max(80),
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

      auditFromRequest(req, {
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
      auditFromRequest(req, {
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
  note: z.string().trim().max(500).optional(),
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

      if (user.villaId) invalidateReconcileCache(user.villaId);

      auditFromRequest(req, {
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
  remark: z.string().trim().max(500).optional(),
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
        // Occupant role set (includes admins who live in a villa) so a late-fee
        // waiver can target a resident who is also an admin.
        where: { id: userId, societyId: auth.societyId, ...residentLikeRoleFilter },
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

      auditFromRequest(req, {
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
      auditFromRequest(req, {
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
      where: {
        societyId: auth.societyId,
        isActive: true,
        villaId: { not: null },
        ...residentLikeRoleFilter,
      },
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
          paymentId: p?.id ?? null,
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

    const pagination = getPagination(req);
    const total = rows.length;
    const pageRows = rows.slice(pagination.skip, pagination.skip + pagination.take);

    res.json({
      rows: pageRows,
      cycles,
      totals,
      ...paginationMeta(total, pageRows.length, pagination),
    });
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

// ── PDF receipt helper ────────────────────────────────────────────────

type PaymentForReceipt = Awaited<ReturnType<typeof fetchPaymentForReceipt>>;

async function fetchPaymentForReceipt(where: Prisma.UserCyclePaymentWhereInput) {
  return prisma.userCyclePayment.findFirst({
    where,
    include: {
      cycle: {
        include: { society: { select: { name: true, address: true } } },
      },
      user: {
        include: {
          villa: { select: { villaNumber: true, ownerName: true, block: true } },
        },
      },
    },
  });
}

function formatIst(date: Date | null | undefined): string {
  if (!date) return "-";
  // IST = UTC + 5:30
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const day = String(ist.getUTCDate()).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[ist.getUTCMonth()];
  const year = ist.getUTCFullYear();
  const h = ist.getUTCHours();
  const m = String(ist.getUTCMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${day} ${mon} ${year}, ${h12}:${m} ${ampm} IST`;
}

function formatCycleKeyLabel(cycleKey: string): string {
  const [y, m] = cycleKey.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = Number(m) - 1;
  return idx >= 0 && idx < 12 ? `${months[idx]} ${y}` : cycleKey;
}

function fmtInr(n: number): string {
  return `\u20B9${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function ensureInvoiceNumber(paymentId: string, cycleKey: string): Promise<string> {
  const existing = await prisma.userCyclePayment.findUnique({
    where: { id: paymentId },
    select: { invoiceNumber: true },
  });
  if (existing?.invoiceNumber) return existing.invoiceNumber;

  const invoiceNumber = `RCP-${cycleKey}-${Date.now().toString(36).slice(-6).toUpperCase()}`;
  await prisma.userCyclePayment.update({
    where: { id: paymentId },
    data: { invoiceNumber },
  });
  return invoiceNumber;
}

interface ReceiptData {
  societyName: string;
  societyAddress: string;
  receiptNo: string;
  receiptDate: string;
  residentName: string;
  unit: string;
  contact: string;
  billingPeriod: string;
  cycleTitle: string;
  amountDue: number;
  amountPaid: number;
  creditApplied: number;
  paymentMode: string;
  transactionId: string;
  paidAt: string;
  status: string;
}

function buildPaymentReceiptPdfFromData(data: ReceiptData): typeof PDFDocument.prototype {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const pageW = doc.page.width;   // 595.28
  const pageH = doc.page.height;  // 841.89
  const M = 50;                   // content margin
  const pw = pageW - M * 2;       // content width

  // ── Brand palette ──
  const navy       = "#0f172a";
  const brand      = "#1e40af";
  const brandDark  = "#1e3a8a";
  const accent     = "#3b82f6";
  const emerald    = "#059669";
  const emeraldBg  = "#ecfdf5";
  const emeraldBdr = "#a7f3d0";
  const lightBg    = "#f8fafc";
  const cardBg     = "#f1f5f9";
  const border     = "#e2e8f0";
  const textDark   = "#0f172a";
  const textMid    = "#475569";
  const textLight  = "#94a3b8";
  const white      = "#ffffff";

  const isPaid = data.status === "PAID";

  // ═══════════════════════════════════════════════════════
  // DIAGONAL "PAID" WATERMARK  (behind everything)
  // ═══════════════════════════════════════════════════════
  if (isPaid) {
    doc.save();
    doc.translate(pageW / 2, pageH / 2);
    doc.rotate(-35, { origin: [0, 0] });
    doc.fontSize(120).font("Helvetica-Bold")
      .fillColor(emerald).fillOpacity(0.06)
      .text("PAID", -200, -50, { width: 400, align: "center" });
    doc.fillOpacity(1);
    doc.restore();
  }

  // ═══════════════════════════════════════════════════════
  // TOP HEADER BAND
  // ═══════════════════════════════════════════════════════
  const headerH = 110;
  doc.rect(0, 0, pageW, headerH).fill(navy);

  // Society monogram circle (left side)
  const initials = data.societyName
    .split(/\s+/)
    .filter(w => w.length > 0)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join("");
  const monoR = 22;
  const monoX = M + monoR;
  const monoCY = headerH / 2;
  doc.circle(monoX, monoCY, monoR).fill(accent);
  doc.fontSize(16).font("Helvetica-Bold").fillColor(white)
    .text(initials, monoX - monoR, monoCY - 8, { width: monoR * 2, align: "center" });

  // Society name + subtitle
  const nameX = monoX + monoR + 16;
  const nameW = pw - (nameX - M);
  doc.fontSize(18).font("Helvetica-Bold").fillColor(white)
    .text(data.societyName.toUpperCase(), nameX, monoCY - 18, { width: nameW, characterSpacing: 1 });
  doc.fontSize(9).font("Helvetica").fillColor(textLight)
    .text("Payment Receipt", nameX, doc.y + 1, { width: nameW });
  if (data.societyAddress) {
    doc.fontSize(8).font("Helvetica").fillColor(textLight)
      .text(data.societyAddress, nameX, doc.y + 1, { width: nameW });
  }

  // Accent stripe
  doc.rect(0, headerH, pageW, 4).fill(accent);

  // ═══════════════════════════════════════════════════════
  // RECEIPT META BAR
  // ═══════════════════════════════════════════════════════
  let cy = headerH + 20;

  // Receipt badge
  doc.roundedRect(M, cy, 150, 26, 4).fill(brand);
  doc.fontSize(10).font("Helvetica-Bold").fillColor(white)
    .text("RECEIPT", M + 12, cy + 7);

  // Receipt No + Date on right
  const metaX = M + pw - 210;
  doc.fontSize(7.5).font("Helvetica-Bold").fillColor(textLight)
    .text("RECEIPT NO.", metaX, cy + 2);
  doc.fontSize(9).font("Helvetica-Bold").fillColor(textDark)
    .text(data.receiptNo, metaX, cy + 13);
  doc.fontSize(7.5).font("Helvetica-Bold").fillColor(textLight)
    .text("DATE", metaX + 120, cy + 2);
  doc.fontSize(9).font("Helvetica-Bold").fillColor(textDark)
    .text(data.receiptDate, metaX + 120, cy + 13);

  cy += 42;

  // ═══════════════════════════════════════════════════════
  // BILLED TO / PAYMENT FOR — two-column cards
  // ═══════════════════════════════════════════════════════
  const cardW = (pw - 20) / 2;
  const cardH = 80;

  // Left card — Billed To
  doc.roundedRect(M, cy, cardW, cardH, 6).lineWidth(0.5).fillAndStroke(cardBg, border);
  // Left accent bar
  doc.rect(M, cy + 6, 3, cardH - 12).fill(accent);
  doc.fontSize(7).font("Helvetica-Bold").fillColor(accent)
    .text("BILLED TO", M + 16, cy + 12);
  doc.fontSize(11).font("Helvetica-Bold").fillColor(textDark)
    .text(data.residentName, M + 16, cy + 26, { width: cardW - 32 });
  doc.fontSize(9).font("Helvetica").fillColor(textMid)
    .text(`Unit ${data.unit}`, M + 16, cy + 44);
  if (data.contact) {
    doc.text(data.contact, M + 16, cy + 58);
  }

  // Right card — Payment For
  const rightX = M + cardW + 20;
  doc.roundedRect(rightX, cy, cardW, cardH, 6).lineWidth(0.5).fillAndStroke(cardBg, border);
  doc.rect(rightX, cy + 6, 3, cardH - 12).fill(accent);
  doc.fontSize(7).font("Helvetica-Bold").fillColor(accent)
    .text("PAYMENT FOR", rightX + 16, cy + 12);
  doc.fontSize(11).font("Helvetica-Bold").fillColor(textDark)
    .text(data.cycleTitle, rightX + 16, cy + 26, { width: cardW - 32 });
  doc.fontSize(9).font("Helvetica").fillColor(textMid)
    .text(`Period: ${data.billingPeriod}`, rightX + 16, cy + 44);
  doc.text(`Mode: ${data.paymentMode}`, rightX + 16, cy + 58);

  cy += cardH + 24;

  // ═══════════════════════════════════════════════════════
  // PAYMENT BREAKDOWN TABLE
  // ═══════════════════════════════════════════════════════
  // Section label with line
  doc.fontSize(9).font("Helvetica-Bold").fillColor(navy)
    .text("PAYMENT BREAKDOWN", M, cy);
  const lblEnd = M + doc.widthOfString("PAYMENT BREAKDOWN") + 10;
  doc.moveTo(lblEnd, cy + 5).lineTo(M + pw, cy + 5).lineWidth(0.5).strokeColor(border).stroke();
  cy += 18;

  const rowH = 32;
  const descCol = M;
  const valCol = M + pw * 0.6;
  const valW = pw * 0.4;

  // Table header
  doc.roundedRect(descCol, cy, pw, rowH, 4).fill(brandDark);
  doc.fontSize(8).font("Helvetica-Bold").fillColor(white)
    .text("DESCRIPTION", descCol + 16, cy + 11)
    .text("DETAILS / AMOUNT", valCol, cy + 11, { width: valW - 16, align: "right" });
  cy += rowH;

  // Build rows
  const tableRows: [string, string][] = [
    ["Amount Due", fmtInr(data.amountDue)],
    ["Amount Paid", fmtInr(data.amountPaid)],
  ];
  if (data.creditApplied > 0) {
    tableRows.push(["Advance Credit Applied", `+ ${fmtInr(data.creditApplied)}`]);
  }
  tableRows.push(["Payment Mode", data.paymentMode]);
  if (data.transactionId && data.transactionId !== "-") {
    tableRows.push(["Transaction ID", data.transactionId]);
  }
  tableRows.push(["Payment Date", data.paidAt]);

  for (let i = 0; i < tableRows.length; i++) {
    const bg = i % 2 === 0 ? lightBg : white;
    doc.rect(descCol, cy, pw, rowH).lineWidth(0.3).fillAndStroke(bg, border);
    doc.fontSize(9).font("Helvetica").fillColor(textDark)
      .text(tableRows[i][0], descCol + 16, cy + 11);
    doc.font("Helvetica-Bold").fillColor(textDark)
      .text(tableRows[i][1], valCol, cy + 11, { width: valW - 16, align: "right" });
    cy += rowH;
  }

  // ═══════════════════════════════════════════════════════
  // STATUS BANNER
  // ═══════════════════════════════════════════════════════
  cy += 6;
  const statusH = 38;
  const statusColor = isPaid ? emerald : brand;
  doc.roundedRect(descCol, cy, pw, statusH, 4).fill(statusColor);
  doc.fontSize(12).font("Helvetica-Bold").fillColor(white)
    .text("PAYMENT STATUS", descCol + 16, cy + 13);
  doc.text(data.status, valCol, cy + 13, { width: valW - 16, align: "right" });
  cy += statusH;

  // ═══════════════════════════════════════════════════════
  // GRAND TOTAL CALLOUT BOX
  // ═══════════════════════════════════════════════════════
  cy += 18;
  const totalAmt = data.amountPaid + data.creditApplied;
  const totalBoxH = data.creditApplied > 0 ? 90 : 70;
  doc.roundedRect(M, cy, pw, totalBoxH, 8).lineWidth(1).fillAndStroke(emeraldBg, emeraldBdr);

  let ty = cy + 14;

  if (data.creditApplied > 0) {
    doc.fontSize(9).font("Helvetica").fillColor(textMid)
      .text("Credit Applied:", M + 20, ty);
    doc.font("Helvetica-Bold").fillColor(textDark)
      .text(fmtInr(data.creditApplied), M + 20, ty, { width: pw - 40, align: "right" });
    ty += 18;
    doc.fontSize(9).font("Helvetica").fillColor(textMid)
      .text("Cash Paid:", M + 20, ty);
    doc.font("Helvetica-Bold").fillColor(textDark)
      .text(fmtInr(data.amountPaid), M + 20, ty, { width: pw - 40, align: "right" });
    ty += 18;
    // Divider
    doc.moveTo(M + 20, ty).lineTo(M + pw - 20, ty).lineWidth(0.5).strokeColor(emeraldBdr).stroke();
    ty += 10;
  }

  doc.fontSize(10).font("Helvetica-Bold").fillColor(textMid)
    .text("TOTAL AMOUNT", M + 20, ty + 2);
  doc.fontSize(22).font("Helvetica-Bold").fillColor(emerald)
    .text(fmtInr(totalAmt), M + 20, ty - 4, { width: pw - 40, align: "right" });

  cy += totalBoxH;

  // ═══════════════════════════════════════════════════════
  // THANK YOU NOTE
  // ═══════════════════════════════════════════════════════
  cy += 22;
  doc.fontSize(11).font("Helvetica-Bold").fillColor(brand)
    .text("Thank you for your timely payment!", M, cy, { width: pw, align: "center" });
  cy += 18;
  doc.fontSize(8).font("Helvetica").fillColor(textLight)
    .text("If you have any questions about this receipt, please contact your society administration.", M, cy, { width: pw, align: "center" });

  // ═══════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════
  const footerY = pageH - 70;
  doc.moveTo(M, footerY).lineTo(M + pw, footerY).lineWidth(0.3).strokeColor(border).stroke();

  doc.fontSize(7).font("Helvetica").fillColor(textLight)
    .text("This is a computer-generated receipt and does not require a physical signature.", M, footerY + 8, { width: pw, align: "center" });
  doc.fontSize(7).font("Helvetica").fillColor(textLight)
    .text(`Generated on ${formatIst(new Date())}`, M, footerY + 20, { width: pw, align: "center" });
  doc.fontSize(7.5).font("Helvetica-Bold").fillColor(textMid)
    .text(data.societyName, M, footerY + 32, { width: pw, align: "center" });

  // Bottom brand bar
  doc.rect(0, pageH - 5, pageW, 5).fill(accent);

  return doc;
}

/** Build ReceiptData from a UserCyclePayment record. */
function receiptDataFromPayment(payment: NonNullable<PaymentForReceipt>): ReceiptData {
  const villa = payment.user?.villa;
  const unit = villa
    ? [villa.block, villa.villaNumber].filter(Boolean).join("-") || villa.villaNumber
    : "-";
  return {
    societyName: payment.cycle.society?.name ?? "Society",
    societyAddress: payment.cycle.society?.address ?? "",
    receiptNo: payment.invoiceNumber ?? payment.id,
    receiptDate: formatIst(payment.paidAt ?? payment.updatedAt),
    residentName: payment.user?.name ?? "Resident",
    unit,
    contact: (payment.user as { phone?: string | null } | null)?.phone ?? "",
    billingPeriod: formatCycleKeyLabel(payment.cycle.cycleKey),
    cycleTitle: payment.cycle.title,
    amountDue: Number(payment.cycle.amount),
    amountPaid: Number(payment.amountPaid),
    creditApplied: 0,
    paymentMode: payment.source === "CASH_MANUAL" ? "Cash" : "Online",
    transactionId: payment.paymentGatewayPaymentId ?? "-",
    paidAt: formatIst(payment.paidAt),
    status: payment.paymentStatus === BillingUserPaymentStatus.SUCCESS ? "PAID" : String(payment.paymentStatus),
  };
}

// ── Receipt by cycle (resident looks up by cycleId) ──────────────────
router.get(
  "/payments/receipt.pdf",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const cycleId = typeof req.query.cycleId === "string" ? req.query.cycleId.trim() : "";
      if (!cycleId) {
        res.status(400).json({ message: "cycleId is required" });
        return;
      }

      // For admins: use userId query param if provided (lookup another resident),
      // otherwise fall back to auth.userId (admin downloading own receipt).
      const qUserId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
      const userId = isAdminLikeRole(auth.role) && qUserId ? qUserId : auth.userId;

      // ── Strategy 1: Direct UserCyclePayment lookup ──
      const payment = await fetchPaymentForReceipt({
        userId,
        cycleId,
        cycle: { societyId: auth.societyId },
        paymentStatus: BillingUserPaymentStatus.SUCCESS,
      });

      let data: ReceiptData;
      let filename: string;

      if (payment) {
        const invoiceNumber = await ensureInvoiceNumber(payment.id, payment.cycle.cycleKey);
        payment.invoiceNumber = invoiceNumber;
        data = receiptDataFromPayment(payment);
        filename = `receipt-${payment.cycle.cycleKey}-${payment.user?.villa?.villaNumber ?? "unit"}.pdf`;
      } else {
        // ── Strategy 2: Build receipt from ledger + user profile ──
        // This handles cases where payment was recorded via the old
        // maintenance management system (VillaMaintenanceSnapshot) but no
        // UserCyclePayment row exists for this user.
        const ledger = await computeUserBillingLedger(auth.societyId, userId);
        const ledgerRow = ledger.cycles.find((r) => r.cycleId === cycleId);
        if (!ledgerRow || (ledgerRow.cashPaidAmount <= 0.005 && ledgerRow.paidAmount <= 0.005)) {
          res.status(404).json({ message: "No successful payment found for this cycle" });
          return;
        }

        const [cycle, user] = await Promise.all([
          prisma.billingCycle.findFirst({
            where: { id: cycleId, societyId: auth.societyId },
            include: { society: { select: { name: true, address: true } } },
          }),
          prisma.user.findFirst({
            where: { id: userId, societyId: auth.societyId },
            include: { villa: { select: { villaNumber: true, ownerName: true, block: true } } },
          }),
        ]);
        if (!cycle) {
          res.status(404).json({ message: "Billing cycle not found" });
          return;
        }

        const villa = user?.villa;
        const unit = villa
          ? [villa.block, villa.villaNumber].filter(Boolean).join("-") || villa.villaNumber
          : "-";

        const creditApplied = Math.max(0, Math.min(ledgerRow.expectedAmount, ledgerRow.balanceBefore));

        data = {
          societyName: cycle.society?.name ?? "Society",
          societyAddress: cycle.society?.address ?? "",
          receiptNo: `RCP-${cycle.cycleKey}-${Date.now().toString(36).slice(-6).toUpperCase()}`,
          receiptDate: formatIst(ledgerRow.paidAt ? new Date(ledgerRow.paidAt) : new Date()),
          residentName: user?.name ?? "Resident",
          unit,
          contact: (user as { phone?: string | null } | null)?.phone ?? "",
          billingPeriod: formatCycleKeyLabel(cycle.cycleKey),
          cycleTitle: cycle.title,
          amountDue: ledgerRow.expectedAmount,
          amountPaid: ledgerRow.cashPaidAmount,
          creditApplied,
          paymentMode: "Recorded by Admin",
          transactionId: "-",
          paidAt: formatIst(ledgerRow.paidAt ? new Date(ledgerRow.paidAt) : null),
          status: ledgerRow.paidAmount >= ledgerRow.expectedAmount - 0.005 ? "PAID" : "PARTIAL",
        };
        filename = `receipt-${cycle.cycleKey}-${villa?.villaNumber ?? "unit"}.pdf`;
      }

      const doc = buildPaymentReceiptPdfFromData(data);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      doc.pipe(res as unknown as NodeJS.WritableStream);
      doc.end();
    } catch (e) {
      next(e);
    }
  }
);

// ── Invoice by paymentId (original endpoint, enhanced layout) ────────
router.get(
  "/payments/:paymentId/invoice.pdf",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { paymentId } = req.params;

      const payment = await fetchPaymentForReceipt({
        id: paymentId,
        cycle: { societyId: auth.societyId },
        ...(!isAdminLikeRole(auth.role) ? { userId: auth.userId } : {}),
      });
      if (!payment || payment.paymentStatus !== BillingUserPaymentStatus.SUCCESS) {
        res.status(404).json({ message: "Invoice not found" });
        return;
      }

      const invoiceNumber = await ensureInvoiceNumber(payment.id, payment.cycle.cycleKey);
      payment.invoiceNumber = invoiceNumber;

      const data = receiptDataFromPayment(payment);
      const doc = buildPaymentReceiptPdfFromData(data);
      const filename = `invoice-${paymentId}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      doc.pipe(res as unknown as NodeJS.WritableStream);
      doc.end();
    } catch (e) {
      next(e);
    }
  }
);

// ── Sub-routers (split from this file for maintainability) ───────
// Payment gateway routes get a tighter cap than the global API limiter.
router.use(applyRateLimitIfEnabled(paymentLimiter), phonePeRoutes);
router.use(applyRateLimitIfEnabled(paymentLimiter), razorpayRoutes);

export default router;
