import { Router } from "express";
import { z } from "zod";
import {
  BillingCycleStatus,
  BillingPaymentSource,
  BillingUserPaymentStatus,
  NotificationCategory,
  UserRole,
} from "@prisma/client";
import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { deriveCycleStatusUtc } from "./domain/cycleStatus";
import { computeAmountDueForCycle } from "./domain/amountDue";
import {
  buildCurrentCycleResponse,
  computeUserBillingLedger,
  invalidateDisplayCycleHint,
  syncAllBillingCycleStatuses,
} from "./services/cycle-service";
import { createMaintenanceOrder, getPublishableKey, isRazorpayConfigured } from "./services/razorpay-billing";
import { writeAdminAuditLog } from "./services/audit-log";
import { notifySociety } from "../../services/notification.service";

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

    const payload = await buildCurrentCycleResponse({ societyId, userId });
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

const createCycleSchema = z.object({
  societyId: z.string().optional(),
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
      let { societyId, cycleMonth, title, amount, paymentStartDate, paymentEndDate, lateFee, gracePeriodDays } =
        req.body as z.infer<typeof createCycleSchema>;
      const auth = req.auth!;
      if (!societyId) {
        societyId = auth.societyId;
      }
      if (!mustMatchSociety(auth.societyId, societyId)) {
        res.status(403).json({ message: "societyId mismatch" });
        return;
      }

      const [yearStr, monthStr] = cycleMonth.split("-");
      const y = Number(yearStr);
      const m = Number(monthStr);
      const startDate = new Date(Date.UTC(y, m - 1, 1));
      const endDate = new Date(Date.UTC(y, m, 0));

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
        metadata: { cycleKey: cycleMonth },
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
        // eslint-disable-next-line no-console
        console.error("[billing-cycle.create] resident notify failed:", notifyErr);
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

router.get("/admin/cycles", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const cycles = await prisma.billingCycle.findMany({
      where: { societyId: auth.societyId },
      orderBy: { paymentStartDate: "desc" },
      take: 120,
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

const createOrderSchema = z.object({
  cycleId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

router.post(
  "/payments/create-order",
  requireAuth,
  requireRole(UserRole.RESIDENT),
  validateBody(createOrderSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { cycleId, idempotencyKey } = req.body as z.infer<typeof createOrderSchema>;

      const cycle = await prisma.billingCycle.findFirst({
        where: { id: cycleId, societyId: auth.societyId },
      });
      if (!cycle) {
        res.status(404).json({ message: "Cycle not found" });
        return;
      }

      const serverStatus = deriveCycleStatusUtc(new Date(), cycle.paymentStartDate, cycle.paymentEndDate);
      if (serverStatus !== BillingCycleStatus.OPEN) {
        res.status(400).json({ message: "Cycle is not open for online payment", code: "CYCLE_NOT_OPEN" });
        return;
      }

      const waiver = await prisma.billingLateFeeWaiver.findUnique({
        where: { cycleId_userId: { cycleId, userId: auth.userId } },
      });
      const due = computeAmountDueForCycle(cycle, new Date(), Boolean(waiver));
      const ledger = await computeUserBillingLedger(auth.societyId, auth.userId);
      const currentLedger = ledger.cycles.find((row) => row.cycleId === cycleId);
      const balanceBefore = currentLedger?.balanceBefore ?? 0;
      const cycleOutstanding = currentLedger
          ? Math.max(0, currentLedger.expectedAmount - currentLedger.paidAmount)
          : Math.max(0, Number(cycle.amount) - balanceBefore);
      const lateComponent = Math.max(0, due.totalDue - Number(cycle.amount));
      const adjustedDue = Math.max(0, cycleOutstanding + lateComponent);
      if (adjustedDue <= 0) {
        const paymentRow = await prisma.userCyclePayment.upsert({
          where: { userId_cycleId: { userId: auth.userId, cycleId } },
          create: {
            userId: auth.userId,
            cycleId,
            amountPaid: 0,
            paymentStatus: BillingUserPaymentStatus.SUCCESS,
            source: BillingPaymentSource.CASH_MANUAL,
            manualMarkedByAdminId: null,
            paidAt: new Date(),
          },
          update: {
            amountPaid: 0,
            paymentStatus: BillingUserPaymentStatus.SUCCESS,
            paidAt: new Date(),
          },
        });
        res.status(201).json({
          orderId: null,
          amountPaise: 0,
          currency: "INR",
          key: getPublishableKey(),
          paymentId: paymentRow.id,
          totalDue: 0,
          unadjustedDue: due.totalDue,
          availableCreditApplied: Math.max(0, Math.min(balanceBefore, due.totalDue)),
          autoSettledFromCredit: true,
        });
        return;
      }

      const existing = await prisma.userCyclePayment.findUnique({
        where: { userId_cycleId: { userId: auth.userId, cycleId } },
      });
      if (
        existing?.paymentStatus === BillingUserPaymentStatus.SUCCESS &&
        adjustedDue <= 0
      ) {
        res.status(409).json({ message: "Already paid for this cycle", code: "ALREADY_PAID" });
        return;
      }

      if (!isRazorpayConfigured()) {
        res.status(503).json({
          message: "Online payments are not configured",
          code: "PAYMENT_GATEWAY_UNAVAILABLE",
        });
        return;
      }

      const receipt = `mb_${cycle.cycleKey}_${auth.userId}`.slice(0, 40);
      const order = await createMaintenanceOrder({
        amountPaise: Math.round(adjustedDue * 100),
        receipt,
        notes: {
          societyId: auth.societyId,
          cycleId,
          userId: auth.userId,
        },
      });

      const paymentRow = await prisma.userCyclePayment.upsert({
        where: { userId_cycleId: { userId: auth.userId, cycleId } },
        create: {
          userId: auth.userId,
          cycleId,
          amountPaid: adjustedDue,
          paymentStatus: BillingUserPaymentStatus.PENDING,
          paymentGatewayOrderId: order.id,
          idempotencyKey: idempotencyKey ?? null,
        },
        update: {
          amountPaid: adjustedDue,
          paymentStatus: BillingUserPaymentStatus.PENDING,
          paymentGatewayOrderId: order.id,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      });

      await prisma.billingPaymentLog.create({
        data: {
          societyId: auth.societyId,
          userId: auth.userId,
          cycleId,
          status: "create_order",
          requestPayload: { orderId: order.id } as object,
        },
      });

      res.status(201).json({
        orderId: order.id,
        amountPaise: order.amount,
        currency: order.currency,
        key: getPublishableKey(),
        paymentId: paymentRow.id,
        totalDue: adjustedDue,
        unadjustedDue: due.totalDue,
        availableCreditApplied: Math.max(0, Math.min(balanceBefore, due.totalDue)),
      });
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "GATEWAY_MISSING") {
        res.status(503).json({ message: "Gateway not configured", code: "PAYMENT_GATEWAY_UNAVAILABLE" });
        return;
      }
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
        where: { id: userId, societyId: auth.societyId, role: UserRole.RESIDENT },
      });
      if (!user) {
        res.status(404).json({ message: "Resident not found" });
        return;
      }

      const existing = await prisma.userCyclePayment.findUnique({
        where: { userId_cycleId: { userId, cycleId } },
      });
      const updatedAmount = Number(existing?.amountPaid ?? 0) + amountPaid;
      const updated = await prisma.userCyclePayment.update({
        where: {
          id:
            (
              await prisma.userCyclePayment.upsert({
                where: { userId_cycleId: { userId, cycleId } },
                create: {
                  userId,
                  cycleId,
                  amountPaid: 0,
                  paymentStatus: BillingUserPaymentStatus.SUCCESS,
                  source: BillingPaymentSource.CASH_MANUAL,
                  manualMarkedByAdminId: auth.userId,
                  paidAt: new Date(),
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
          paidAt: new Date(),
        },
      });

      await writeAdminAuditLog({
        societyId: auth.societyId,
        adminId: auth.userId,
        action: "billing.mark_cash",
        entityType: "UserCyclePayment",
        entityId: updated.id,
        metadata: { userId, cycleId, amountPaid, totalAmountAfter: updatedAmount, note },
      });

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

    const ledgers = await Promise.all(users.map((u) => computeUserBillingLedger(auth.societyId, u.id)));
    const ledgerByUser = new Map(users.map((u, idx) => [u.id, ledgers[idx]]));

    const rows: Array<Record<string, unknown>> = [];
    for (const u of users) {
      const userLedger = ledgerByUser.get(u.id);
      for (const c of cycles) {
        const p = payMap.get(`${u.id}:${c.id}`);
        const isPaid = p?.paymentStatus === BillingUserPaymentStatus.SUCCESS;
        const ledgerRow = userLedger?.cycles.find((row) => row.cycleId === c.id);
        const expectedAmount = ledgerRow?.expectedAmount ?? 0;
        const cashPaidAmount = ledgerRow?.cashPaidAmount ?? 0;
        const paidAmount = ledgerRow?.paidAmount ?? 0;
        const deltaAmount = ledgerRow?.deltaAmount ?? 0;
        const effectiveStatus = deltaAmount > 0 ? "CREDIT" : deltaAmount < 0 ? "DUE" : "SETTLED";
        if (paidFilter === "PAID" && !isPaid) continue;
        if (paidFilter === "UNPAID" && isPaid) continue;
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
        const collected = Number(row.effectivePaidAmount ?? row.paidAmount ?? 0);
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
  requireRole(UserRole.RESIDENT),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { paymentId } = req.params;

      const payment = await prisma.userCyclePayment.findFirst({
        where: { id: paymentId, userId: auth.userId },
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
      doc.text(`Resident: ${payment.user.name}`);
      doc.text(`Unit: ${payment.user.villa?.villaNumber ?? "-"}`);
      doc.end();
    } catch (e) {
      next(e);
    }
  }
);

export default router;
