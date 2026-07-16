import { Router } from "express";
import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { MaintenanceBillingRole, UserRole } from "@prisma/client";
import { computeUserBillingLedger, publishedBillingCycleFilter } from "../billing-cycle/services/cycle-service";
import { isAppVisibleBillingCycle } from "../billing-cycle/domain/cycleStatus";
import { reconcileVillaLedgersForRecentCycles } from "../billing-cycle/services/resident-pending-dues";
import {
  loadPerCycleLateFeeContext,
  resolveSnapshotCycleTotals,
} from "../billing-cycle/services/per-cycle-late-fee-context";
import { buildCycleFinancialDashboardCore } from "../maintenance-management/financial-dashboard-cycle";
import {
  loadAppVisibleBillingCyclePeriodKeys,
  maintenanceCollectionBackedByBillingCycleWhere,
} from "../billing-cycle/billing-collection-scope";

const router = Router();

router.use(requireAuth);

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

function snapshotTotalExpected(expectedAmount: unknown, lateFeeAmount: unknown): number {
  return Number(expectedAmount) + Number(lateFeeAmount ?? 0);
}

function snapshotRemainingDue(
  expectedAmount: unknown,
  lateFeeAmount: unknown,
  paidAmount: unknown,
): number {
  return Math.max(0, snapshotTotalExpected(expectedAmount, lateFeeAmount) - Number(paidAmount));
}

async function resolveMaintenanceCollectionCycleId(
  societyId: string,
  month: number,
  year: number,
): Promise<string | null> {
  const cycle = await prisma.maintenanceCollectionCycle.findFirst({
    where: {
      societyId,
      periodMonth: month,
      periodYear: year,
    },
    orderBy: { dueDate: "desc" },
    select: { id: true },
  });
  return cycle?.id ?? null;
}

type ResidentLedgerRow = {
  id: string;
  cycleId: string;
  cycleKey: string;
  title: string;
  month: number;
  year: number;
  dueDate: Date | null;
  expectedAmount: number;
  cashPaidAmount: number;
  creditApplied: number;
  paidAmount: number;
  remainingDue: number;
  balanceBefore: number;
  carryForwardBalance: number;
  previousDue: number;
  availableCredit: number;
  status: "PAID" | "PARTIAL" | "PENDING" | "OVERDUE" | "AUTO_SETTLED";
  isOverdue: boolean;
  paidAt: string | null;
};

function parseCycleMonthYear(cycleKey: string, dueDate: Date | null): { month: number; year: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(cycleKey);
  if (m) {
    return {
      year: Number(m[1]),
      month: Number(m[2]),
    };
  }
  if (dueDate) {
    return {
      year: dueDate.getUTCFullYear(),
      month: dueDate.getUTCMonth() + 1,
    };
  }
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

async function buildResidentLedgerRows(societyId: string, userId: string): Promise<ResidentLedgerRow[]> {
  const now = new Date();
  const [ledger, cycles] = await Promise.all([
    computeUserBillingLedger(societyId, userId),
    prisma.billingCycle.findMany({
      where: { societyId, ...publishedBillingCycleFilter },
      select: {
        id: true,
        cycleKey: true,
        title: true,
        paymentStartDate: true,
        paymentEndDate: true,
        publishedAt: true,
      },
    }),
  ]);

  const cycleById = new Map(
    cycles
      .filter((c) => isAppVisibleBillingCycle(now, c))
      .map((cycle) => [cycle.id, cycle]),
  );

  return ledger.cycles
    .filter((row) => cycleById.has(row.cycleId))
    .map((row) => {
    const cycle = cycleById.get(row.cycleId);
    const dueDate = cycle?.paymentEndDate ?? null;
    const { month, year } = parseCycleMonthYear(row.cycleKey, dueDate);
    const settledCredit = row.creditApplied;
    const creditAvailable = Math.max(
      0,
      Math.min(row.expectedAmount - row.cashPaidAmount, row.balanceBefore),
    );
    const creditApplied = settledCredit > 0.005 ? settledCredit : creditAvailable;
    const remainingDue = Math.max(0, row.expectedAmount - row.cashPaidAmount - creditApplied);
    const previousDue = Math.max(0, -row.balanceBefore);
    const availableCredit = Math.max(0, row.balanceBefore);
    const isOverdue = Boolean(
      dueDate &&
        remainingDue > 0.005 &&
        new Date(dueDate).getTime() < now.getTime(),
    );

    let status: ResidentLedgerRow["status"] = "PENDING";
    if (remainingDue <= 0.005) {
      status = creditApplied > 0 && row.cashPaidAmount <= 0.005 ? "AUTO_SETTLED" : "PAID";
    } else if (row.paidAmount > 0.005 || row.cashPaidAmount > 0.005) {
      status = "PARTIAL";
    } else if (isOverdue) {
      status = "OVERDUE";
    }

    return {
      id: row.cycleId,
      cycleId: row.cycleId,
      cycleKey: row.cycleKey,
      title: cycle?.title ?? row.title,
      month,
      year,
      dueDate,
      expectedAmount: row.expectedAmount,
      cashPaidAmount: row.cashPaidAmount,
      creditApplied,
      paidAmount: row.paidAmount,
      remainingDue,
      balanceBefore: row.balanceBefore,
      carryForwardBalance: row.balanceAfter,
      previousDue,
      availableCredit,
      status,
      isOverdue,
      paidAt: row.paidAt,
    };
  });
}

function buildResidentPdfBuffer(params: {
  month: number;
  year: number;
  summaryRows: Array<{ label: string; value: string }>;
  pendingRows: Array<{ month: number; year: number; amount: number; dueDate: Date | null }>;
}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text("Resident Maintenance Report", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Period: ${params.month}/${params.year}`);
    doc.text(`Generated: ${new Date().toLocaleString()}`);
    doc.moveDown();
    doc.fontSize(13).text("Summary");
    doc.moveDown(0.4);
    params.summaryRows.forEach((row) => doc.fontSize(11).text(`${row.label}: ${row.value}`));
    doc.moveDown();

    doc.fontSize(13).text("Pending Dues");
    doc.moveDown(0.4);
    doc.fontSize(10).text("Month/Year", 40, doc.y, { continued: true, width: 100 });
    doc.text("Due Date", { continued: true, width: 140 });
    doc.text("Amount", { width: 80, align: "right" });
    doc.moveDown(0.2);

    params.pendingRows.forEach((row) => {
      doc.fontSize(10).text(`${row.month}/${row.year}`, 40, doc.y, { continued: true, width: 100 });
      doc.text(row.dueDate ? new Date(row.dueDate).toLocaleDateString() : "-", { continued: true, width: 140 });
      doc.text(`Rs. ${Number(row.amount).toFixed(0)}`, { width: 80, align: "right" });
    });

    doc.end();
  });
}

// GET /api/residents/my-maintenance - Get my payment history
router.get("/my-maintenance", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, maintenanceBillingRole: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    if (user.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED) {
      return res.json({
        maintenance: [],
        summary: {
          totalPaid: 0,
          totalPending: 0,
          paidCount: 0,
          pendingCount: 0,
        },
        maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED,
        notice:
          "Maintenance for this villa is billed to the primary resident account. Use that login to view or pay dues.",
      });
    }

    const ledgerRows = await buildResidentLedgerRows(societyId, userId);
    const periodFilters = Array.from(
      new Set(ledgerRows.map((row) => `${row.year}-${row.month}`)),
    ).map((key) => {
      const [yearStr, monthStr] = key.split("-");
      return { year: Number(yearStr), month: Number(monthStr) };
    });

    const [monthlySummaries, monthExpenses] = await Promise.all([
      periodFilters.length
        ? prisma.monthlyExpenseSummary.findMany({
            where: {
              societyId,
              OR: periodFilters,
            },
          })
        : Promise.resolve([]),
      periodFilters.length
        ? prisma.expense.findMany({
            where: {
              societyId,
              status: "APPROVED",
              deletedAt: null,
              OR: periodFilters,
            },
            include: {
              category: {
                select: { name: true },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const summaryMap = new Map(
      monthlySummaries.map((s) => [`${s.year}-${s.month}`, s]),
    );
    const expenseMap = new Map<string, { total: number; breakdown: Record<string, number> }>();
    for (const expense of monthExpenses) {
      const key = `${expense.year}-${expense.month}`;
      const current = expenseMap.get(key) ?? { total: 0, breakdown: {} };
      const amount = Number(expense.amount);
      const category = expense.category?.name ?? "Other";
      current.total += amount;
      current.breakdown[category] = (current.breakdown[category] ?? 0) + amount;
      expenseMap.set(key, current);
    }

    const summary = ledgerRows.reduce(
      (acc, row) => {
        acc.totalPaid += row.cashPaidAmount;
        acc.totalPending += row.remainingDue;
        if (row.remainingDue <= 0.005) acc.paidCount++;
        else acc.pendingCount++;
        return acc;
      },
      { totalPaid: 0, totalPending: 0, paidCount: 0, pendingCount: 0 },
    );

    return res.json({
      maintenance: ledgerRows
        .filter((row) => row.cashPaidAmount > 0.005 || row.creditApplied > 0.005 || row.remainingDue > 0.005)
        .sort((a, b) => (b.year - a.year) || (b.month - a.month))
        .map((row) => {
          const key = `${row.year}-${row.month}`;
          const monthlySummary = summaryMap.get(key);
          const fallbackExpense = expenseMap.get(key);
          const summaryBreakdown = (monthlySummary?.categoryBreakdown ?? {}) as Record<string, unknown>;
          const normalizedBreakdown: Record<string, number> = {};
          for (const [category, amount] of Object.entries(summaryBreakdown)) {
            normalizedBreakdown[category] = Number(amount) || 0;
          }

          return {
            id: row.id,
            cycleId: row.cycleId,
            cycleKey: row.cycleKey,
            title: row.title,
            month: row.month,
            year: row.year,
            amount: row.cashPaidAmount,
            expectedAmount: row.expectedAmount,
            paidAmount: row.paidAmount,
            cashPaidAmount: row.cashPaidAmount,
            creditApplied: row.creditApplied,
            remainingDue: row.remainingDue,
            previousDue: row.previousDue,
            carryForwardBalance: row.carryForwardBalance,
            status: row.status,
            dueDate: row.dueDate,
            paidAt: row.paidAt,
            paymentDate: row.paidAt,
            societyExpense:
              Number(monthlySummary?.totalExpenses ?? fallbackExpense?.total ?? 0) || 0,
            expenseBreakdown:
              Object.keys(normalizedBreakdown).length > 0
                ? normalizedBreakdown
                : (fallbackExpense?.breakdown ?? {}),
          };
        }),
      summary,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/maintenance-pending - Get pending dues
router.get("/maintenance-pending", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const { userId, societyId } = req.auth!;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, maintenanceBillingRole: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    if (user.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED) {
      return res.json({
        pending: [],
        totalDue: 0,
        pendingCount: 0,
        overdueCount: 0,
        overdue: [],
        maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED,
        notice:
          "Maintenance for this villa is billed to the primary resident account. Use that login to view or pay dues.",
      });
    }

    try {
      await reconcileVillaLedgersForRecentCycles(societyId, user.villaId);
    } catch (reconcileErr) {
      logger.warn(
        { err: reconcileErr, userId, villaId: user.villaId },
        "Villa ledger reconciliation failed — serving potentially stale dues",
      );
    }

    const pending = (await buildResidentLedgerRows(societyId, userId))
      .filter((row) => row.remainingDue > 0.005)
      .sort((a, b) => (a.year - b.year) || (a.month - b.month));

    const periodKeys = Array.from(new Set(pending.map((m) => `${m.year}-${m.month}`)));
    const periodFilters = periodKeys.map((key) => {
      const [yearStr, monthStr] = key.split("-");
      return { year: Number(yearStr), month: Number(monthStr) };
    });

    const [monthlySummaries, monthExpenses] = await Promise.all([
      periodFilters.length
        ? prisma.monthlyExpenseSummary.findMany({
            where: {
              societyId,
              OR: periodFilters,
            },
          })
        : Promise.resolve([]),
      periodFilters.length
        ? prisma.expense.findMany({
            where: {
              societyId,
              status: "APPROVED",
              deletedAt: null,
              OR: periodFilters,
            },
            include: {
              category: {
                select: { name: true },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const summaryMap = new Map(
      monthlySummaries.map((s) => [`${s.year}-${s.month}`, s])
    );
    const expenseMap = new Map<string, { total: number; breakdown: Record<string, number> }>();
    for (const expense of monthExpenses) {
      const key = `${expense.year}-${expense.month}`;
      const current = expenseMap.get(key) ?? { total: 0, breakdown: {} };
      const amount = Number(expense.amount);
      const category = expense.category?.name ?? "Other";
      current.total += amount;
      current.breakdown[category] = (current.breakdown[category] ?? 0) + amount;
      expenseMap.set(key, current);
    }

    const totalDue = pending.reduce((sum, m) => sum + Number(m.remainingDue), 0);

    // Check if any are overdue
    const now = new Date();
    const overdue = pending.filter((m) => m.dueDate && new Date(m.dueDate) < now);

    return res.json({
      pending: pending.map((m) => {
        const key = `${m.year}-${m.month}`;
        const monthlySummary = summaryMap.get(key);
        const fallbackExpense = expenseMap.get(key);
        const summaryBreakdown = (monthlySummary?.categoryBreakdown ?? {}) as Record<string, unknown>;
        const normalizedBreakdown: Record<string, number> = {};
        for (const [category, amount] of Object.entries(summaryBreakdown)) {
          normalizedBreakdown[category] = Number(amount) || 0;
        }
        return {
          id: m.id,
          cycleId: m.cycleId,
          cycleKey: m.cycleKey,
          title: m.title,
          villaId: user.villaId,
          month: m.month,
          year: m.year,
          amount: m.remainingDue,
          expectedAmount: m.expectedAmount,
          paidAmount: m.paidAmount,
          cashPaidAmount: m.cashPaidAmount,
          creditApplied: m.creditApplied,
          remainingDue: m.remainingDue,
          previousDue: m.previousDue,
          dueDate: m.dueDate,
          status: m.status,
          isOverdue: m.isOverdue,
          societyExpense:
            Number(monthlySummary?.totalExpenses ?? fallbackExpense?.total ?? 0) || 0,
          expenseBreakdown:
            Object.keys(normalizedBreakdown).length > 0
              ? normalizedBreakdown
              : (fallbackExpense?.breakdown ?? {}),
        };
      }),
      totalDue,
      pendingCount: pending.length,
      overdueCount: overdue.length,
      overdue: overdue.map((m) => ({
        id: m.id,
        cycleId: m.cycleId,
        cycleKey: m.cycleKey,
        title: m.title,
        villaId: user.villaId,
        month: m.month,
        year: m.year,
        amount: m.remainingDue,
        expectedAmount: m.expectedAmount,
        paidAmount: m.paidAmount,
        cashPaidAmount: m.cashPaidAmount,
        creditApplied: m.creditApplied,
        remainingDue: m.remainingDue,
        previousDue: m.previousDue,
        dueDate: m.dueDate,
        status: m.status,
        isOverdue: true,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/maintenance-history/:year - Get year history
router.get("/maintenance-history/:year", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { year } = req.params;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, maintenanceBillingRole: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    if (user.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED) {
      return res.json({
        maintenance: [],
        year: parseInt(year),
        maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED,
        notice:
          "Maintenance for this villa is billed to the primary resident account. Use that login to view history.",
      });
    }

    const maintenance = await prisma.maintenance.findMany({
      where: {
        villaId: user.villaId,
        societyId,
        year: parseInt(year),
      },
      include: {
        payments: true,
      },
      orderBy: { month: "asc" },
    });

    return res.json({ maintenance, year: parseInt(year) });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/request-receipt - Request payment receipt
router.post("/request-receipt", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { maintenanceId } = req.body;

    if (!maintenanceId) {
      return res.status(400).json({ message: "Maintenance ID required" });
    }

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, email: true, name: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Verify the maintenance belongs to user's villa
    const maintenance = await prisma.maintenance.findFirst({
      where: {
        id: maintenanceId,
        villaId: user.villaId,
        societyId,
        status: "PAID",
      },
      include: {
        payments: true,
        villa: true,
      },
    });

    if (!maintenance) {
      return res.status(404).json({ message: "Payment record not found" });
    }

    // In a real app, this would send email with receipt
    // For now, just return the data
    return res.json({
      message: "Receipt request sent successfully. You will receive it via email.",
      receipt: {
        maintenanceId: maintenance.id,
        villaNumber: maintenance.villa.villaNumber,
        month: maintenance.month,
        year: maintenance.year,
        amount: maintenance.amount,
        status: maintenance.status,
        payments: maintenance.payments,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/maintenance-summary - Get overall summary
router.get("/maintenance-summary", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Get villa details
    const villa = await prisma.villa.findFirst({
      where: { id: user.villaId, societyId },
      select: { villaNumber: true, monthlyMaintenance: true },
    });

    // Get all maintenance records
    const allMaintenance = await prisma.maintenance.findMany({
      where: { villaId: user.villaId, societyId },
    });

    const totalPaid = allMaintenance
      .filter((m) => m.status === "PAID")
      .reduce((sum, m) => sum + Number(m.amount), 0);

    const totalPending = allMaintenance
      .filter((m) => m.status === "PENDING")
      .reduce((sum, m) => sum + Number(m.amount), 0);

    // Get current month status
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const currentMonthMaintenance = await prisma.maintenance.findFirst({
      where: {
        villaId: user.villaId,
        societyId,
        month: currentMonth,
        year: currentYear,
      },
    });

    return res.json({
      villa,
      summary: {
        monthlyAmount: villa?.monthlyMaintenance || 0,
        totalPaid,
        totalPending,
        paidMonths: allMaintenance.filter((m) => m.status === "PAID").length,
        pendingMonths: allMaintenance.filter((m) => m.status === "PENDING").length,
        currentMonthStatus: currentMonthMaintenance?.status || "NOT_GENERATED",
        currentMonthDue: currentMonthMaintenance?.dueDate || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/maintenance-dashboard - Structured dashboard payload
router.get("/maintenance-dashboard", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const now = new Date();
    const { month, year } = parseMonthYear(req.query);
    const billingCycleId = typeof req.query.billingCycleId === "string" ? req.query.billingCycleId.trim() : "";

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, villa: { select: { villaNumber: true } } },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    try {
      await reconcileVillaLedgersForRecentCycles(societyId, user.villaId);
    } catch (reconcileErr) {
      logger.warn(
        { err: reconcileErr, userId, villaId: user.villaId },
        "Villa ledger reconciliation failed — serving potentially stale dashboard",
      );
    }

    const [ledgerRows, collectionCycleId, currentRecords, payments, globalPending, monthlyExpenseSummary, periodLiveExpenses, villas, monthMaintenanceAll, monthPaymentsAll, yearMaintenanceGrouped, yearPaymentsGrouped, yearExpenseSummaries] =
      await Promise.all([
        buildResidentLedgerRows(societyId, userId),
        resolveMaintenanceCollectionCycleId(societyId, month, year),
        prisma.maintenance.findMany({
          where: { societyId, villaId: user.villaId, month, year },
          orderBy: { createdAt: "desc" },
        }),
        prisma.maintenancePayment.findMany({
          where: { societyId, villaId: user.villaId },
          orderBy: { paymentDate: "desc" },
          take: 36,
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
            lateFeeAmount: true,
            lateFeeAppliedAt: true,
            paidAmount: true,
            status: true,
            villa: { select: { villaNumber: true, ownerName: true } },
            cycle: {
              select: {
                periodMonth: true,
                periodYear: true,
                dueDate: true,
                financialYearId: true,
                periodKey: true,
              },
            },
          },
        }),
        prisma.monthlyExpenseSummary.findUnique({
          where: {
            societyId_month_year: { societyId, month, year },
          },
        }),
        prisma.expense.findMany({
          where: { societyId, month, year, status: "APPROVED", deletedAt: null },
          select: {
            amount: true,
            category: { select: { name: true } },
          },
        }),
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
        }),
        prisma.maintenancePayment.findMany({
          where: { societyId, month, year },
          orderBy: { paymentDate: "desc" },
        }),
        // Yearly chart totals: aggregate in the DB (sum + counts per month)
        // instead of loading every row for the year across all villas and
        // reducing in JS. Output of `yearlyBreakdown` is unchanged.
        prisma.maintenance.groupBy({
          by: ["month", "status"],
          where: { societyId, year },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.maintenancePayment.groupBy({
          by: ["month"],
          where: { societyId, year },
          _sum: { amount: true },
        }),
        prisma.monthlyExpenseSummary.findMany({
          where: { societyId, year },
        }),
      ]);

    const lateFeeCtx = await loadPerCycleLateFeeContext(societyId);
    const nowForLateFee = new Date();

    const cycleCore =
      collectionCycleId == null
          ? null
          : await buildCycleFinancialDashboardCore(societyId, collectionCycleId);

    // When no MaintenanceCollectionCycle snapshots exist but a BillingCycle is
    // selected, use BillingCycle.amount as the per-villa expected amount
    // instead of villa.monthlyMaintenance.
    let billingCycleAmount: number | null = null;
    if (!cycleCore && billingCycleId) {
      const bc = await prisma.billingCycle.findFirst({
        where: { id: billingCycleId, societyId, ...publishedBillingCycleFilter },
        select: { amount: true },
      });
      if (bc) billingCycleAmount = Number(bc.amount);
    }

    const periodLedgerRows = ledgerRows.filter((row) => row.year === year && row.month === month);
    const currentLedgerRow = periodLedgerRows[0] ?? null;
    const totalPaid = ledgerRows.reduce((sum, row) => sum + row.cashPaidAmount, 0);
    const totalPending = ledgerRows.reduce((sum, row) => sum + row.remainingDue, 0);
    const latestPayment = payments[0] ?? null;
    const latestLedgerCashPayment =
      ledgerRows
        .filter((row) => row.cashPaidAmount > 0.005 && row.paidAt != null)
        .sort((a, b) => new Date(b.paidAt ?? 0).getTime() - new Date(a.paidAt ?? 0).getTime())[0] ?? null;
    const currentRecord = currentRecords[0] ?? null;
    const maintenanceByVilla = new Map(monthMaintenanceAll.map((m) => [m.villaId, m]));
    const paymentByVilla = new Map<string, (typeof monthPaymentsAll)[number]>();
    for (const payment of monthPaymentsAll) {
      if (!paymentByVilla.has(payment.villaId)) {
        paymentByVilla.set(payment.villaId, payment);
      }
    }
    const useCycleResidents = cycleCore != null && !("error" in cycleCore);
    const residents = useCycleResidents
      ? cycleCore.residents
          .filter((r) => !r.isExcluded)
          .map((resident) => ({
          residentId: resident.villaId,
          name: resident.ownerName ?? "Unknown",
          flatNumber: resident.villaNumber ?? "-",
          villaNumber: resident.villaNumber ?? "-",
          ownerName: resident.ownerName ?? "Unknown",
          amount: resident.amount,
          paidTowardCycle: resident.paidTowardCycle ?? 0,
          status: resident.status,
          paymentDate: resident.paidAt ?? null,
          paymentMode: resident.paymentMode ?? null,
          transactionId: resident.transactionId ?? null,
          receiptNumber: resident.receiptNumber ?? null,
          notes: null,
          dueDate: resident.dueDate,
        }))
      : villas.map((villa) => {
          const monthly = maintenanceByVilla.get(villa.id);
          const payment = paymentByVilla.get(villa.id);
          const status = monthly?.status ?? "UNPAID";
          const villaExpected = billingCycleAmount ?? Number(villa.monthlyMaintenance);
          return {
            residentId: villa.id,
            name: villa.ownerName ?? "Unknown",
            flatNumber: villa.villaNumber ?? "-",
            villaNumber: villa.villaNumber ?? "-",
            ownerName: villa.ownerName ?? "Unknown",
            amount: villaExpected,
            paidTowardCycle: status === "PAID" ? villaExpected : 0,
            status,
            paymentDate: payment?.paymentDate ?? null,
            paymentMode: payment?.paymentMode ?? null,
            transactionId: payment?.transactionId ?? null,
            receiptNumber: payment?.receiptNumber ?? null,
            notes: payment?.remarks ?? null,
            dueDate: monthly?.dueDate ?? null,
          };
        });
    const totalExpectedCollection = useCycleResidents
      ? cycleCore.summary.totalExpected
      : billingCycleAmount != null
        ? villas.length * billingCycleAmount
        : villas.reduce((sum, villa) => sum + Number(villa.monthlyMaintenance), 0);
    const totalCollectedCollection = useCycleResidents
      ? cycleCore.summary.collected
      : monthPaymentsAll.reduce((sum, payment) => sum + Number(payment.amount), 0);
    const totalPendingCollection = useCycleResidents
      ? cycleCore.summary.pendingAmount
      : Math.max(0, totalExpectedCollection - totalCollectedCollection);
    const billedHomesCount = Math.max(
      0,
      residents.filter((r) => Number(r.amount) > 0).length,
    );
    const paidResidentsCount = useCycleResidents
      ? cycleCore.summary.paidCount
      : residents.filter((r) => r.status === "PAID").length;
    const partialResidentsCount = useCycleResidents ? cycleCore.summary.partialCount : 0;
    const overdueResidentsCount = useCycleResidents ? cycleCore.summary.overdueCount : 0;
    const unpaidResidentsCount = useCycleResidents
      ? Math.max(0, residents.length - paidResidentsCount)
      : residents.length - paidResidentsCount;
    const pendingResidents = residents.filter((r) => (r.status ?? "").toUpperCase() !== "PAID");
    const expectedByMonth = new Map<number, number>();
    const monthTotalCount = new Map<number, number>();
    const monthPaidCount = new Map<number, number>();
    for (const g of yearMaintenanceGrouped) {
      expectedByMonth.set(g.month, (expectedByMonth.get(g.month) ?? 0) + Number(g._sum.amount ?? 0));
      monthTotalCount.set(g.month, (monthTotalCount.get(g.month) ?? 0) + g._count._all);
      if (g.status === "PAID") {
        monthPaidCount.set(g.month, (monthPaidCount.get(g.month) ?? 0) + g._count._all);
      }
    }
    const collectedByMonth = new Map<number, number>();
    for (const g of yearPaymentsGrouped) {
      collectedByMonth.set(g.month, Number(g._sum.amount ?? 0));
    }
    const expenseByMonth = new Map<number, number>();
    const expenseBreakdownByMonth = new Map<number, Record<string, number>>();
    for (const e of yearExpenseSummaries) {
      expenseByMonth.set(e.month, Number(e.totalExpenses ?? 0));
      const raw = (e.categoryBreakdown ?? {}) as Record<string, unknown>;
      const normalized: Record<string, number> = {};
      for (const [cat, amt] of Object.entries(raw)) {
        const val = Number(amt) || 0;
        if (val > 0) normalized[cat] = val;
      }
      if (Object.keys(normalized).length > 0) {
        expenseBreakdownByMonth.set(e.month, normalized);
      }
    }
    const yearlyBreakdown = Array.from({ length: 12 }, (_, i) => i + 1).map((monthNo) => {
      const paidCount = monthPaidCount.get(monthNo) ?? 0;
      const unpaidCount = Math.max(0, (monthTotalCount.get(monthNo) ?? 0) - paidCount);
      return {
        month: monthNo,
        year,
        paidCount,
        unpaidCount,
        totalCollected: collectedByMonth.get(monthNo) ?? 0,
        totalExpense: expenseByMonth.get(monthNo) ?? 0,
        totalExpected: expectedByMonth.get(monthNo) ?? 0,
        expenseBreakdown: expenseBreakdownByMonth.get(monthNo) ?? {},
      };
    });

    // Phase 1: Enrich with canonical VillaMaintenanceSnapshot data from
    // MaintenanceCollectionCycle. These snapshots are the source of truth
    // (same data the Overview tab uses) and always override old Maintenance
    // table aggregates when present.
    const yearCollectionCycles = await prisma.maintenanceCollectionCycle.findMany({
      where: maintenanceCollectionBackedByBillingCycleWhere(
        societyId,
        await loadAppVisibleBillingCyclePeriodKeys(prisma, societyId),
        { periodYear: year },
      ),
      select: {
        id: true,
        periodMonth: true,
        snapshots: {
          select: {
            expectedAmount: true,
            paidAmount: true,
            status: true,
          },
        },
      },
    });
    const snapshotsByMonth = new Map<number, (typeof yearCollectionCycles)[number]["snapshots"]>();
    for (const mc of yearCollectionCycles) {
      const existing = snapshotsByMonth.get(mc.periodMonth) ?? [];
      existing.push(...mc.snapshots);
      snapshotsByMonth.set(mc.periodMonth, existing);
    }
    for (const [monthNo, snaps] of snapshotsByMonth) {
      if (monthNo < 1 || monthNo > 12 || snaps.length === 0) continue;
      // Exclude WAIVED — society chose not to collect; they shouldn't inflate
      // expected or count as unpaid.  Matches computeSocietyMoneySnapshot().
      const active = snaps.filter((s) => s.status !== "WAIVED");
      if (active.length === 0) continue;
      const entry = yearlyBreakdown[monthNo - 1];
      entry.totalExpected = active.reduce((sum, s) => sum + Number(s.expectedAmount), 0);
      entry.totalCollected = active.reduce((sum, s) => sum + Number(s.paidAmount), 0);
      entry.paidCount = active.filter((s) => s.status === "PAID").length;
      entry.unpaidCount = Math.max(0, active.length - entry.paidCount);
    }

    // Phase 2: Fallback — enrich with BillingCycle data for months that have
    // neither old Maintenance records nor MaintenanceCollectionCycle snapshots.
    const yearBillingCycles = (
      await prisma.billingCycle.findMany({
      where: { societyId, cycleKey: { startsWith: `${year}-` }, ...publishedBillingCycleFilter },
      select: {
        id: true,
        cycleKey: true,
        amount: true,
        paymentStartDate: true,
        paymentEndDate: true,
        publishedAt: true,
        payments: {
          where: { paymentStatus: "SUCCESS" },
          select: { amountPaid: true, userId: true },
        },
      },
    })
    ).filter((bc) => isAppVisibleBillingCycle(now, bc));
    for (const bc of yearBillingCycles) {
      const parts = bc.cycleKey.split("-");
      const monthNo = parseInt(parts[1], 10);
      if (monthNo < 1 || monthNo > 12) continue;
      const entry = yearlyBreakdown[monthNo - 1];
      if (entry.totalExpected === 0 && entry.paidCount === 0 && entry.unpaidCount === 0) {
        const bcAmount = Number(bc.amount);
        const villaCount = villas.length;
        const collected = bc.payments.reduce((sum, p) => sum + Number(p.amountPaid), 0);
        const paidUserIds = new Set(bc.payments.map((p) => p.userId));
        entry.totalExpected = bcAmount * villaCount;
        entry.totalCollected = collected;
        entry.paidCount = paidUserIds.size;
        entry.unpaidCount = Math.max(0, villaCount - paidUserIds.size);
      }
    }

    const liveCategoryBreakdown: Record<string, number> = {};
    let liveExpenseTotal = 0;
    for (const expense of periodLiveExpenses) {
      const key = expense.category?.name ?? "Other";
      const amt = Number(expense.amount);
      if (amt <= 0) continue;
      liveExpenseTotal += amt;
      liveCategoryBreakdown[key] = (liveCategoryBreakdown[key] ?? 0) + amt;
    }
    const hasLiveExpenses = liveExpenseTotal > 0;
    const residentExpenseTotal = hasLiveExpenses
      ? liveExpenseTotal
      : Number(monthlyExpenseSummary?.totalExpenses ?? 0);
    const residentCategoryBreakdown = hasLiveExpenses
      ? liveCategoryBreakdown
      : ((monthlyExpenseSummary?.categoryBreakdown ?? {}) as Record<string, unknown>);

    return res.json({
      filter: { month, year },
      userSummary: {
        villaId: user.villaId,
        villaNumber: user.villa?.villaNumber ?? null,
        totalPaid,
        totalPending,
        paidCount: ledgerRows.filter((row) => row.remainingDue <= 0.005).length,
        pendingCount: ledgerRows.filter((row) => row.remainingDue > 0.005).length,
        billingCycleId: currentLedgerRow?.cycleId ?? null,
        cycleKey: currentLedgerRow?.cycleKey ?? null,
        currentStatus: currentLedgerRow?.status ?? currentRecord?.status ?? "NOT_GENERATED",
        currentDueDate: currentLedgerRow?.dueDate ?? currentRecord?.dueDate ?? null,
        expectedAmount: currentLedgerRow?.expectedAmount ?? 0,
        paidAmount: currentLedgerRow?.paidAmount ?? 0,
        cashPaidAmount: currentLedgerRow?.cashPaidAmount ?? 0,
        creditApplied: currentLedgerRow?.creditApplied ?? 0,
        remainingDue: currentLedgerRow?.remainingDue ?? 0,
        previousDue: currentLedgerRow?.previousDue ?? 0,
        carryForwardBalance: currentLedgerRow?.carryForwardBalance ?? 0,
        lastPayment: latestLedgerCashPayment
          ? {
              amount: latestLedgerCashPayment.cashPaidAmount,
              paymentDate: latestLedgerCashPayment.paidAt,
              paymentMode: "RECORDED",
              receiptNumber: null,
            }
          : latestPayment
          ? {
              amount: Number(latestPayment.amount),
              paymentDate: latestPayment.paymentDate,
              paymentMode: latestPayment.paymentMode,
              receiptNumber: latestPayment.receiptNumber,
            }
          : null,
      },
      paymentHistory: ledgerRows
        .filter((row) => row.cashPaidAmount > 0.005 || row.creditApplied > 0.005 || row.remainingDue > 0.005)
        .sort((a, b) => (b.year - a.year) || (b.month - a.month))
        .map((row) => ({
          id: row.id,
          cycleId: row.cycleId,
          cycleKey: row.cycleKey,
          title: row.title,
          month: row.month,
          year: row.year,
          amount: row.cashPaidAmount,
          expectedAmount: row.expectedAmount,
          paidAmount: row.paidAmount,
          cashPaidAmount: row.cashPaidAmount,
          creditApplied: row.creditApplied,
          remainingDue: row.remainingDue,
          previousDue: row.previousDue,
          carryForwardBalance: row.carryForwardBalance,
          paymentDate: row.paidAt,
          paymentMode: row.cashPaidAmount > 0.005 ? "RECORDED" : "AUTO_ADJUSTED",
          receiptNumber: null,
          transactionId: null,
          status: row.status,
          dueDate: row.dueDate,
        })),
      pendingDues: ledgerRows
        .filter((row) => row.remainingDue > 0.005)
        .sort((a, b) => (a.year - b.year) || (a.month - b.month))
        .map((row) => ({
          id: row.id,
          cycleId: row.cycleId,
          cycleKey: row.cycleKey,
          title: row.title,
          month: row.month,
          year: row.year,
          amount: row.remainingDue,
          expectedAmount: row.expectedAmount,
          paidAmount: row.paidAmount,
          cashPaidAmount: row.cashPaidAmount,
          creditApplied: row.creditApplied,
          previousDue: row.previousDue,
          dueDate: row.dueDate,
          status: row.status,
          isOverdue: row.isOverdue,
        })),
      monthlyExpenseBreakdown: {
        month,
        year,
        totalExpenses: residentExpenseTotal,
        netAmount: Number(monthlyExpenseSummary?.netAmount ?? residentExpenseTotal),
        categoryBreakdown: residentCategoryBreakdown,
      },
      residentsSummary: {
        totalResidents: residents.length,
        billedHomesCount: billedHomesCount > 0 ? billedHomesCount : residents.length,
        paidCount: paidResidentsCount,
        unpaidCount: unpaidResidentsCount,
        partialCount: partialResidentsCount,
        overdueCount: overdueResidentsCount,
        totalExpectedCollection,
        totalCollected: totalCollectedCollection,
        totalPending: totalPendingCollection,
      },
      residents,
      pendingResidents: pendingResidents.map((r) => ({
        residentId: r.residentId,
        name: r.name,
        flatNumber: r.flatNumber,
        amount: r.amount,
        status: r.status,
      })),
      yearlyBreakdown,
      globalPendingDues: globalPending.map((s) => {
        const totals = resolveSnapshotCycleTotals(lateFeeCtx, {
          villaId: s.villaId,
          financialYearId: s.cycle.financialYearId,
          periodKey: s.cycle.periodKey,
          snapshot: s,
          nowUtc: nowForLateFee,
        });
        const remaining = Math.max(0, totals.totalExpected - Number(s.paidAmount));
        return {
          id: s.id,
          villaNumber: s.villa?.villaNumber ?? null,
          ownerName: s.villa?.ownerName ?? null,
          month: s.cycle.periodMonth,
          year: s.cycle.periodYear,
          amount: remaining,
          baseExpectedAmount: totals.baseExpectedAmount,
          lateFeeAmount: totals.lateFeeAmount,
          dueDate: s.cycle.dueDate,
          status: s.status,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/maintenance-dashboard/report-pdf
router.get("/maintenance-dashboard/report-pdf", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { month, year } = parseMonthYear(req.query);

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Use canonical VillaMaintenanceSnapshot for totals and pending list.
    const [snapshots, payments] = await Promise.all([
      prisma.villaMaintenanceSnapshot.findMany({
        where: { villaId: user.villaId, cycle: { societyId } },
        select: {
          expectedAmount: true,
          paidAmount: true,
          status: true,
          cycle: { select: { periodMonth: true, periodYear: true, dueDate: true } },
        },
      }),
      prisma.maintenancePayment.findMany({
        where: { societyId, villaId: user.villaId },
        orderBy: { paymentDate: "desc" },
        take: 1,
      }),
    ]);

    const totalPaid = snapshots
      .filter((s) => s.status === "PAID")
      .reduce((sum, s) => sum + Number(s.paidAmount), 0);
    const pendingSnaps = snapshots.filter(
      (s) => s.status === "PENDING" || s.status === "OVERDUE" || s.status === "PARTIAL"
    );
    const totalPending = pendingSnaps.reduce(
      (sum, s) => sum + Math.max(0, Number(s.expectedAmount) - Number(s.paidAmount)),
      0
    );

    const pdfBuffer = await buildResidentPdfBuffer({
      month,
      year,
      summaryRows: [
        { label: "Total Paid", value: `Rs. ${totalPaid.toFixed(0)}` },
        { label: "Total Pending", value: `Rs. ${totalPending.toFixed(0)}` },
        {
          label: "Last Payment",
          value: payments[0]
            ? `Rs. ${Number(payments[0].amount).toFixed(0)} on ${new Date(payments[0].paymentDate).toLocaleDateString()}`
            : "No payments yet",
        },
      ],
      pendingRows: pendingSnaps
        .sort((a, b) => (a.cycle.periodYear - b.cycle.periodYear) || (a.cycle.periodMonth - b.cycle.periodMonth))
        .map((s) => ({
          month: s.cycle.periodMonth,
          year: s.cycle.periodYear,
          amount: Math.max(0, Number(s.expectedAmount) - Number(s.paidAmount)),
          dueDate: s.cycle.dueDate,
        })),
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="resident_maintenance_${year}_${String(month).padStart(2, "0")}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/outstanding-dues
// All villas with any pending maintenance payment across all cycles (society-wide).
// Available to both RESIDENT and ADMIN roles.
router.get(
  "/outstanding-dues",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
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
              financialYearId: true,
              periodKey: true,
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

      const lateFeeCtx = await loadPerCycleLateFeeContext(societyId);
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
            baseExpectedAmount?: number;
            lateFeeAmount?: number;
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
        const totals = resolveSnapshotCycleTotals(lateFeeCtx, {
          villaId: snap.villa.id,
          financialYearId: snap.cycle.financialYearId,
          periodKey: snap.cycle.periodKey,
          snapshot: snap,
          nowUtc: now,
        });
        const baseExpected = totals.baseExpectedAmount;
        const lateFee = totals.lateFeeAmount;
        const expected = totals.totalExpected;
        const paid = Number(snap.paidAmount);
        const remaining = Math.max(0, expected - paid);
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
          baseExpectedAmount: baseExpected,
          lateFeeAmount: lateFee,
          paidAmount: paid,
          remainingDue: remaining,
          dueDate: snap.cycle.dueDate.toISOString(),
          status: isOverdue ? "OVERDUE" : snap.status,
          isOverdue,
        });
      }

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
  },
);

export default router;
