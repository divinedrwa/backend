import crypto from "crypto";
import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  NotificationCategory,
  Prisma,
  UserRole,
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { clearExcludedResidentsUserCyclePayments } from "../../lib/maintenanceBillingRole";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import { prisma } from "../../lib/prisma";
import {
  ensureVillaLedgersAligned,
  syncBillingUserCyclePaymentsFromSnapshot,
} from "../billing-cycle/billing-collection-link";
import { invalidateReconcileCache } from "../billing-cycle/services/resident-pending-dues";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { getCachedMoneySnapshot } from "../../lib/societyFinance";
import collectionRoutes from "./collection-routes";
import { applyVillaCreditAcrossSnapshots, getVillaCreditBalance } from "./credit-walker";
import {
  buildCycleFinancialDashboardCore,
  pickMaintenanceCollectionCycleId,
} from "./financial-dashboard-cycle";
import { notifyUsers } from "../../services/notification.service";
import { auditFromRequest } from "../../services/audit.service";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));
router.use("/collection", collectionRoutes);

const additionalFundSchema = z.object({
  title: z.string().trim().min(2).max(120),
  amount: z.number().positive(),
  receivedDate: z.string().datetime(),
  destination: z.enum(["MERGE_WITH_MAINTENANCE", "KEEP_SEPARATE"]),
  // Free-text source, e.g. donation, event sponsorship, corpus transfer, penalties, etc.
  source: z.string().trim().max(250).optional(),
  notes: z.string().trim().max(500).optional(),
});

function parseMonthYear(query: Record<string, unknown>) {
  const now = new Date();
  const rawM = query?.month;
  const rawY = query?.year;
  const mPick = Array.isArray(rawM) ? rawM[0] : rawM;
  const yPick = Array.isArray(rawY) ? rawY[0] : rawY;
  const month = Number(mPick ?? now.getMonth() + 1);
  const year = Number(yPick ?? now.getFullYear());
  return {
    month: Number.isFinite(month) && month >= 1 && month <= 12 ? month : now.getMonth() + 1,
    year: Number.isFinite(year) && year >= 2000 ? year : now.getFullYear(),
  };
}

function tenantSocietyId(req: { auth?: { societyId?: string | null } }): string | null {
  const sid = typeof req.auth?.societyId === "string" ? req.auth.societyId.trim() : "";
  return sid.length > 0 ? sid : null;
}

function buildMaintenancePdfBuffer(params: {
  title: string;
  month: number;
  year: number;
  summaryRows: Array<{ label: string; value: string }>;
  pendingRows: Array<{ villaNumber: string; ownerName: string; amount: number; month: number; year: number }>;
}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text(params.title, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Period: ${params.month}/${params.year}`);
    doc.text(`Generated: ${new Date().toLocaleString()}`);
    doc.moveDown();

    doc.fontSize(13).text("Summary");
    doc.moveDown(0.4);
    params.summaryRows.forEach((row) => {
      doc.fontSize(11).text(`${row.label}: ${row.value}`);
    });
    doc.moveDown();

    doc.fontSize(13).text("Pending Dues");
    doc.moveDown(0.4);
    doc.fontSize(10).text("Villa", 40, doc.y, { continued: true, width: 70 });
    doc.text("Owner", { continued: true, width: 160 });
    doc.text("Month/Year", { continued: true, width: 90 });
    doc.text("Amount", { width: 80, align: "right" });
    doc.moveDown(0.2);

    params.pendingRows.slice(0, 120).forEach((row) => {
      doc.fontSize(10).text(row.villaNumber || "-", 40, doc.y, { continued: true, width: 70 });
      doc.text(row.ownerName || "-", { continued: true, width: 160 });
      doc.text(`${row.month}/${row.year}`, { continued: true, width: 90 });
      doc.text(`Rs. ${Number(row.amount).toFixed(0)}`, { width: 80, align: "right" });
    });

    doc.end();
  });
}

// GET /api/maintenance-management/month/:year/:month
// Get all villa payment statuses for a specific month
router.get("/month/:year/:month", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const { societyId } = req.auth!;

    // Validate inputs
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ message: "Invalid year or month" });
    }

    // Get all villas in the society
    const villas = await prisma.villa.findMany({
      where: { societyId },
      select: {
        id: true,
        villaNumber: true,
        block: true,
        ownerName: true,
        monthlyMaintenance: true,
      },
      orderBy: { villaNumber: "asc" },
    });

    // Get all maintenance records for this month
    const maintenanceRecords = await prisma.maintenance.findMany({
      where: {
        societyId,
        year,
        month,
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            ownerName: true,
          },
        },
      },
    });

    // Get all payments for this month
    const payments = await prisma.maintenancePayment.findMany({
      where: {
        societyId,
        year,
        month,
      },
      orderBy: { paymentDate: "desc" },
    });

    // Create maps
    const maintenanceMap = new Map(
      maintenanceRecords.map((m) => [m.villaId, m])
    );
    const paymentMap = new Map(
      payments.map((p) => [p.villaId, p])
    );

    // Build response with payment status for each villa
    const villaPayments = villas.map((villa) => {
      const maintenance = maintenanceMap.get(villa.id);
      const payment = paymentMap.get(villa.id);

      // Determine status
      let status = "UNPAID";
      let daysOverdue = 0;
      
      if (maintenance) {
        status = maintenance.status;
        
        if (maintenance.status === "OVERDUE" && maintenance.dueDate) {
          const today = new Date();
          const dueDate = new Date(maintenance.dueDate);
          daysOverdue = Math.floor(
            (today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
          );
        }
      }

      return {
        villaId: villa.id,
        villaNumber: villa.villaNumber,
        block: villa.block,
        ownerName: villa.ownerName,
        amount: villa.monthlyMaintenance,
        status,
        daysOverdue,
        maintenanceId: maintenance?.id || null,
        dueDate: maintenance?.dueDate || null,
        paymentDate: payment?.paymentDate || null,
        receiptNumber: payment?.receiptNumber || null,
        paymentMode: payment?.paymentMode || null,
      };
    });

    // Calculate summary statistics
    const totalVillas = villas.length;
    const paidCount = villaPayments.filter((v) => v.status === "PAID").length;
    const unpaidCount = villaPayments.filter(
      (v) => v.status === "PENDING" || v.status === "UNPAID"
    ).length;
    const overdueCount = villaPayments.filter((v) => v.status === "OVERDUE").length;

    const totalAmount = villas.reduce(
      (sum, v) => sum + Number(v.monthlyMaintenance),
      0
    );
    const collectedAmount = villaPayments
      .filter((v) => v.status === "PAID")
      .reduce((sum, v) => sum + Number(v.amount), 0);
    const pendingAmount = totalAmount - collectedAmount;

    const collectionRate = totalAmount > 0 
      ? Math.round((collectedAmount / totalAmount) * 100) 
      : 0;

    return res.json({
      summary: {
        year,
        month,
        totalVillas,
        paidCount,
        unpaidCount,
        overdueCount,
        totalAmount,
        collectedAmount,
        pendingAmount,
        collectionRate,
      },
      villaPayments,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance-management/mark-paid
// Mark a villa's maintenance as paid
const markPaidSchema = z.object({
  // Accept legacy UUID and current CUID ids.
  villaId: z.string().min(1),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  amount: z.number().nonnegative(),
  paymentDate: z.string().datetime(),
  paymentMode: z.enum(["CASH", "UPI", "CHEQUE", "BANK_TRANSFER"]),
  transactionId: z.string().optional(),
  bankAccountId: z.string().min(1).optional(),
  remarks: z.string().trim().optional(),
  /// When set, payment is allocated to a billing-cycle snapshot (partial payments allowed).
  maintenanceCollectionCycleId: z.string().min(1).optional(),
  /// When true with amount=0, triggers credit walker to settle via advance credit.
  applyCredit: z.boolean().optional(),
}).refine(
  (d) => d.amount > 0 || d.applyCredit === true,
  { message: "Either amount must be positive or applyCredit must be true", path: ["amount"] },
);

router.post("/mark-paid", validateBody(markPaidSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const body = req.body as z.infer<typeof markPaidSchema>;

    // Check if villa exists
    const villa = await prisma.villa.findFirst({
      where: {
        id: body.villaId,
        societyId,
      },
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    if (body.maintenanceCollectionCycleId) {
      const adminId = req.auth!.userId;
      const cycle = await prisma.maintenanceCollectionCycle.findFirst({
        where: { id: body.maintenanceCollectionCycleId, societyId },
      });
      if (!cycle) {
        return res.status(404).json({ message: "Billing cycle not found" });
      }
      if (cycle.status === "LOCKED") {
        return res.status(400).json({ message: "This billing cycle is locked" });
      }
      if (cycle.periodMonth !== body.month || cycle.periodYear !== body.year) {
        return res.status(400).json({ message: "month and year must match the selected billing cycle" });
      }

      // Validate snapshot exists (lightweight check outside transaction)
      const [snapshotCheck, markPaidExclusion] = await Promise.all([
        prisma.villaMaintenanceSnapshot.findUnique({
          where: {
            cycleId_villaId: { cycleId: cycle.id, villaId: body.villaId },
          },
          select: { id: true },
        }),
        prisma.cycleVillaExclusion.findUnique({
          where: { cycleId_villaId: { cycleId: cycle.id, villaId: body.villaId } },
          select: { id: true },
        }),
      ]);
      if (!snapshotCheck) {
        return res
          .status(400)
          .json({ message: "No billing snapshot for this villa. Generate snapshots for the cycle first." });
      }
      if (markPaidExclusion) {
        return res.status(400).json({ message: "Villa is excluded from this cycle. Re-include it first." });
      }

      const receiptNumber = `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

      try {
      const { payment, maintenance } = await prisma.$transaction(async (tx) => {
        // Re-read snapshot inside transaction with row-level lock to
        // prevent concurrent mark-paid calls from double-counting.
        // Timeout raised for Neon cold-start latency + credit-walker queries.
        const [snapshot] = await tx.$queryRawUnsafe<
          { id: string; expectedAmount: string; paidAmount: string }[]
        >(
          `SELECT id, "expectedAmount"::text, "paidAmount"::text FROM "VillaMaintenanceSnapshot" WHERE id = $1 FOR UPDATE`,
          snapshotCheck.id,
        );
        if (!snapshot) {
          throw new Error("Snapshot disappeared during transaction");
        }

        const expected = Number(snapshot.expectedAmount);
        const paidSoFar = Number(snapshot.paidAmount);
        const _remaining = Math.round((expected - paidSoFar) * 100) / 100;
        const maintenanceRow = await tx.maintenance.upsert({
          where: {
            villaId_month_year: { villaId: body.villaId, month: body.month, year: body.year },
          },
          create: {
            societyId,
            villaId: body.villaId,
            month: body.month,
            year: body.year,
            amount: snapshot.expectedAmount,
            dueDate: cycle.dueDate,
            status: "PENDING",
          },
          update: {
            amount: snapshot.expectedAmount,
            dueDate: cycle.dueDate,
          },
        });

        const paymentRow = await tx.maintenancePayment.create({
          data: {
            societyId,
            villaId: body.villaId,
            maintenanceId: maintenanceRow.id,
            month: body.month,
            year: body.year,
            amount: body.amount,
            paymentDate: new Date(body.paymentDate),
            paymentMode: body.paymentMode,
            transactionId: body.transactionId,
            receiptNumber,
            bankAccountId: body.bankAccountId,
            remarks: body.remarks,
            maintenanceCollectionCycleId: cycle.id,
            villaMaintenanceSnapshotId: snapshot.id,
          },
          include: {
            villa: {
              select: {
                villaNumber: true,
                ownerName: true,
              },
            },
          },
        });

        // Don't increment snapshot.paidAmount inline — the credit walker
        // re-derives it from the cash ledger across the whole FY so any
        // Reconcile snapshots up to this cycle only. Any overpayment
        // stays as available advance credit — the admin must explicitly
        // apply it to a subsequent cycle via "Apply credit".
        await applyVillaCreditAcrossSnapshots(tx, {
          societyId,
          villaId: body.villaId,
          financialYearId: cycle.financialYearId,
          throughCycleId: cycle.id,
        });

        // Read back the (possibly cap-adjusted) status so the rest of this
        // handler — which writes legacy UserCyclePayment rows — uses the
        // reconciled value.
        const reconciledSnapshot = await tx.villaMaintenanceSnapshot.findUnique({
          where: { id: snapshot.id },
          select: { status: true, paidAmount: true },
        });
        const snapStatus = reconciledSnapshot?.status ?? "PENDING";

        const billingCycle = await tx.billingCycle.findFirst({
          where: {
            societyId,
            financialYearId: cycle.financialYearId,
            cycleKey: cycle.periodKey,
          },
          select: { id: true },
        });
        if (billingCycle) {
          await clearExcludedResidentsUserCyclePayments(tx, {
            societyId,
            villaId: body.villaId,
            billingCycleId: billingCycle.id,
          });
          const primaryResidents = await tx.user.findMany({
            where: {
              societyId,
              villaId: body.villaId,
              role: { in: [UserRole.RESIDENT, UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] },
              isActive: true,
              maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
            },
            select: { id: true },
          });
          const payStatus =
            snapStatus === "PAID" || snapStatus === "WAIVED"
              ? BillingUserPaymentStatus.SUCCESS
              : BillingUserPaymentStatus.PENDING;
          const paidAt = new Date(body.paymentDate);
          for (const u of primaryResidents) {
            // userCyclePayment.amountPaid is synced from the reconciled
            // snapshot so it stays consistent with the villa-level ledger.
            const updatedAmount = Number(reconciledSnapshot?.paidAmount ?? 0);
            await tx.userCyclePayment.upsert({
              where: { userId_cycleId: { userId: u.id, cycleId: billingCycle.id } },
              create: {
                userId: u.id,
                cycleId: billingCycle.id,
                amountPaid: new Prisma.Decimal(updatedAmount),
                paymentStatus: payStatus,
                source: BillingPaymentSource.CASH_MANUAL,
                manualMarkedByAdminId: adminId,
                paidAt,
              },
              update: {
                amountPaid: new Prisma.Decimal(updatedAmount),
                paymentStatus: payStatus,
                source: BillingPaymentSource.CASH_MANUAL,
                manualMarkedByAdminId: adminId,
                paidAt,
              },
            });
          }
          if (billingCycle) {
            await ensureVillaLedgersAligned(tx, {
              societyId,
              villaId: body.villaId,
              billingCycleId: billingCycle.id,
            });
          }
        }

        return { payment: paymentRow, maintenance: maintenanceRow };
      }, { timeout: 15000 });

      invalidateReconcileCache(body.villaId);

      // Notify villa residents about payment recorded
      void (async () => {
        try {
          const residents = await prisma.user.findMany({
            where: { villaId: body.villaId, societyId, role: { in: [UserRole.RESIDENT, UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] }, isActive: true },
            select: { id: true },
          });
          if (residents.length > 0) {
            const monthName = new Date(body.year, body.month - 1).toLocaleString("en-US", { month: "long" });
            await notifyUsers(
              residents.map((r) => r.id),
              {
                title: "Maintenance payment recorded",
                body: `Your maintenance payment of \u20B9${body.amount} for ${monthName} ${body.year} has been recorded.`,
                data: { type: "MAINTENANCE_PAYMENT_RECORDED", villaId: body.villaId },
              },
              { category: NotificationCategory.MAINTENANCE },
            );
          }
        } catch {
          // Fire-and-forget
        }
      })();

      return res.status(201).json({
        message: "Payment marked successfully",
        payment,
        maintenance,
      });
    } catch (txErr: unknown) {
      // Handle errors thrown from inside the transaction for validation
      if (txErr && typeof txErr === "object" && "statusCode" in txErr) {
        const e = txErr as { statusCode: number; message: string };
        return res.status(e.statusCode).json({ message: e.message });
      }
      throw txErr;
    }
    }

    // ── Non-cycle path (legacy, no billing cycle selected) ──
    // Find or create maintenance record
    let maintenance = await prisma.maintenance.findFirst({
      where: {
        societyId,
        villaId: body.villaId,
        year: body.year,
        month: body.month,
      },
    });

    if (!maintenance) {
      // Create maintenance record if it doesn't exist
      const dueDate = new Date(body.year, body.month - 1, 5);
      maintenance = await prisma.maintenance.create({
        data: {
          societyId,
          villaId: body.villaId,
          year: body.year,
          month: body.month,
          amount: body.amount,
          dueDate,
          status: "PAID",
        },
      });
    } else {
      // Update existing maintenance to PAID
      maintenance = await prisma.maintenance.update({
        where: { id: maintenance.id },
        data: { status: "PAID" },
      });
    }

    const existingPayment = await prisma.maintenancePayment.findFirst({
      where: {
        societyId,
        villaId: body.villaId,
        year: body.year,
        month: body.month,
      },
      orderBy: { paymentDate: "desc" },
      select: { id: true, receiptNumber: true },
    });

    const receiptNumber = existingPayment?.receiptNumber ?? `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    // Legacy path: always create a new payment record (append-only) to avoid
    // overwriting previous partial payments. Existing payment is only used for
    // receipt-number reuse.
    const payment = existingPayment
      ? await prisma.maintenancePayment.create({
          data: {
            societyId,
            villaId: body.villaId,
            maintenanceId: maintenance.id,
            amount: body.amount,
            month: body.month,
            year: body.year,
            paymentDate: new Date(body.paymentDate),
            paymentMode: body.paymentMode,
            transactionId: body.transactionId,
            receiptNumber: `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            bankAccountId: body.bankAccountId,
            remarks: body.remarks,
          },
          include: {
            villa: {
              select: {
                villaNumber: true,
                ownerName: true,
              },
            },
          },
        })
      : await prisma.maintenancePayment.create({
          data: {
            societyId,
            villaId: body.villaId,
            maintenanceId: maintenance.id,
            amount: body.amount,
            month: body.month,
            year: body.year,
            paymentDate: new Date(body.paymentDate),
            paymentMode: body.paymentMode,
            transactionId: body.transactionId,
            receiptNumber,
            bankAccountId: body.bankAccountId,
            remarks: body.remarks,
          },
          include: {
            villa: {
              select: {
                villaNumber: true,
                ownerName: true,
              },
            },
          },
        });

    // Notify villa residents about payment recorded (legacy path)
    void (async () => {
      try {
        const residents = await prisma.user.findMany({
          where: { villaId: body.villaId, societyId, role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN] }, isActive: true },
          select: { id: true },
        });
        if (residents.length > 0) {
          const monthName = new Date(body.year, body.month - 1).toLocaleString("en-US", { month: "long" });
          await notifyUsers(
            residents.map((r) => r.id),
            {
              title: "Maintenance payment recorded",
              body: `Your maintenance payment of \u20B9${body.amount} for ${monthName} ${body.year} has been recorded.`,
              data: { type: "MAINTENANCE_PAYMENT_RECORDED", villaId: body.villaId },
            },
            { category: NotificationCategory.SYSTEM },
          );
        }
      } catch {
        // Fire-and-forget
      }
    })();

    return res.status(201).json({
      message: "Payment marked successfully",
      payment,
      maintenance,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance-management/reverse-payment
// Reverse all payments for a villa in a billing cycle (admin undo)
const reversePaymentSchema = z.object({
  villaId: z.string().min(1),
  maintenanceCollectionCycleId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

router.post("/reverse-payment", validateBody(reversePaymentSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const adminId = req.auth!.userId;
    const body = req.body as z.infer<typeof reversePaymentSchema>;

    const villa = await prisma.villa.findFirst({ where: { id: body.villaId, societyId } });
    if (!villa) return res.status(404).json({ message: "Villa not found" });

    const cycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { id: body.maintenanceCollectionCycleId, societyId },
    });
    if (!cycle) return res.status(404).json({ message: "Billing cycle not found" });
    if (cycle.status === "LOCKED") {
      return res.status(400).json({ message: "This billing cycle is locked" });
    }

    const snapshotCheck = await prisma.villaMaintenanceSnapshot.findUnique({
      where: { cycleId_villaId: { cycleId: cycle.id, villaId: body.villaId } },
      select: { id: true },
    });
    if (!snapshotCheck) {
      return res.status(400).json({ message: "No billing snapshot for this villa." });
    }

    // Count existing payments to guard against no-op reversals
    const paymentCount = await prisma.maintenancePayment.count({
      where: {
        societyId,
        villaId: body.villaId,
        maintenanceCollectionCycleId: cycle.id,
      },
    });
    if (paymentCount === 0) {
      return res.status(400).json({ message: "No payments found to reverse for this billing cycle" });
    }

    await prisma.$transaction(async (tx) => {
      // Lock the snapshot row to prevent concurrent modifications
      await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "VillaMaintenanceSnapshot" WHERE id = $1 FOR UPDATE`,
        snapshotCheck.id,
      );

      // Delete all payments linked to this cycle + villa
      await tx.maintenancePayment.deleteMany({
        where: {
          societyId,
          villaId: body.villaId,
          maintenanceCollectionCycleId: cycle.id,
        },
      });

      // Re-derive snapshot via credit walker (paidAmount → 0)
      await applyVillaCreditAcrossSnapshots(tx, {
        societyId,
        villaId: body.villaId,
        financialYearId: cycle.financialYearId,
        throughCycleId: cycle.id,
      });

      // Admin reversed all cash payments for this cycle — do not leave advance
      // credit from other months applied here (walker would re-mark as paid).
      const dueDateUtc = new Date(
        Date.UTC(
          cycle.dueDate.getUTCFullYear(),
          cycle.dueDate.getUTCMonth(),
          cycle.dueDate.getUTCDate(),
        ),
      );
      const nowUtc = new Date();
      const snapStatus = dueDateUtc.getTime() < nowUtc.getTime() ? "OVERDUE" : "PENDING";

      await tx.villaMaintenanceSnapshot.update({
        where: { id: snapshotCheck.id },
        data: {
          paidAmount: new Prisma.Decimal(0),
          status: snapStatus,
          lateFeeAmount: 0,
          lateFeeAppliedAt: null,
        },
      });

      await tx.maintenance.updateMany({
        where: {
          societyId,
          villaId: body.villaId,
          month: cycle.periodMonth,
          year: cycle.periodYear,
        },
        data: { status: snapStatus === "OVERDUE" ? "OVERDUE" : "PENDING" },
      });

      // Sync UserCyclePayment
      const billingCycle = await tx.billingCycle.findFirst({
        where: { societyId, financialYearId: cycle.financialYearId, cycleKey: cycle.periodKey },
        select: { id: true },
      });
      if (billingCycle) {
        await clearExcludedResidentsUserCyclePayments(tx, {
          societyId,
          villaId: body.villaId,
          billingCycleId: billingCycle.id,
        });
        await syncBillingUserCyclePaymentsFromSnapshot(tx, {
          societyId,
          villaId: body.villaId,
          billingCycleId: billingCycle.id,
          paidAmount: 0,
          snapStatus,
          source: BillingPaymentSource.CASH_MANUAL,
        });
        const primaryResidents = await tx.user.findMany({
          where: {
            societyId,
            villaId: body.villaId,
            ...residentLikeRoleFilter,
            isActive: true,
            maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
          },
          select: { id: true },
        });
        for (const u of primaryResidents) {
          await tx.userCyclePayment.updateMany({
            where: { userId: u.id, cycleId: billingCycle.id },
            data: {
              paymentGatewayOrderId: null,
              paymentGatewayPaymentId: null,
              idempotencyKey: null,
            },
          });
        }
      }
    }, { timeout: 15000 });

    // Fire-and-forget: audit log
    auditFromRequest(req, {
      societyId,
      adminId,
      action: "PAYMENT_REVERSED",
      entityType: "Villa",
      entityId: body.villaId,
      metadata: {
        villaNumber: villa.villaNumber,
        cycleId: cycle.id,
        periodMonth: cycle.periodMonth,
        periodYear: cycle.periodYear,
        reason: body.reason || undefined,
        paymentsDeleted: paymentCount,
      },
    });

    // Fire-and-forget: push notification to villa residents
    void (async () => {
      try {
        const residents = await prisma.user.findMany({
          where: { villaId: body.villaId, societyId, role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN] }, isActive: true },
          select: { id: true },
        });
        if (residents.length > 0) {
          const monthName = new Date(cycle.periodYear, cycle.periodMonth - 1).toLocaleString("en-US", { month: "long" });
          await notifyUsers(
            residents.map((r) => r.id),
            {
              title: "Payment reversed by admin",
              body: `Your maintenance payment for ${monthName} ${cycle.periodYear} has been reversed by admin.${body.reason ? ` Reason: ${body.reason}` : ""}`,
              data: { type: "MAINTENANCE_PAYMENT_REVERSED", villaId: body.villaId },
            },
            { category: NotificationCategory.SYSTEM },
          );
        }
      } catch {
        // Fire-and-forget
      }
    })();

    return res.status(200).json({
      message: `Payment reversed for Villa ${villa.villaNumber}`,
      paymentsDeleted: paymentCount,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance-management/apply-credit
// Apply advance credit from prior overpayments to a billing cycle
const applyCreditSchema = z.object({
  villaId: z.string().min(1),
  maintenanceCollectionCycleId: z.string().min(1),
});

router.post("/apply-credit", validateBody(applyCreditSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const adminId = req.auth!.userId;
    const body = req.body as z.infer<typeof applyCreditSchema>;

    const villa = await prisma.villa.findFirst({ where: { id: body.villaId, societyId } });
    if (!villa) return res.status(404).json({ message: "Villa not found" });

    const cycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { id: body.maintenanceCollectionCycleId, societyId },
    });
    if (!cycle) return res.status(404).json({ message: "Billing cycle not found" });
    if (cycle.status === "LOCKED") {
      return res.status(400).json({ message: "This billing cycle is locked" });
    }

    const [snapshot, applyCreditExclusion] = await Promise.all([
      prisma.villaMaintenanceSnapshot.findUnique({
        where: { cycleId_villaId: { cycleId: cycle.id, villaId: body.villaId } },
      }),
      prisma.cycleVillaExclusion.findUnique({
        where: { cycleId_villaId: { cycleId: cycle.id, villaId: body.villaId } },
        select: { id: true },
      }),
    ]);
    if (!snapshot) {
      return res.status(400).json({ message: "No billing snapshot for this villa." });
    }
    if (applyCreditExclusion) {
      return res.status(400).json({ message: "Villa is excluded from this cycle. Re-include it first." });
    }

    const expectedAmt = Number(snapshot.expectedAmount);
    const paidSoFar = Number(snapshot.paidAmount);
    const remaining = Math.round((expectedAmt - paidSoFar) * 100) / 100;
    if (remaining <= 0) {
      return res.status(400).json({ message: "No balance due for this billing cycle" });
    }

    const { creditPool } = await getVillaCreditBalance(prisma, {
      societyId,
      villaId: body.villaId,
      financialYearId: cycle.financialYearId,
    });
    if (creditPool <= 0) {
      return res.status(400).json({ message: "No advance credit available for this villa" });
    }

    const creditApplied = Math.min(creditPool, remaining);

    const result = await prisma.$transaction(async (tx) => {
      const maintenanceRow = await tx.maintenance.upsert({
        where: {
          villaId_month_year: { villaId: body.villaId, month: cycle.periodMonth, year: cycle.periodYear },
        },
        create: {
          societyId,
          villaId: body.villaId,
          month: cycle.periodMonth,
          year: cycle.periodYear,
          amount: snapshot.expectedAmount,
          dueDate: cycle.dueDate,
          status: "PENDING",
        },
        update: {},
      });

      // Create a ₹0 audit marker payment so the credit application is visible
      // in the payment ledger.
      await tx.maintenancePayment.create({
        data: {
          societyId,
          villaId: body.villaId,
          maintenanceId: maintenanceRow.id,
          month: cycle.periodMonth,
          year: cycle.periodYear,
          amount: 0,
          paymentDate: new Date(),
          paymentMode: "CASH",
          receiptNumber: `CRD-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          remarks: `Advance credit adjustment (₹${creditApplied} applied)`,
          maintenanceCollectionCycleId: cycle.id,
          villaMaintenanceSnapshotId: snapshot.id,
        },
      });

      // Walk up to this cycle so prior overpayment credit flows in.
      await applyVillaCreditAcrossSnapshots(tx, {
        societyId,
        villaId: body.villaId,
        financialYearId: cycle.financialYearId,
        throughCycleId: cycle.id,
      });

      const reconciledSnapshot = await tx.villaMaintenanceSnapshot.findUnique({
        where: { id: snapshot.id },
        select: { paidAmount: true, status: true },
      });

      // Sync UserCyclePayment (same pattern as mark-paid)
      const billingCycle = await tx.billingCycle.findFirst({
        where: { societyId, financialYearId: cycle.financialYearId, cycleKey: cycle.periodKey },
        select: { id: true },
      });
      if (billingCycle) {
        await clearExcludedResidentsUserCyclePayments(tx, {
          societyId,
          villaId: body.villaId,
          billingCycleId: billingCycle.id,
        });
        const snapStatus = reconciledSnapshot?.status ?? "PENDING";
        const payStatus =
          snapStatus === "PAID" || snapStatus === "WAIVED"
            ? BillingUserPaymentStatus.SUCCESS
            : BillingUserPaymentStatus.PENDING;
        const primaryResidents = await tx.user.findMany({
          where: {
            societyId,
            villaId: body.villaId,
            ...residentLikeRoleFilter,
            isActive: true,
            maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
          },
          select: { id: true },
        });
        for (const u of primaryResidents) {
          await tx.userCyclePayment.upsert({
            where: { userId_cycleId: { userId: u.id, cycleId: billingCycle.id } },
            create: {
              userId: u.id,
              cycleId: billingCycle.id,
              amountPaid: new Prisma.Decimal(Number(reconciledSnapshot?.paidAmount ?? 0)),
              paymentStatus: payStatus,
              source: BillingPaymentSource.CASH_MANUAL,
              manualMarkedByAdminId: adminId,
              paidAt: new Date(),
            },
            update: {
              amountPaid: new Prisma.Decimal(Number(reconciledSnapshot?.paidAmount ?? 0)),
              paymentStatus: payStatus,
              source: BillingPaymentSource.CASH_MANUAL,
              manualMarkedByAdminId: adminId,
              paidAt: new Date(),
            },
          });
        }
      }

      return {
        paidAmount: Number(reconciledSnapshot?.paidAmount ?? 0),
        status: reconciledSnapshot?.status ?? "PENDING",
      };
    }, { timeout: 15000 });

    invalidateReconcileCache(body.villaId);

    return res.status(200).json({
      message: "Advance credit applied successfully",
      creditApplied,
      paidAmount: result.paidAmount,
      status: result.status,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance-management/manual-credit-adjustment
// Manually add or deduct advance credit for a villa in the selected cycle
const manualCreditAdjustmentSchema = z.object({
  villaId: z.string().min(1),
  maintenanceCollectionCycleId: z.string().min(1),
  amount: z.number().refine((v) => v !== 0, "Amount must not be zero"),
  remarks: z.string().trim().min(1, "Remarks are required"),
});

router.post(
  "/manual-credit-adjustment",
  validateBody(manualCreditAdjustmentSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const body = req.body as z.infer<typeof manualCreditAdjustmentSchema>;

      const villa = await prisma.villa.findFirst({
        where: { id: body.villaId, societyId },
      });
      if (!villa) return res.status(404).json({ message: "Villa not found" });

      // The cycle is used only to identify the financial year and validate
      // the request context — the payment itself is NOT linked to any cycle
      // so the credit walker won't auto-consume it against expected amounts.
      const [cycle, adjExclusion] = await Promise.all([
        prisma.maintenanceCollectionCycle.findFirst({
          where: { id: body.maintenanceCollectionCycleId, societyId },
        }),
        prisma.cycleVillaExclusion.findUnique({
          where: { cycleId_villaId: { cycleId: body.maintenanceCollectionCycleId, villaId: body.villaId } },
          select: { id: true },
        }),
      ]);
      if (!cycle) return res.status(404).json({ message: "Billing cycle not found" });
      if (adjExclusion) {
        return res.status(400).json({ message: "Villa is excluded from this cycle. Re-include it first." });
      }
      if (cycle.status === "LOCKED") {
        return res.status(400).json({ message: "This billing cycle is locked" });
      }

      // For deductions, verify there is enough credit to deduct
      if (body.amount < 0) {
        const { creditPool } = await getVillaCreditBalance(prisma, {
          societyId,
          villaId: body.villaId,
          financialYearId: cycle.financialYearId,
        });
        if (creditPool < Math.abs(body.amount)) {
          return res.status(400).json({
            message: `Cannot deduct more than available credit (₹${creditPool.toLocaleString("en-IN")})`,
          });
        }
      }

      const adjustmentType = body.amount > 0 ? "added" : "deducted";
      const absAmount = Math.abs(body.amount);
      const adminId = req.auth!.userId;

      const result = await prisma.$transaction(async (tx) => {
        // Create an unlinked payment (no cycle, no snapshot) so the credit
        // walker treats it as a floating adjustment that seeds the credit pool.
        await tx.maintenancePayment.create({
          data: {
            societyId,
            villaId: body.villaId,
            month: cycle.periodMonth,
            year: cycle.periodYear,
            amount: body.amount,
            paymentDate: new Date(),
            paymentMode: "CASH",
            receiptNumber: `ADJ-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            remarks: `Manual credit ${adjustmentType}: ₹${absAmount.toLocaleString("en-IN")} — ${body.remarks}`,
            // Deliberately null — keeps it out of the per-cycle cash sums so
            // the walker won't silently apply it to any cycle's expected amount.
            maintenanceCollectionCycleId: null,
            villaMaintenanceSnapshotId: null,
          },
        });

        // Reconcile snapshots so paidAmount/status reflect the new credit.
        // Without this, the read-only walker would consume credit against
        // unpaid cycles but snapshots would still show paidAmount=0, causing
        // the grid to report advanceCredit=0 for villas with pending cycles.
        await applyVillaCreditAcrossSnapshots(tx, {
          societyId,
          villaId: body.villaId,
          financialYearId: cycle.financialYearId,
          throughCycleId: cycle.id,
        });

        // Sync UserCyclePayment for affected cycles so mobile app reflects
        // the updated status (same pattern as apply-credit).
        const walkedCycles = await tx.maintenanceCollectionCycle.findMany({
          where: { societyId, financialYearId: cycle.financialYearId },
          orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
          select: { id: true, periodMonth: true, periodYear: true, periodKey: true },
        });
        const throughIdx = walkedCycles.findIndex((c) => c.id === cycle.id);
        const cyclesToSync = throughIdx >= 0 ? walkedCycles.slice(0, throughIdx + 1) : walkedCycles;

        for (const wc of cyclesToSync) {
          const snap = await tx.villaMaintenanceSnapshot.findUnique({
            where: { cycleId_villaId: { cycleId: wc.id, villaId: body.villaId } },
            select: { paidAmount: true, status: true },
          });
          if (!snap) continue;

          const billingCycle = await tx.billingCycle.findFirst({
            where: { societyId, financialYearId: cycle.financialYearId, cycleKey: wc.periodKey },
            select: { id: true },
          });
          if (!billingCycle) continue;

          await clearExcludedResidentsUserCyclePayments(tx, {
            societyId,
            villaId: body.villaId,
            billingCycleId: billingCycle.id,
          });

          const snapStatus = snap.status;
          const payStatus =
            snapStatus === "PAID" || snapStatus === "WAIVED"
              ? BillingUserPaymentStatus.SUCCESS
              : BillingUserPaymentStatus.PENDING;
          const primaryResidents = await tx.user.findMany({
            where: {
              societyId,
              villaId: body.villaId,
              role: { in: [UserRole.RESIDENT, UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] },
              isActive: true,
              maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
            },
            select: { id: true },
          });
          for (const u of primaryResidents) {
            await tx.userCyclePayment.upsert({
              where: { userId_cycleId: { userId: u.id, cycleId: billingCycle.id } },
              create: {
                userId: u.id,
                cycleId: billingCycle.id,
                amountPaid: new Prisma.Decimal(Number(snap.paidAmount)),
                paymentStatus: payStatus,
                source: BillingPaymentSource.CASH_MANUAL,
                manualMarkedByAdminId: adminId,
                paidAt: new Date(),
              },
              update: {
                amountPaid: new Prisma.Decimal(Number(snap.paidAmount)),
                paymentStatus: payStatus,
                source: BillingPaymentSource.CASH_MANUAL,
                manualMarkedByAdminId: adminId,
                paidAt: new Date(),
              },
            });
          }
        }

        // Read credit balance after reconciliation
        const { creditPool } = await getVillaCreditBalance(tx, {
          societyId,
          villaId: body.villaId,
          financialYearId: cycle.financialYearId,
        });
        return { creditPool };
      }, { timeout: 15000 });

      return res.status(200).json({
        message: `₹${absAmount.toLocaleString("en-IN")} advance credit ${adjustmentType} for Villa ${villa.villaNumber}`,
        adjustmentType,
        amount: absAmount,
        newCreditBalance: result.creditPool,
      });
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/maintenance-management/year-report/:year
// Get year-wise payment report
router.get("/year-report/:year", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const { societyId } = req.auth!;

    if (isNaN(year)) {
      return res.status(400).json({ message: "Invalid year" });
    }

    // Fetch historical maintenance records, snapshot totals per cycle, and
    // payment data in parallel.  Maintenance records store per-villa
    // expectedAmount at the time a billing cycle was generated, so they
    // reflect the actual rate that was in effect — not the current rate.
    const [maintenanceRecords, snapshotCycleTotals, yearPayments, villas] =
      await Promise.all([
        prisma.maintenance.findMany({
          where: { societyId, year },
          select: { month: true, amount: true },
        }),
        // Aggregate snapshot expected/paid per collection cycle that falls in
        // this calendar year.  Snapshots are the canonical source of truth.
        prisma.maintenanceCollectionCycle.findMany({
          where: { societyId, periodYear: year },
          select: {
            periodMonth: true,
            snapshots: {
              select: { expectedAmount: true, paidAmount: true, status: true },
            },
          },
        }),
        prisma.maintenancePayment.findMany({
          where: { societyId, year },
          select: { month: true, amount: true },
        }),
        // Current villa rates — used only as a last-resort fallback for months
        // that have neither Maintenance records nor snapshots.
        prisma.villa.findMany({
          where: { societyId },
          select: { monthlyMaintenance: true },
        }),
      ]);

    // Build per-month expected totals from historical Maintenance records.
    const expectedFromMaintenance = new Map<number, number>();
    for (const m of maintenanceRecords) {
      expectedFromMaintenance.set(
        m.month,
        (expectedFromMaintenance.get(m.month) ?? 0) + Number(m.amount)
      );
    }

    // Build per-month expected + collected totals from VillaMaintenanceSnapshot
    // (canonical source of truth — always preferred over old Maintenance table).
    const expectedFromSnapshots = new Map<number, number>();
    const collectedFromSnapshots = new Map<number, number>();
    const paidCountFromSnapshots = new Map<number, number>();
    for (const c of snapshotCycleTotals) {
      // Exclude WAIVED — matches getCachedMoneySnapshot() behavior.
      const active = c.snapshots.filter((s) => s.status !== "WAIVED");
      const snapExpected = active.reduce(
        (sum, s) => sum + Number(s.expectedAmount),
        0
      );
      const snapCollected = active.reduce(
        (sum, s) => sum + Number(s.paidAmount),
        0
      );
      const snapPaidCount = active.filter((s) => s.status === "PAID").length;
      if (snapExpected > 0 || snapCollected > 0) {
        expectedFromSnapshots.set(
          c.periodMonth,
          (expectedFromSnapshots.get(c.periodMonth) ?? 0) + snapExpected
        );
        collectedFromSnapshots.set(
          c.periodMonth,
          (collectedFromSnapshots.get(c.periodMonth) ?? 0) + snapCollected
        );
        paidCountFromSnapshots.set(
          c.periodMonth,
          (paidCountFromSnapshots.get(c.periodMonth) ?? 0) + snapPaidCount
        );
      }
    }

    // Fallback: sum of current villa.monthlyMaintenance (only used when
    // neither historical source has data for a month).
    const currentMonthlyTotal = villas.reduce(
      (sum, v) => sum + Number(v.monthlyMaintenance),
      0
    );

    // Build per-month collected totals from payments.
    const collectedByMonth = new Map<number, number>();
    const paymentCountByMonth = new Map<number, number>();
    for (const p of yearPayments) {
      collectedByMonth.set(
        p.month,
        (collectedByMonth.get(p.month) ?? 0) + Number(p.amount)
      );
      paymentCountByMonth.set(
        p.month,
        (paymentCountByMonth.get(p.month) ?? 0) + 1
      );
    }

    const monthlyData = [];

    for (let month = 1; month <= 12; month++) {
      // Prefer snapshot totals (canonical), then historical Maintenance
      // records, then fall back to the current villa rates.
      const hasSnapshot = expectedFromSnapshots.has(month);
      const totalAmount = hasSnapshot
        ? expectedFromSnapshots.get(month)!
        : (expectedFromMaintenance.get(month) ?? currentMonthlyTotal);

      // When snapshots exist, use snapshot paidAmount (reconciled) for
      // collected; otherwise fall back to raw MaintenancePayment sums.
      const collected = hasSnapshot
        ? collectedFromSnapshots.get(month) ?? 0
        : (collectedByMonth.get(month) ?? 0);
      const pending = Math.max(0, totalAmount - collected);
      const collectionRate =
        totalAmount > 0 ? Math.round((collected / totalAmount) * 100) : 0;

      monthlyData.push({
        month,
        totalAmount,
        collected,
        pending,
        collectionRate,
        paymentCount: hasSnapshot
          ? (paidCountFromSnapshots.get(month) ?? 0)
          : (paymentCountByMonth.get(month) ?? 0),
      });
    }

    // Calculate yearly totals from per-month data (not a flat multiply).
    const yearlyTotal = monthlyData.reduce((sum, m) => sum + m.totalAmount, 0);
    const yearlyCollected = monthlyData.reduce((sum, m) => sum + m.collected, 0);
    const yearlyPending = Math.max(0, yearlyTotal - yearlyCollected);
    const yearlyRate = yearlyTotal > 0
      ? Math.round((yearlyCollected / yearlyTotal) * 100)
      : 0;

    return res.json({
      year,
      yearlyTotal,
      yearlyCollected,
      yearlyPending,
      yearlyRate,
      monthlyData,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/maintenance-management/profit-loss/:year
 *
 * Unified Profit & Loss report combining:
 *  - Income: maintenance collections + additional funds (merged)
 *  - Expenses: society expenses by category
 *  - Net surplus/deficit per month
 *
 * Uses getCachedMoneySnapshot for authoritative cash numbers.
 */
router.get("/profit-loss/:year", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const societyId = req.auth!.societyId!;

    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }

    const snap = await getCachedMoneySnapshot(prisma, societyId);

    // Expense category breakdown per month
    const expenseSummaries = await prisma.monthlyExpenseSummary.findMany({
      where: { societyId, year },
      select: { month: true, totalExpenses: true, categoryBreakdown: true },
    });
    const expenseByMonth = new Map<number, { total: number; categories: Record<string, number> }>();
    for (const s of expenseSummaries) {
      expenseByMonth.set(s.month, {
        total: Number(s.totalExpenses),
        categories: (s.categoryBreakdown as Record<string, number>) ?? {},
      });
    }

    // Build month-by-month P&L
    const months = [];
    let totalIncome = 0;
    let totalExpenses = 0;

    for (let m = 1; m <= 12; m++) {
      const maintenance = snap.maintenanceCashForMonth(m, year);
      const additional = snap.additionalFundsForMonth(m, year);
      const income = maintenance + additional;
      const expenses = expenseByMonth.get(m)?.total ?? snap.expensesForMonth(m, year);
      const net = income - expenses;

      totalIncome += income;
      totalExpenses += expenses;

      months.push({
        month: m,
        maintenance: Math.round(maintenance * 100) / 100,
        additionalFunds: Math.round(additional * 100) / 100,
        totalIncome: Math.round(income * 100) / 100,
        expenses: Math.round(expenses * 100) / 100,
        expenseCategories: expenseByMonth.get(m)?.categories ?? {},
        net: Math.round(net * 100) / 100,
      });
    }

    // Aggregate all expense categories for the year
    const yearCategories: Record<string, number> = {};
    for (const [, v] of expenseByMonth) {
      for (const [cat, amt] of Object.entries(v.categories)) {
        yearCategories[cat] = (yearCategories[cat] ?? 0) + amt;
      }
    }

    return res.json({
      year,
      totalIncome: Math.round(totalIncome * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      netSurplus: Math.round((totalIncome - totalExpenses) * 100) / 100,
      currentFundBalance: Math.round(snap.currentFundBalance * 100) / 100,
      outstandingDues: Math.round(snap.outstandingDues * 100) / 100,
      totalAdvanceCredit: Math.round(snap.totalAdvanceCredit * 100) / 100,
      months,
      expenseCategorySummary: yearCategories,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/maintenance-management/shortfall/:fyId
 *
 * Per-cycle shortfall report for a financial year, matching the Flutter app's
 * Shortfall tab logic. Uses VillaMaintenanceSnapshot as the source of truth
 * for expected/collected per cycle, and MonthlyExpenseSummary for expenses.
 */
router.get("/shortfall/:fyId", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { fyId } = req.params;

    const fy = await prisma.financialYear.findFirst({
      where: { id: fyId, societyId },
    });
    if (!fy) return res.status(404).json({ message: "Financial year not found" });

    const cycles = await prisma.maintenanceCollectionCycle.findMany({
      where: { financialYearId: fyId },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
      select: {
        id: true,
        periodKey: true,
        periodMonth: true,
        periodYear: true,
        title: true,
        dueDate: true,
        status: true,
        snapshots: {
          select: {
            expectedAmount: true,
            paidAmount: true,
            lateFeeAmount: true,
            status: true,
          },
        },
      },
    });

    // Expense summaries for the calendar years this FY spans
    const yearSet = new Set(cycles.map((c) => c.periodYear));
    const expenseSummaries = await prisma.monthlyExpenseSummary.findMany({
      where: { societyId, year: { in: [...yearSet] } },
      select: { month: true, year: true, totalExpenses: true, categoryBreakdown: true },
    });
    const expenseByKey = new Map<string, { total: number; categories: Record<string, number> }>();
    for (const s of expenseSummaries) {
      expenseByKey.set(`${s.year}-${String(s.month).padStart(2, "0")}`, {
        total: Number(s.totalExpenses),
        categories: (s.categoryBreakdown as Record<string, number>) ?? {},
      });
    }

    // Fund snapshot for headline numbers
    const snap = await getCachedMoneySnapshot(prisma, societyId);

    const cycleRows = cycles.map((c) => {
      const active = c.snapshots.filter((s) => s.status !== "WAIVED");
      const totalExpected = active.reduce((sum, s) => sum + Number(s.expectedAmount) + Number(s.lateFeeAmount ?? 0), 0);
      const totalCollected = active.reduce((sum, s) => sum + Number(s.paidAmount), 0);
      const expense = expenseByKey.get(c.periodKey);
      const totalExpense = expense?.total ?? 0;
      const net = totalCollected - totalExpense;
      const paidCount = active.filter((s) => s.status === "PAID").length;
      const unpaidCount = Math.max(0, active.length - paidCount);

      return {
        periodKey: c.periodKey,
        periodMonth: c.periodMonth,
        periodYear: c.periodYear,
        title: c.title,
        dueDate: c.dueDate,
        status: c.status,
        totalExpected: Math.round(totalExpected * 100) / 100,
        totalCollected: Math.round(totalCollected * 100) / 100,
        totalExpense: Math.round(totalExpense * 100) / 100,
        net: Math.round(net * 100) / 100,
        paidCount,
        unpaidCount,
        expenseCategories: expense?.categories ?? {},
      };
    });

    const deficitCycles = cycleRows.filter((c) => c.net < 0);
    const totalShortfall = deficitCycles.reduce((s, c) => s + Math.abs(c.net), 0);

    return res.json({
      financialYear: { id: fy.id, label: fy.label, startDate: fy.startDate, endDate: fy.endDate },
      currentFundBalance: Math.round(snap.currentFundBalance * 100) / 100,
      outstandingDues: Math.round(snap.outstandingDues * 100) / 100,
      totalAdvanceCredit: Math.round(snap.totalAdvanceCredit * 100) / 100,
      totalShortfall: Math.round(totalShortfall * 100) / 100,
      deficitCycleCount: deficitCycles.length,
      totalCycleCount: cycleRows.length,
      cycles: cycleRows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance-management/villa-history/:villaId
// Get complete payment history for a villa
router.get("/villa-history/:villaId", async (req, res, next) => {
  try {
    const { villaId } = req.params;
    const { societyId } = req.auth!;

    // Verify villa exists
    const villa = await prisma.villa.findFirst({
      where: {
        id: villaId,
        societyId,
      },
      select: {
        villaNumber: true,
        block: true,
        ownerName: true,
        monthlyMaintenance: true,
      },
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    // Get all payments for this villa
    const payments = await prisma.maintenancePayment.findMany({
      where: {
        villaId,
        societyId,
      },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      take: 24, // Last 24 months
    });

    // Get maintenance records
    const maintenanceRecords = await prisma.maintenance.findMany({
      where: {
        villaId,
        societyId,
      },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      take: 24,
    });

    // Combine data
    const history = maintenanceRecords.map((m) => {
      const payment = payments.find(
        (p) => p.year === m.year && p.month === m.month
      );

      return {
        year: m.year,
        month: m.month,
        amount: Number(m.amount),
        status: m.status,
        dueDate: m.dueDate,
        paymentDate: payment?.paymentDate || null,
        receiptNumber: payment?.receiptNumber || null,
        paymentMode: payment?.paymentMode || null,
        transactionId: payment?.transactionId || null,
      };
    });

    // Calculate statistics
    const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);

    // Average payment delay: days between due date and payment date for paid bills
    const delays: number[] = [];
    for (const m of maintenanceRecords) {
      const payment = payments.find((p) => p.year === m.year && p.month === m.month);
      if (payment?.paymentDate && m.dueDate) {
        const delayMs = payment.paymentDate.getTime() - m.dueDate.getTime();
        delays.push(Math.round(delayMs / (1000 * 60 * 60 * 24)));
      }
    }
    const avgPaymentDelay = delays.length > 0
      ? Math.round(delays.reduce((sum, d) => sum + d, 0) / delays.length)
      : 0;

    return res.json({
      villa,
      history,
      statistics: {
        totalPayments: payments.length,
        totalPaid,
        avgPaymentDelay,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance-management/bulk-mark-paid
// Mark multiple villas as paid
const bulkMarkPaidSchema = z.object({
  payments: z.array(
    z.object({
      villaId: z.string().cuid(),
      year: z.number().int(),
      month: z.number().int(),
      amount: z.number().positive(),
      paymentDate: z.string().datetime(),
      paymentMode: z.enum(["CASH", "UPI", "CHEQUE", "BANK_TRANSFER"]),
      transactionId: z.string().optional(),
      bankAccountId: z.string().cuid().optional(),
    })
  ),
});

router.post("/bulk-mark-paid", validateBody(bulkMarkPaidSchema), async (req, res, next) => {
  try {
    const { societyId, userId: adminId } = req.auth!;
    const { payments: paymentsData } = req.body as z.infer<typeof bulkMarkPaidSchema>;

    // Wrap all payment operations in a single transaction so either all
    // succeed or none are committed, preventing inconsistent partial states.
    const results = await prisma.$transaction(async (tx) => {
      const txResults = [];

      // Pre-load all MaintenanceCollectionCycles for this society so we can
      // link MP records to the correct cycle.
      const allMCCs = await tx.maintenanceCollectionCycle.findMany({
        where: { societyId },
        select: { id: true, financialYearId: true, periodMonth: true, periodYear: true, periodKey: true, dueDate: true },
      });
      const mccByPeriod = new Map<string, (typeof allMCCs)[number]>();
      for (const mcc of allMCCs) {
        mccByPeriod.set(`${mcc.periodYear}-${mcc.periodMonth}`, mcc);
      }

      // Track (villaId, financialYearId) pairs that need credit walker reconciliation.
      const walkerTargets = new Map<string, { villaId: string; financialYearId: string; throughCycleId: string }>();

      for (const paymentData of paymentsData) {
        // Find or create maintenance
        let maintenance = await tx.maintenance.findFirst({
          where: {
            societyId,
            villaId: paymentData.villaId,
            year: paymentData.year,
            month: paymentData.month,
          },
        });

        if (!maintenance) {
          const dueDate = new Date(paymentData.year, paymentData.month - 1, 5);
          maintenance = await tx.maintenance.create({
            data: {
              societyId,
              villaId: paymentData.villaId,
              year: paymentData.year,
              month: paymentData.month,
              amount: paymentData.amount,
              dueDate,
              status: "PAID",
            },
          });
        } else {
          maintenance = await tx.maintenance.update({
            where: { id: maintenance.id },
            data: { status: "PAID" },
          });
        }

        // Resolve the matching MaintenanceCollectionCycle for cycle-linked MP.
        const mcc = mccByPeriod.get(`${paymentData.year}-${paymentData.month}`);

        const existingPayment = await tx.maintenancePayment.findFirst({
          where: {
            societyId,
            villaId: paymentData.villaId,
            year: paymentData.year,
            month: paymentData.month,
          },
          orderBy: { paymentDate: "desc" },
          select: { id: true, receiptNumber: true },
        });

        const receiptNumber = existingPayment?.receiptNumber ?? `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

        // Find snapshot to link MP to it.
        const snapshot = mcc
          ? await tx.villaMaintenanceSnapshot.findUnique({
              where: { cycleId_villaId: { cycleId: mcc.id, villaId: paymentData.villaId } },
              select: { id: true },
            })
          : null;

        const payment = existingPayment
          ? await tx.maintenancePayment.update({
              where: { id: existingPayment.id },
              data: {
                maintenanceId: maintenance.id,
                amount: paymentData.amount,
                paymentDate: new Date(paymentData.paymentDate),
                paymentMode: paymentData.paymentMode,
                transactionId: paymentData.transactionId,
                bankAccountId: paymentData.bankAccountId,
                maintenanceCollectionCycleId: mcc?.id ?? undefined,
                villaMaintenanceSnapshotId: snapshot?.id ?? undefined,
              },
            })
          : await tx.maintenancePayment.create({
              data: {
                societyId,
                villaId: paymentData.villaId,
                maintenanceId: maintenance.id,
                amount: paymentData.amount,
                month: paymentData.month,
                year: paymentData.year,
                paymentDate: new Date(paymentData.paymentDate),
                paymentMode: paymentData.paymentMode,
                transactionId: paymentData.transactionId,
                receiptNumber,
                bankAccountId: paymentData.bankAccountId,
                maintenanceCollectionCycleId: mcc?.id ?? null,
                villaMaintenanceSnapshotId: snapshot?.id ?? null,
              },
            });

        // Queue credit walker for this villa's financial year.
        if (mcc) {
          const key = `${paymentData.villaId}:${mcc.financialYearId}`;
          walkerTargets.set(key, {
            villaId: paymentData.villaId,
            financialYearId: mcc.financialYearId,
            throughCycleId: mcc.id,
          });
        }

        txResults.push({ success: true as const, villaId: paymentData.villaId, payment });
      }

      // Run credit walker for each affected (villa, FY) — reconciles snapshots
      // and Maintenance status from the MP ledger.
      for (const target of walkerTargets.values()) {
        await applyVillaCreditAcrossSnapshots(tx, {
          societyId,
          villaId: target.villaId,
          financialYearId: target.financialYearId,
          throughCycleId: target.throughCycleId,
        });
      }

      // Sync UserCyclePayment for each affected villa so resident billing
      // screens reflect the new payment state.
      const processedVillaCycles = new Set<string>();
      for (const paymentData of paymentsData) {
        const mcc = mccByPeriod.get(`${paymentData.year}-${paymentData.month}`);
        if (!mcc) continue;
        const vKey = `${paymentData.villaId}:${mcc.id}`;
        if (processedVillaCycles.has(vKey)) continue;
        processedVillaCycles.add(vKey);

        const billingCycle = await tx.billingCycle.findFirst({
          where: { societyId, financialYearId: mcc.financialYearId, cycleKey: mcc.periodKey },
          select: { id: true },
        });
        if (!billingCycle) continue;

        const reconciledSnap = await tx.villaMaintenanceSnapshot.findUnique({
          where: { cycleId_villaId: { cycleId: mcc.id, villaId: paymentData.villaId } },
          select: { paidAmount: true, status: true },
        });
        const snapStatus = reconciledSnap?.status ?? "PENDING";
        const paidAmount = Number(reconciledSnap?.paidAmount ?? 0);

        await clearExcludedResidentsUserCyclePayments(tx, {
          societyId,
          villaId: paymentData.villaId,
          billingCycleId: billingCycle.id,
        });

        const primaryResidents = await tx.user.findMany({
          where: {
            societyId,
            villaId: paymentData.villaId,
            ...residentLikeRoleFilter,
            isActive: true,
            maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
          },
          select: { id: true },
        });
        const payStatus =
          snapStatus === "PAID" || snapStatus === "WAIVED"
            ? BillingUserPaymentStatus.SUCCESS
            : BillingUserPaymentStatus.PENDING;
        for (const u of primaryResidents) {
          await tx.userCyclePayment.upsert({
            where: { userId_cycleId: { userId: u.id, cycleId: billingCycle.id } },
            create: {
              userId: u.id,
              cycleId: billingCycle.id,
              amountPaid: new Prisma.Decimal(paidAmount),
              paymentStatus: payStatus,
              source: BillingPaymentSource.CASH_MANUAL,
              manualMarkedByAdminId: adminId,
              paidAt: new Date(paymentData.paymentDate),
            },
            update: {
              amountPaid: new Prisma.Decimal(paidAmount),
              paymentStatus: payStatus,
              source: BillingPaymentSource.CASH_MANUAL,
              manualMarkedByAdminId: adminId,
              paidAt: new Date(paymentData.paymentDate),
            },
          });
        }
      }

      return txResults;
    }, { timeout: 30000 });

    // Bust reconcile cache for all villas touched in the batch.
    const villaIds = new Set(paymentsData.map((p: { villaId: string }) => p.villaId));
    for (const vid of villaIds) invalidateReconcileCache(vid);

    // Notify residents of each affected villa (fire-and-forget).
    void (async () => {
      for (const vid of villaIds) {
        try {
          const residents = await prisma.user.findMany({
            where: { villaId: vid, societyId, ...residentLikeRoleFilter, isActive: true },
            select: { id: true },
          });
          if (residents.length > 0) {
            await notifyUsers(
              residents.map((r) => r.id),
              {
                title: "Maintenance payment recorded",
                body: "Admin recorded a maintenance payment for your villa.",
                data: { type: "MAINTENANCE_PAYMENT_RECORDED", villaId: vid },
              },
              { category: NotificationCategory.MAINTENANCE },
            );
          }
        } catch {
          // Fire-and-forget
        }
      }
    })();

    return res.status(201).json({
      message: `${results.length} of ${results.length} payments marked successfully`,
      results,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance-management/financial-dashboard
// Query: optional `cycleId` or `maintenanceCollectionCycleId` for billing-period (snapshot) view.
router.get("/financial-dashboard", async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    let collectionCycleId = pickMaintenanceCollectionCycleId(req.query);

    // Auto-detect MaintenanceCollectionCycle for the given month/year so the
    // snapshot-based path is used whenever a cycle exists — even when the
    // client doesn't pass an explicit cycleId.  This guarantees the admin
    // month-view uses the same canonical VillaMaintenanceSnapshot data as the
    // cycle-view.
    if (!collectionCycleId) {
      const { month: qMonth, year: qYear } = parseMonthYear(req.query);
      const autoMatched = await prisma.maintenanceCollectionCycle.findFirst({
        where: { societyId, periodMonth: qMonth, periodYear: qYear },
        select: { id: true },
      });
      if (autoMatched) collectionCycleId = autoMatched.id;
    }

    if (collectionCycleId) {
      const core = await buildCycleFinancialDashboardCore(societyId, collectionCycleId);
      if ("error" in core) {
        return res.status(400).json({ message: core.error });
      }
      const month = core.month;
      const year = core.year;

      const [globalPending, expenses, recentAdditionalFunds, money] = await Promise.all([
        // Canonical pending dues from VillaMaintenanceSnapshot (not the old
        // Maintenance table which can be stale).
        prisma.villaMaintenanceSnapshot.findMany({
          where: {
            cycle: { societyId },
            status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
          },
          select: {
            id: true,
            villaId: true,
            expectedAmount: true,
            paidAmount: true,
            status: true,
            villa: { select: { villaNumber: true, ownerName: true } },
            cycle: { select: { periodMonth: true, periodYear: true, dueDate: true } },
          },
          take: 250,
        }),
        prisma.expense.findMany({
          where: { societyId, month, year, status: "APPROVED", deletedAt: null },
          select: {
            amount: true,
            category: { select: { name: true } },
          },
        }),
        prisma.additionalFund.findMany({
          where: { societyId, destination: "MERGE_WITH_MAINTENANCE" },
          orderBy: { receivedDate: "desc" },
          take: 25,
        }),
        // Canonical fund snapshot — reads both ledgers (MaintenancePayment +
        // UserCyclePayment) and reconciles per (villa, cycle) so historical
        // data captured under the capping bug still lands in the balance.
        getCachedMoneySnapshot(prisma, societyId),
      ]);

      const allTimeCollected = money.maintenanceCashAllTime + money.additionalFundsAllTime;
      const allTimeSpent = money.expensesAllTime;
      const currentFundBalance = money.currentFundBalance;
      const monthCashCollected = money.maintenanceCashForMonth(month, year);
      const mergedAllTimeInflow = money.additionalFundsAllTime;
      const mergedMonthInflow = money.additionalFundsForMonth(month, year);

      const categoryTotals = new Map<string, number>();
      for (const expense of expenses) {
        const key = expense.category?.name ?? "Other";
        categoryTotals.set(key, (categoryTotals.get(key) ?? 0) + Number(expense.amount));
      }

      const expenseTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
      // Cycle-progress collected via the canonical snapshot (capped per
      // villa) — falls back to the snapshot-rollup that financial-dashboard-
      // cycle already computes if the snapshot service has no data yet.
      const cycleProgressCollected = Math.max(
        money.cycleProgressCollectedForCycle(collectionCycleId),
        core.summary.collected,
      );
      const cycleCashCollected = money.maintenanceCashForCycle(collectionCycleId);

      return res.json({
        filter: {
          month,
          year,
          maintenanceCollectionCycleId: collectionCycleId,
          cycleTitle: core.cycle.title,
        },
        summary: {
          totalVillas: core.summary.totalVillas,
          paidCount: core.summary.paidCount,
          unpaidCount: core.summary.unpaidCount,
          overdueCount: core.summary.overdueCount,
          partialCount: core.summary.partialCount,
          totalExpected: core.summary.totalExpected,
          collected: cycleProgressCollected,
          /** Total cash actually received against this cycle (uncapped). */
          cycleCashCollected,
          pendingAmount: Math.max(0, core.summary.totalExpected - cycleProgressCollected),
          collectionRate:
            core.summary.totalExpected > 0
              ? Math.round((cycleProgressCollected / core.summary.totalExpected) * 100)
              : 0,
        },
        paymentHistory: core.paymentHistory,
        residents: core.residents,
        monthlyExpenseBreakdown: {
          month,
          year,
          categories: Array.from(categoryTotals.entries()).map(([category, total]) => ({
            category,
            total,
          })),
          total: expenseTotal,
        },
        fund: {
          currentFundBalance,
          allTimeCollected,
          allTimeSpent,
          // Cycle-attributed (capped at expected per villa) — drives the
          // collection rate / progress bars on this cycle's UI.
          maintenanceCollected: cycleProgressCollected,
          // Calendar-month cash received (uncapped) — drives the fund-flow
          // numbers; reflects what actually hit the bank account.
          monthCashCollected,
          additionalMergedInflowAllTime: mergedAllTimeInflow,
          additionalMergedInflowMonth: mergedMonthInflow,
          monthNet: monthCashCollected + mergedMonthInflow - expenseTotal,
          /** Surplus held by residents as advance credit (not yet consumed). */
          totalAdvanceCredit: money.totalAdvanceCredit,
        },
        additionalFunds: recentAdditionalFunds.map((f) => ({
          id: f.id,
          title: f.title,
          amount: Number(f.amount),
          destination: f.destination,
          source: f.source,
          notes: f.notes,
          receivedDate: f.receivedDate,
        })),
        globalPendingDues: globalPending.map((s) => ({
          id: s.id,
          villaId: s.villaId,
          villaNumber: s.villa?.villaNumber ?? null,
          ownerName: s.villa?.ownerName ?? null,
          month: s.cycle.periodMonth,
          year: s.cycle.periodYear,
          amount: Math.max(0, Number(s.expectedAmount) - Number(s.paidAmount)),
          dueDate: s.cycle.dueDate,
          status: s.status,
        })),
      });
    }

    const { month, year } = parseMonthYear(req.query);
    const billingCycleIdParam = typeof req.query.billingCycleId === "string" ? req.query.billingCycleId.trim() : "";

    // When no MaintenanceCollectionCycle exists but a BillingCycle is selected,
    // use BillingCycle.amount as the per-villa expected amount.
    let billingCycleAmount: number | null = null;
    if (billingCycleIdParam) {
      const bc = await prisma.billingCycle.findFirst({
        where: { id: billingCycleIdParam, societyId },
        select: { amount: true },
      });
      if (bc) billingCycleAmount = Number(bc.amount);
    }

    const [
      villas,
      monthMaintenance,
      monthPayments,
      globalPending,
      expenses,
      recentAdditionalFunds,
      money,
    ] = await Promise.all([
      prisma.villa.findMany({
        where: { societyId },
        select: {
          id: true,
          villaNumber: true,
          ownerName: true,
          monthlyMaintenance: true,
        },
        orderBy: { villaNumber: "asc" },
      }),
      prisma.maintenance.findMany({
        where: { societyId, month, year },
        include: { villa: { select: { villaNumber: true, ownerName: true } } },
      }),
      prisma.maintenancePayment.findMany({
        where: { societyId, month, year },
        include: { villa: { select: { villaNumber: true, ownerName: true } } },
        orderBy: { paymentDate: "desc" },
      }),
      // Canonical pending dues from VillaMaintenanceSnapshot.
      prisma.villaMaintenanceSnapshot.findMany({
        where: {
          cycle: { societyId },
          status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
        },
        select: {
          id: true,
          villaId: true,
          expectedAmount: true,
          paidAmount: true,
          status: true,
          villa: { select: { villaNumber: true, ownerName: true } },
          cycle: { select: { periodMonth: true, periodYear: true, dueDate: true } },
        },
        take: 250,
      }),
      prisma.expense.findMany({
        where: { societyId, month, year, status: "APPROVED", deletedAt: null },
        select: {
          amount: true,
          category: { select: { name: true } },
        },
      }),
      prisma.additionalFund.findMany({
        where: { societyId, destination: "MERGE_WITH_MAINTENANCE" },
        orderBy: { receivedDate: "desc" },
        take: 25,
      }),
      getCachedMoneySnapshot(prisma, societyId),
    ]);

    const maintenanceMap = new Map(monthMaintenance.map((m) => [m.villaId, m]));
    const paymentMap = new Map(monthPayments.map((p) => [p.villaId, p]));

    const residents = villas.map((villa) => {
      const m = maintenanceMap.get(villa.id);
      const p = paymentMap.get(villa.id);
      const status = m?.status ?? "UNPAID";
      const villaExpected = billingCycleAmount ?? Number(villa.monthlyMaintenance);
      return {
        villaId: villa.id,
        villaNumber: villa.villaNumber,
        ownerName: villa.ownerName,
        amount: villaExpected,
        status,
        dueDate: m?.dueDate ?? null,
        paidAt: p?.paymentDate ?? null,
        receiptNumber: p?.receiptNumber ?? null,
        paymentMode: p?.paymentMode ?? null,
      };
    });

    const totalExpected = billingCycleAmount != null
      ? villas.length * billingCycleAmount
      : villas.reduce((sum, v) => sum + Number(v.monthlyMaintenance), 0);
    const perVillaExpected = billingCycleAmount ?? null;
    const paidByVilla = new Map<string, number>();
    for (const p of monthPayments) {
      paidByVilla.set(p.villaId, (paidByVilla.get(p.villaId) ?? 0) + Number(p.amount));
    }
    const collected = villas.reduce((sum, v) => {
      const paid = paidByVilla.get(v.id) ?? 0;
      const cap = perVillaExpected ?? Number(v.monthlyMaintenance);
      return sum + Math.min(paid, cap);
    }, 0);
    const monthCashCollected = money.maintenanceCashForMonth(month, year);
    const pendingAmount = Math.max(0, totalExpected - collected);
    const paidCount = residents.filter((r) => r.status === "PAID").length;
    const overdueCount = residents.filter((r) => r.status === "OVERDUE").length;
    const unpaidCount = residents.length - paidCount;

    const allTimeCollected = money.maintenanceCashAllTime + money.additionalFundsAllTime;
    const allTimeSpent = money.expensesAllTime;
    const currentFundBalance = money.currentFundBalance;
    const mergedAllTimeInflow = money.additionalFundsAllTime;
    const mergedMonthInflow = money.additionalFundsForMonth(month, year);

    const categoryTotals = new Map<string, number>();
    for (const expense of expenses) {
      const key = expense.category?.name ?? "Other";
      categoryTotals.set(key, (categoryTotals.get(key) ?? 0) + Number(expense.amount));
    }

    return res.json({
      filter: { month, year },
      summary: {
        totalVillas: residents.length,
        paidCount,
        unpaidCount,
        overdueCount,
        totalExpected,
        collected,
        pendingAmount,
        collectionRate: totalExpected > 0 ? Math.round((collected / totalExpected) * 100) : 0,
      },
      paymentHistory: monthPayments.map((p) => ({
        id: p.id,
        villaNumber: p.villa?.villaNumber ?? null,
        ownerName: p.villa?.ownerName ?? null,
        month: p.month,
        year: p.year,
        amount: Number(p.amount),
        paymentDate: p.paymentDate,
        paymentMode: p.paymentMode,
        receiptNumber: p.receiptNumber,
      })),
      residents,
      monthlyExpenseBreakdown: {
        month,
        year,
        categories: Array.from(categoryTotals.entries()).map(([category, total]) => ({
          category,
          total,
        })),
        total: expenses.reduce((sum, e) => sum + Number(e.amount), 0),
      },
      fund: {
        currentFundBalance,
        allTimeCollected,
        allTimeSpent,
        // Cycle-progress (capped per villa) — drives collection rate UI.
        maintenanceCollected: collected,
        // Calendar-month cash received (uncapped) — drives fund flow so
        // overpayments / advance credits show up in the balance.
        monthCashCollected,
        additionalMergedInflowAllTime: mergedAllTimeInflow,
        additionalMergedInflowMonth: mergedMonthInflow,
        monthNet:
          monthCashCollected +
          mergedMonthInflow -
          expenses.reduce((sum, e) => sum + Number(e.amount), 0),
        /** Surplus held by residents as advance credit (not yet consumed). */
        totalAdvanceCredit: money.totalAdvanceCredit,
      },
      additionalFunds: recentAdditionalFunds.map((f) => ({
        id: f.id,
        title: f.title,
        amount: Number(f.amount),
        destination: f.destination,
        source: f.source,
        notes: f.notes,
        receivedDate: f.receivedDate,
      })),
      globalPendingDues: globalPending.map((s) => ({
        id: s.id,
        villaId: s.villaId,
        villaNumber: s.villa?.villaNumber ?? null,
        ownerName: s.villa?.ownerName ?? null,
        month: s.cycle.periodMonth,
        year: s.cycle.periodYear,
        amount: Math.max(0, Number(s.expectedAmount) - Number(s.paidAmount)),
        dueDate: s.cycle.dueDate,
        status: s.status,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/additional-funds", validateBody(additionalFundSchema), async (req, res, next) => {
  try {
    const { societyId, userId } = req.auth!;
    const body = req.body as z.infer<typeof additionalFundSchema>;
    const receivedDate = new Date(body.receivedDate);
    const month = receivedDate.getMonth() + 1;
    const year = receivedDate.getFullYear();

    const row = await prisma.additionalFund.create({
      data: {
        societyId,
        title: body.title,
        amount: body.amount,
        receivedDate,
        month,
        year,
        destination: body.destination,
        source: body.source,
        notes: body.notes,
        createdBy: userId,
      },
    });
    return res.status(201).json({ fund: row });
  } catch (error) {
    next(error);
  }
});

router.get("/additional-funds", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const rows = await prisma.additionalFund.findMany({
      where: { societyId },
      orderBy: { receivedDate: "desc" },
      take: 100,
    });
    return res.json({
      funds: rows.map((f) => ({
        id: f.id,
        title: f.title,
        amount: Number(f.amount),
        destination: f.destination,
        source: f.source,
        notes: f.notes,
        receivedDate: f.receivedDate,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance-management/send-dues-reminders
router.post("/send-dues-reminders", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { month, year } = parseMonthYear(req.body ?? {});

    // Check for a MaintenanceCollectionCycle first — canonical source.
    const reminderCycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { societyId, periodMonth: month, periodYear: year },
      select: { id: true },
    });

    let pendingVillas: Array<{ villaId: string; amount: number; villaNumber: string }> = [];
    if (reminderCycle) {
      // Use VillaMaintenanceSnapshot (canonical).
      const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
        where: {
          cycleId: reminderCycle.id,
          status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
        },
        select: {
          villaId: true,
          expectedAmount: true,
          paidAmount: true,
          villa: { select: { villaNumber: true } },
        },
      });
      pendingVillas = snapshots.map((s) => ({
        villaId: s.villaId,
        amount: Math.max(0, Number(s.expectedAmount) - Number(s.paidAmount)),
        villaNumber: s.villa.villaNumber,
      }));
    } else {
      // Fallback to old Maintenance table for non-cycle months.
      const pending = await prisma.maintenance.findMany({
        where: { societyId, month, year, status: { in: ["PENDING", "OVERDUE"] } },
        include: { villa: { select: { villaNumber: true } } },
      });
      pendingVillas = pending.map((p) => ({
        villaId: p.villaId,
        amount: Number(p.amount),
        villaNumber: p.villa.villaNumber,
      }));
    }

    if (pendingVillas.length === 0) {
      return res.json({ message: "No pending dues for selected period", sent: 0 });
    }

    const villaIds = pendingVillas.map((p) => p.villaId);
    const recipients = await prisma.user.findMany({
      where: {
        societyId,
        role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN] },
        villaId: { in: villaIds },
      },
      select: { id: true, villaId: true },
    });

    const amountByVilla = new Map(
      pendingVillas.map((p) => [p.villaId, p.amount])
    );
    const villaNumberByVilla = new Map(
      pendingVillas.map((p) => [p.villaId, p.villaNumber])
    );

    await prisma.userNotification.createMany({
      data: recipients.map((recipient) => ({
        societyId,
        userId: recipient.id,
        category: "MAINTENANCE",
        title: "Maintenance due reminder",
        body: `Your maintenance due for ${month}/${year} is Rs. ${amountByVilla.get(recipient.villaId ?? "") ?? 0}.`,
        data: {
          month,
          year,
          villaId: recipient.villaId,
          villaNumber: villaNumberByVilla.get(recipient.villaId ?? ""),
        },
      })),
    });

    return res.json({
      message: "Due reminders sent",
      sent: recipients.length,
      month,
      year,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance-management/outstanding-dues
// All villas with any pending maintenance payment across all cycles.
router.get("/outstanding-dues", async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }

    const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
      where: {
        cycle: { societyId },
        status: { notIn: ["PAID", "WAIVED"] },
      },
      include: {
        cycle: {
          select: {
            id: true,
            title: true,
            periodMonth: true,
            periodYear: true,
            dueDate: true,
          },
        },
        villa: {
          select: {
            id: true,
            villaNumber: true,
            ownerName: true,
          },
        },
      },
      orderBy: { cycle: { dueDate: "asc" } },
    });

    // Group by villa
    const villaMap = new Map<
      string,
      {
        villaId: string;
        villaNumber: string;
        ownerName: string;
        totalOutstanding: number;
        pendingCycles: {
          cycleId: string;
          cycleTitle: string;
          month: number;
          year: number;
          expectedAmount: number;
          paidAmount: number;
          remainingDue: number;
          dueDate: string;
          status: string;
          isOverdue: boolean;
        }[];
      }
    >();

    const now = new Date();
    let totalOutstanding = 0;
    let totalPendingCycles = 0;

    for (const snap of snapshots) {
      const expected = Number(snap.expectedAmount);
      const paid = Number(snap.paidAmount);
      const remaining = expected - paid;
      if (remaining <= 0) continue;

      totalOutstanding += remaining;
      totalPendingCycles += 1;

      const vid = snap.villa.id;
      let entry = villaMap.get(vid);
      if (!entry) {
        entry = {
          villaId: vid,
          villaNumber: snap.villa.villaNumber,
          ownerName: snap.villa.ownerName ?? "",
          totalOutstanding: 0,
          pendingCycles: [],
        };
        villaMap.set(vid, entry);
      }
      entry.totalOutstanding += remaining;

      const isOverdue =
        snap.status === "OVERDUE" || new Date(snap.cycle.dueDate) < now;

      entry.pendingCycles.push({
        cycleId: snap.cycle.id,
        cycleTitle: snap.cycle.title,
        month: snap.cycle.periodMonth,
        year: snap.cycle.periodYear,
        expectedAmount: expected,
        paidAmount: paid,
        remainingDue: remaining,
        dueDate: snap.cycle.dueDate.toISOString(),
        status: isOverdue ? "OVERDUE" : snap.status,
        isOverdue,
      });
    }

    // Sort villas by highest total outstanding desc
    const villas = Array.from(villaMap.values()).sort(
      (a, b) => b.totalOutstanding - a.totalOutstanding
    );

    return res.json({
      villas,
      totalOutstanding,
      villasWithDuesCount: villas.length,
      totalPendingCycles,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance-management/send-villa-reminder
// Send a push notification reminder to all residents of a specific villa about their outstanding dues.
const sendVillaReminderSchema = z.object({
  villaId: z.string().min(1),
});
router.post(
  "/send-villa-reminder",
  validateBody(sendVillaReminderSchema),
  async (req, res, next) => {
    try {
      const societyId = tenantSocietyId(req);
      if (!societyId) {
        return res.status(403).json({ message: "Tenant context required" });
      }

      const { villaId } = req.body as z.infer<typeof sendVillaReminderSchema>;

      // Verify villa belongs to this society
      const villa = await prisma.villa.findFirst({
        where: { id: villaId, societyId },
        select: { id: true, villaNumber: true, ownerName: true },
      });
      if (!villa) {
        return res.status(404).json({ message: "Villa not found" });
      }

      // Compute outstanding for this villa
      const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
        where: {
          villaId,
          cycle: { societyId },
          status: { notIn: ["PAID", "WAIVED"] },
        },
        include: {
          cycle: { select: { title: true, dueDate: true } },
        },
      });

      const totalOutstanding = snapshots.reduce((sum, s) => {
        const remaining = Number(s.expectedAmount) - Number(s.paidAmount);
        return sum + (remaining > 0 ? remaining : 0);
      }, 0);

      const pendingMonths = snapshots.length;
      if (pendingMonths === 0) {
        return res.json({ message: "No outstanding dues for this villa", sent: 0 });
      }

      // Find all resident users for this villa
      const recipients = await prisma.user.findMany({
        where: {
          societyId,
          role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN] },
          villaId,
        },
        select: { id: true },
      });

      if (recipients.length === 0) {
        return res.json({ message: "No residents found for this villa", sent: 0 });
      }

      const userIds = recipients.map((r) => r.id);
      await notifyUsers(
        userIds,
        {
          title: "Maintenance due reminder",
          body: `You have ${pendingMonths} pending maintenance ${pendingMonths === 1 ? "payment" : "payments"} totalling Rs. ${Math.round(totalOutstanding)}. Please clear your dues at the earliest.`,
          data: {
            type: "MAINTENANCE_REMINDER",
            villaId,
            villaNumber: villa.villaNumber,
          },
        },
        { category: NotificationCategory.MAINTENANCE },
      );

      return res.json({
        message: "Reminder sent",
        sent: recipients.length,
        villaNumber: villa.villaNumber,
        totalOutstanding,
        pendingMonths,
      });
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/maintenance-management/financial-dashboard/report-pdf
// Query: optional `cycleId` or `maintenanceCollectionCycleId`.
router.get("/financial-dashboard/report-pdf", async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const collectionCycleId = pickMaintenanceCollectionCycleId(req.query);

    if (collectionCycleId) {
      const core = await buildCycleFinancialDashboardCore(societyId, collectionCycleId);
      if ("error" in core) {
        return res.status(400).json({ message: core.error });
      }
      const { month, year } = core;
      const expected = core.summary.totalExpected;
      const collected = core.summary.collected;
      const pending = core.summary.pendingAmount;
      const rate = core.summary.collectionRate;

      const pendingRows = core.residents
        .filter((r) => !r.isExcluded)
        .map((r) => {
          const paid = r.paidTowardCycle ?? (r.status === "PAID" ? r.amount : 0);
          const remaining = Math.max(0, Math.round((r.amount - paid) * 100) / 100);
          return {
            villaNumber: r.villaNumber,
            ownerName: r.ownerName,
            amount: remaining,
            month,
            year,
          };
        })
        .filter((row) => row.amount > 0.001);

      const pdfBuffer = await buildMaintenancePdfBuffer({
        title: `Maintenance Report — ${core.cycle.title}`,
        month,
        year,
        summaryRows: [
          { label: "Billing period", value: core.cycle.title },
          { label: "Total Villas", value: `${core.summary.totalVillas}` },
          { label: "Total Expected", value: `Rs. ${expected.toFixed(0)}` },
          { label: "Collected", value: `Rs. ${collected.toFixed(0)}` },
          { label: "Pending", value: `Rs. ${pending.toFixed(0)}` },
          { label: "Collection Rate", value: `${rate}%` },
        ],
        pendingRows,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="maintenance_cycle_${year}_${String(month).padStart(2, "0")}_${collectionCycleId.slice(0, 8)}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    const { month, year } = parseMonthYear(req.query);

    // Try snapshot-based data first (canonical).
    const pdfCycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { societyId, periodMonth: month, periodYear: year },
      select: { id: true },
    });

    let expected: number;
    let collected: number;
    let villaCount: number;
    let pendingRows: Array<{ villaNumber: string; ownerName: string; amount: number; month: number; year: number }>;

    if (pdfCycle) {
      const [snapshots, allPending] = await Promise.all([
        prisma.villaMaintenanceSnapshot.findMany({
          where: { cycleId: pdfCycle.id },
          select: { expectedAmount: true, paidAmount: true, status: true },
        }),
        prisma.villaMaintenanceSnapshot.findMany({
          where: {
            cycle: { societyId },
            status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
          },
          select: {
            expectedAmount: true,
            paidAmount: true,
            villa: { select: { villaNumber: true, ownerName: true } },
            cycle: { select: { periodMonth: true, periodYear: true } },
          },
        }),
      ]);
      villaCount = snapshots.length;
      expected = snapshots.reduce((sum, s) => sum + Number(s.expectedAmount), 0);
      collected = snapshots.reduce((sum, s) => sum + Number(s.paidAmount), 0);
      pendingRows = allPending.map((s) => ({
        villaNumber: s.villa?.villaNumber ?? "-",
        ownerName: s.villa?.ownerName ?? "-",
        amount: Math.max(0, Number(s.expectedAmount) - Number(s.paidAmount)),
        month: s.cycle.periodMonth,
        year: s.cycle.periodYear,
      }));
    } else {
      // Fallback to old tables for non-cycle months.
      const [villas, monthPayments, globalPending] = await Promise.all([
        prisma.villa.findMany({
          where: { societyId },
          select: { id: true, monthlyMaintenance: true },
        }),
        prisma.maintenancePayment.findMany({
          where: { societyId, month, year },
        }),
        prisma.maintenance.findMany({
          where: { societyId, status: { in: ["PENDING", "OVERDUE"] } },
          include: { villa: { select: { villaNumber: true, ownerName: true } } },
          orderBy: { dueDate: "asc" },
        }),
      ]);
      villaCount = villas.length;
      expected = villas.reduce((sum, v) => sum + Number(v.monthlyMaintenance), 0);
      collected = monthPayments.reduce((sum, p) => sum + Number(p.amount), 0);
      pendingRows = globalPending.map((g) => ({
        villaNumber: g.villa?.villaNumber ?? "-",
        ownerName: g.villa?.ownerName ?? "-",
        amount: Number(g.amount),
        month: g.month,
        year: g.year,
      }));
    }

    const pending = Math.max(0, expected - collected);
    const rate = expected > 0 ? Math.round((collected / expected) * 100) : 0;

    const pdfBuffer = await buildMaintenancePdfBuffer({
      title: "Maintenance Financial Dashboard Report",
      month,
      year,
      summaryRows: [
        { label: "Total Villas", value: `${villaCount}` },
        { label: "Total Expected", value: `Rs. ${expected.toFixed(0)}` },
        { label: "Collected", value: `Rs. ${collected.toFixed(0)}` },
        { label: "Pending", value: `Rs. ${pending.toFixed(0)}` },
        { label: "Collection Rate", value: `${rate}%` },
      ],
      pendingRows,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="maintenance_dashboard_${year}_${String(month).padStart(2, "0")}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

// =====================================================
// FINANCIAL STATEMENTS — Balance Sheet, Trial Balance,
// Budget vs Actual, and PDF downloads for all reports
// =====================================================

/**
 * GET /api/maintenance-management/balance-sheet/:year
 *
 * Generates a balance sheet as of end-of-year (or current date for running year).
 * Assets = Fund Balance + Outstanding Dues
 * Liabilities = Advance Credit Pool (resident overpayments)
 * Fund = accumulated surplus carried forward
 */
router.get("/balance-sheet/:year", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const societyId = req.auth!.societyId!;

    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }

    const snap = await getCachedMoneySnapshot(prisma, societyId);

    // Income & expenses for THIS year only (for current-year surplus)
    const expenseSummaries = await prisma.monthlyExpenseSummary.findMany({
      where: { societyId, year },
      select: { month: true, totalExpenses: true },
    });
    let yearExpenses = 0;
    for (const s of expenseSummaries) {
      yearExpenses += Number(s.totalExpenses);
    }

    let yearIncome = 0;
    for (let m = 1; m <= 12; m++) {
      yearIncome += snap.maintenanceCashForMonth(m, year);
      yearIncome += snap.additionalFundsForMonth(m, year);
    }
    const yearSurplus = yearIncome - yearExpenses;

    // Assets
    const fundBalance = Math.round(snap.currentFundBalance * 100) / 100;
    const outstandingDues = Math.round(snap.outstandingDues * 100) / 100;
    const totalAssets = Math.round((fundBalance + outstandingDues) * 100) / 100;

    // Liabilities
    const advanceCredit = Math.round(snap.totalAdvanceCredit * 100) / 100;

    // Equity = Assets - Liabilities (fund surplus carried forward)
    const accumulatedSurplus = Math.round((totalAssets - advanceCredit) * 100) / 100;

    return res.json({
      year,
      asOf: year === new Date().getFullYear()
        ? new Date().toISOString()
        : `${year}-12-31T23:59:59.000Z`,
      assets: {
        fundBalance,
        outstandingDues,
        totalAssets,
      },
      liabilities: {
        advanceCredit,
        totalLiabilities: advanceCredit,
      },
      equity: {
        accumulatedSurplus,
        currentYearSurplus: Math.round(yearSurplus * 100) / 100,
      },
      totalLiabilitiesAndEquity: Math.round((advanceCredit + accumulatedSurplus) * 100) / 100,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/maintenance-management/trial-balance/:year
 *
 * Lists all income and expense accounts with total debits/credits
 * for the year, enabling auditors to verify the books balance.
 */
router.get("/trial-balance/:year", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const societyId = req.auth!.societyId!;

    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }

    const snap = await getCachedMoneySnapshot(prisma, societyId);

    // Income accounts (credit side)
    let maintenanceIncome = 0;
    let additionalFunds = 0;
    for (let m = 1; m <= 12; m++) {
      maintenanceIncome += snap.maintenanceCashForMonth(m, year);
      additionalFunds += snap.additionalFundsForMonth(m, year);
    }

    // Late fee income from billing cycles
    const lateFees = await prisma.villaMaintenanceSnapshot.aggregate({
      where: {
        cycle: {
          societyId,
          periodYear: year,
        },
        lateFeeAmount: { gt: 0 },
      },
      _sum: { lateFeeAmount: true },
    });
    const lateFeeIncome = Number(lateFees._sum.lateFeeAmount ?? 0);

    // Expense accounts (debit side) — group by category
    const expensesByCategory = await prisma.expense.groupBy({
      by: ["categoryId"],
      where: {
        societyId,
        year,
        status: "APPROVED",
        deletedAt: null,
      },
      _sum: { amount: true },
    });

    // Fetch category names
    const categoryIds = expensesByCategory.map((e) => e.categoryId);
    const categories = categoryIds.length > 0
      ? await prisma.expenseCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true, type: true },
        })
      : [];
    const catMap = new Map(categories.map((c) => [c.id, c]));

    const incomeAccounts = [
      { account: "Maintenance Collections", type: "INCOME" as const, debit: 0, credit: Math.round(maintenanceIncome * 100) / 100 },
      { account: "Additional Funds", type: "INCOME" as const, debit: 0, credit: Math.round(additionalFunds * 100) / 100 },
    ];
    if (lateFeeIncome > 0) {
      incomeAccounts.push({
        account: "Late Fee Income",
        type: "INCOME" as const,
        debit: 0,
        credit: Math.round(lateFeeIncome * 100) / 100,
      });
    }

    const expenseAccounts = expensesByCategory
      .map((e) => ({
        account: catMap.get(e.categoryId)?.name ?? "Uncategorized",
        type: "EXPENSE" as const,
        debit: Math.round(Number(e._sum.amount ?? 0) * 100) / 100,
        credit: 0,
      }))
      .sort((a, b) => b.debit - a.debit);

    const accounts = [...incomeAccounts, ...expenseAccounts];
    const totalDebit = Math.round(accounts.reduce((s, a) => s + a.debit, 0) * 100) / 100;
    const totalCredit = Math.round(accounts.reduce((s, a) => s + a.credit, 0) * 100) / 100;
    const difference = Math.round((totalCredit - totalDebit) * 100) / 100;

    return res.json({
      year,
      accounts,
      totalDebit,
      totalCredit,
      difference,
      isBalanced: Math.abs(difference) < 0.01,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/maintenance-management/budget-vs-actual/:year
 *
 * Compares budgeted amounts (from ExpenseBudget) against actual
 * expense spend for each category in the given year.
 */
router.get("/budget-vs-actual/:year", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const societyId = req.auth!.societyId!;

    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }

    // Fetch budgets for this year
    const budgets = await prisma.expenseBudget.findMany({
      where: { societyId, year },
      include: { category: { select: { id: true, name: true, type: true } } },
    });

    // Actual expenses grouped by category for this year
    const actuals = await prisma.expense.groupBy({
      by: ["categoryId"],
      where: {
        societyId,
        year,
        status: "APPROVED",
        deletedAt: null,
      },
      _sum: { amount: true },
    });
    const actualMap = new Map(actuals.map((a) => [a.categoryId, Number(a._sum.amount ?? 0)]));

    // All categories that have either budget or actual
    const allCatIds = new Set([
      ...budgets.map((b) => b.categoryId).filter(Boolean) as string[],
      ...actuals.map((a) => a.categoryId),
    ]);
    const catDetails = allCatIds.size > 0
      ? await prisma.expenseCategory.findMany({
          where: { id: { in: [...allCatIds] }, societyId },
          select: { id: true, name: true, type: true },
        })
      : [];
    const catMap = new Map(catDetails.map((c) => [c.id, c]));

    const rows: Array<{
      categoryId: string | null;
      categoryName: string;
      budgeted: number;
      actual: number;
      variance: number;
      variancePercent: number;
    }> = [];

    let totalBudgeted = 0;
    let totalActual = 0;

    for (const catId of allCatIds) {
      const budgetRows = budgets.filter((b) => b.categoryId === catId);
      const budgeted = budgetRows.reduce((s, b) => s + Number(b.budgetAmount), 0);
      const actual = actualMap.get(catId) ?? 0;
      const variance = budgeted - actual;
      const variancePercent = budgeted > 0 ? Math.round((variance / budgeted) * 10000) / 100 : 0;

      totalBudgeted += budgeted;
      totalActual += actual;

      rows.push({
        categoryId: catId,
        categoryName: catMap.get(catId)?.name ?? "Uncategorized",
        budgeted: Math.round(budgeted * 100) / 100,
        actual: Math.round(actual * 100) / 100,
        variance: Math.round(variance * 100) / 100,
        variancePercent,
      });
    }

    // Also include categories with actuals but no budget
    for (const [catId, amount] of actualMap) {
      if (!allCatIds.has(catId)) {
        totalActual += amount;
        rows.push({
          categoryId: catId,
          categoryName: catMap.get(catId)?.name ?? "Uncategorized",
          budgeted: 0,
          actual: Math.round(amount * 100) / 100,
          variance: Math.round(-amount * 100) / 100,
          variancePercent: -100,
        });
      }
    }

    rows.sort((a, b) => b.actual - a.actual);

    return res.json({
      year,
      rows,
      totals: {
        budgeted: Math.round(totalBudgeted * 100) / 100,
        actual: Math.round(totalActual * 100) / 100,
        variance: Math.round((totalBudgeted - totalActual) * 100) / 100,
        variancePercent: totalBudgeted > 0
          ? Math.round(((totalBudgeted - totalActual) / totalBudgeted) * 10000) / 100
          : 0,
      },
      hasBudgets: budgets.length > 0,
    });
  } catch (error) {
    next(error);
  }
});

// ---- PDF downloads for financial statements ----

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtInr(n: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

interface FinancialPdfOpts {
  title: string;
  subtitle: string;
  year: number;
  societyName: string;
  sections: Array<{
    heading: string;
    rows: Array<{ label: string; value: string; bold?: boolean; indent?: boolean }>;
  }>;
}

function buildFinancialStatementPdf(opts: FinancialPdfOpts): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const w = doc.page.width - 100; // usable width

    // Header bar
    doc.rect(50, 50, w, 50).fill("#1e293b");
    doc.fontSize(16).fillColor("#ffffff").text(opts.societyName || "Society", 65, 64, { width: w - 30, align: "center" });

    // Accent stripe
    doc.rect(50, 100, w, 4).fill("#3b82f6");

    // Title
    doc.fillColor("#1e293b").fontSize(14).text(opts.title, 50, 120, { width: w, align: "center" });
    doc.fontSize(10).fillColor("#64748b").text(opts.subtitle, 50, 140, { width: w, align: "center" });
    doc.fontSize(9).text(`Generated: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, 50, 155, { width: w, align: "center" });

    let y = 180;

    for (const section of opts.sections) {
      // Section heading
      doc.rect(50, y, w, 28).fill("#f1f5f9");
      doc.fontSize(11).fillColor("#1e293b").text(section.heading, 65, y + 8, { width: w - 30 });
      y += 36;

      for (const row of section.rows) {
        if (y > 750) {
          doc.addPage();
          y = 60;
        }

        const labelX = row.indent ? 80 : 65;
        const fontSize = row.bold ? 11 : 10;
        const color = row.bold ? "#1e293b" : "#475569";

        if (row.bold) {
          doc.rect(50, y - 2, w, 22).fill("#f8fafc");
        }

        doc.fontSize(fontSize).fillColor(color);
        if (row.bold) doc.font("Helvetica-Bold"); else doc.font("Helvetica");
        doc.text(row.label, labelX, y + 2, { width: 300 });
        doc.text(row.value, 350, y + 2, { width: w - 310, align: "right" });

        y += row.bold ? 24 : 20;
      }

      y += 12;
    }

    // Footer
    doc.font("Helvetica");
    const footerY = Math.max(y + 20, 760);
    if (footerY > 750) doc.addPage();
    doc.rect(50, footerY, w, 1).fill("#e2e8f0");
    doc.fontSize(8).fillColor("#94a3b8").text(
      "This is a computer-generated financial statement. No signature required.",
      50, footerY + 8,
      { width: w, align: "center" },
    );

    doc.end();
  });
}

/**
 * GET /api/maintenance-management/profit-loss/:year/pdf
 */
router.get("/profit-loss/:year/pdf", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const societyId = req.auth!.societyId!;
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }

    const snap = await getCachedMoneySnapshot(prisma, societyId);
    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: { name: true },
    });

    const expenseSummaries = await prisma.monthlyExpenseSummary.findMany({
      where: { societyId, year },
      select: { month: true, totalExpenses: true, categoryBreakdown: true },
    });
    const expenseByMonth = new Map<number, { total: number; categories: Record<string, number> }>();
    for (const s of expenseSummaries) {
      expenseByMonth.set(s.month, {
        total: Number(s.totalExpenses),
        categories: (s.categoryBreakdown as Record<string, number>) ?? {},
      });
    }

    let totalIncome = 0;
    let totalExpenses = 0;
    const monthRows: Array<{ label: string; value: string }> = [];

    for (let m = 1; m <= 12; m++) {
      const maintenance = snap.maintenanceCashForMonth(m, year);
      const additional = snap.additionalFundsForMonth(m, year);
      const income = maintenance + additional;
      const expenses = expenseByMonth.get(m)?.total ?? snap.expensesForMonth(m, year);
      const net = income - expenses;
      totalIncome += income;
      totalExpenses += expenses;

      if (income > 0 || expenses > 0) {
        monthRows.push({
          label: `${MONTH_SHORT[m - 1]} ${year}`,
          value: `Income ${fmtInr(income)}  |  Expenses ${fmtInr(expenses)}  |  Net ${fmtInr(net)}`,
        });
      }
    }

    // Expense category summary
    const yearCategories: Record<string, number> = {};
    for (const [, v] of expenseByMonth) {
      for (const [cat, amt] of Object.entries(v.categories)) {
        yearCategories[cat] = (yearCategories[cat] ?? 0) + amt;
      }
    }
    const sortedCats = Object.entries(yearCategories).sort(([, a], [, b]) => b - a);

    const sections: FinancialPdfOpts["sections"] = [
      {
        heading: "INCOME",
        rows: [
          { label: "Maintenance Collections", value: fmtInr(totalIncome - Object.values(yearCategories).reduce((a, b) => a, 0) * 0), indent: true },
          ...monthRows.map((r) => ({ label: r.label, value: r.value, indent: true })),
          { label: "Total Income", value: fmtInr(totalIncome), bold: true },
        ],
      },
      {
        heading: "EXPENDITURE",
        rows: [
          ...sortedCats.map(([cat, amt]) => ({ label: cat, value: fmtInr(amt), indent: true })),
          { label: "Total Expenditure", value: fmtInr(totalExpenses), bold: true },
        ],
      },
      {
        heading: "SUMMARY",
        rows: [
          { label: totalIncome >= totalExpenses ? "Net Surplus" : "Net Deficit", value: fmtInr(Math.abs(totalIncome - totalExpenses)), bold: true },
          { label: "Fund Balance (all-time)", value: fmtInr(snap.currentFundBalance), bold: true },
          { label: "Outstanding Dues", value: fmtInr(snap.outstandingDues) },
          { label: "Advance Credit Pool", value: fmtInr(snap.totalAdvanceCredit) },
        ],
      },
    ];

    const pdfBuffer = await buildFinancialStatementPdf({
      title: "Income & Expenditure Statement",
      subtitle: `Financial Year ${year}`,
      year,
      societyName: society?.name ?? "",
      sections,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="income_expenditure_${year}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/maintenance-management/balance-sheet/:year/pdf
 */
router.get("/balance-sheet/:year/pdf", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const societyId = req.auth!.societyId!;
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }

    const snap = await getCachedMoneySnapshot(prisma, societyId);
    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: { name: true },
    });

    const fundBalance = Math.round(snap.currentFundBalance * 100) / 100;
    const outstandingDues = Math.round(snap.outstandingDues * 100) / 100;
    const totalAssets = Math.round((fundBalance + outstandingDues) * 100) / 100;
    const advanceCredit = Math.round(snap.totalAdvanceCredit * 100) / 100;
    const accumulatedSurplus = Math.round((totalAssets - advanceCredit) * 100) / 100;

    const pdfBuffer = await buildFinancialStatementPdf({
      title: "Balance Sheet",
      subtitle: `As of ${year === new Date().getFullYear() ? new Date().toLocaleDateString("en-IN") : `31 Dec ${year}`}`,
      year,
      societyName: society?.name ?? "",
      sections: [
        {
          heading: "ASSETS",
          rows: [
            { label: "Fund Balance (Bank)", value: fmtInr(fundBalance), indent: true },
            { label: "Outstanding Dues (Receivable)", value: fmtInr(outstandingDues), indent: true },
            { label: "Total Assets", value: fmtInr(totalAssets), bold: true },
          ],
        },
        {
          heading: "LIABILITIES",
          rows: [
            { label: "Advance Credit (Resident Overpayments)", value: fmtInr(advanceCredit), indent: true },
            { label: "Total Liabilities", value: fmtInr(advanceCredit), bold: true },
          ],
        },
        {
          heading: "EQUITY / FUND",
          rows: [
            { label: "Accumulated Surplus", value: fmtInr(accumulatedSurplus), bold: true },
          ],
        },
        {
          heading: "VERIFICATION",
          rows: [
            { label: "Total Liabilities + Equity", value: fmtInr(advanceCredit + accumulatedSurplus), bold: true },
            { label: "Difference (should be zero)", value: fmtInr(totalAssets - advanceCredit - accumulatedSurplus) },
          ],
        },
      ],
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="balance_sheet_${year}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/maintenance-management/trial-balance/:year/pdf
 */
router.get("/trial-balance/:year/pdf", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const societyId = req.auth!.societyId!;
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }

    // Re-use the same logic as the JSON endpoint
    const snap = await getCachedMoneySnapshot(prisma, societyId);
    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: { name: true },
    });

    let maintenanceIncome = 0;
    let additionalFunds = 0;
    for (let m = 1; m <= 12; m++) {
      maintenanceIncome += snap.maintenanceCashForMonth(m, year);
      additionalFunds += snap.additionalFundsForMonth(m, year);
    }

    const expensesByCategory = await prisma.expense.groupBy({
      by: ["categoryId"],
      where: { societyId, year, status: "APPROVED", deletedAt: null },
      _sum: { amount: true },
    });
    const categoryIds = expensesByCategory.map((e) => e.categoryId);
    const categories = categoryIds.length > 0
      ? await prisma.expenseCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true },
        })
      : [];
    const catMap = new Map(categories.map((c) => [c.id, c.name]));

    const incomeRows = [
      { label: "Maintenance Collections", value: fmtInr(maintenanceIncome), indent: true },
      { label: "Additional Funds", value: fmtInr(additionalFunds), indent: true },
    ];
    const totalCredit = maintenanceIncome + additionalFunds;

    const expenseRows = expensesByCategory
      .map((e) => ({
        label: catMap.get(e.categoryId) ?? "Uncategorized",
        value: fmtInr(Number(e._sum.amount ?? 0)),
        indent: true,
        amount: Number(e._sum.amount ?? 0),
      }))
      .sort((a, b) => b.amount - a.amount);
    const totalDebit = expenseRows.reduce((s, r) => s + r.amount, 0);

    const pdfBuffer = await buildFinancialStatementPdf({
      title: "Trial Balance",
      subtitle: `For the year ended ${year === new Date().getFullYear() ? new Date().toLocaleDateString("en-IN") : `31 Dec ${year}`}`,
      year,
      societyName: society?.name ?? "",
      sections: [
        {
          heading: "CREDIT (Income Accounts)",
          rows: [
            ...incomeRows,
            { label: "Total Credits", value: fmtInr(totalCredit), bold: true },
          ],
        },
        {
          heading: "DEBIT (Expense Accounts)",
          rows: [
            ...expenseRows.map((r) => ({ label: r.label, value: r.value, indent: r.indent })),
            { label: "Total Debits", value: fmtInr(totalDebit), bold: true },
          ],
        },
        {
          heading: "BALANCE",
          rows: [
            { label: "Net Surplus (Credit − Debit)", value: fmtInr(totalCredit - totalDebit), bold: true },
          ],
        },
      ],
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="trial_balance_${year}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

export default router;
