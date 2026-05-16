import { Router } from "express";
import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { MaintenanceBillingRole, UserRole } from "@prisma/client";
import { computeUserBillingLedger } from "../billing-cycle/services/cycle-service";
import { buildCycleFinancialDashboardCore } from "../maintenance-management/financial-dashboard-cycle";

const router = Router();

router.use(requireAuth);

function parseMonthYear(query: any) {
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
  const [ledger, cycles] = await Promise.all([
    computeUserBillingLedger(societyId, userId),
    prisma.billingCycle.findMany({
      where: { societyId },
      select: {
        id: true,
        cycleKey: true,
        title: true,
        paymentEndDate: true,
      },
    }),
  ]);

  const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  const now = new Date();

  return ledger.cycles.map((row) => {
    const cycle = cycleById.get(row.cycleId);
    const dueDate = cycle?.paymentEndDate ?? null;
    const { month, year } = parseCycleMonthYear(row.cycleKey, dueDate);
    const creditApplied = Math.max(0, Math.min(row.expectedAmount, row.balanceBefore));
    const remainingDue = Math.max(0, row.expectedAmount - row.paidAmount);
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
router.get("/my-maintenance", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/maintenance-pending", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/maintenance-history/:year", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.post("/request-receipt", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/maintenance-summary", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/maintenance-dashboard", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { month, year } = parseMonthYear(req.query);
    const billingCycleId = typeof req.query.billingCycleId === "string" ? req.query.billingCycleId.trim() : "";

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, villa: { select: { villaNumber: true } } },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const [ledgerRows, collectionCycleId, currentRecords, payments, globalPending, monthlyExpenseSummary, villas, monthMaintenanceAll, monthPaymentsAll, yearMaintenanceAll, yearPaymentsAll, yearExpenseSummaries] =
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
        prisma.maintenance.findMany({
          where: {
            societyId,
            status: { in: ["PENDING", "OVERDUE"] },
          },
          include: {
            villa: {
              select: { villaNumber: true, ownerName: true },
            },
          },
          orderBy: { dueDate: "asc" },
          take: 100,
        }),
        prisma.monthlyExpenseSummary.findUnique({
          where: {
            societyId_month_year: { societyId, month, year },
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
        prisma.maintenance.findMany({
          where: { societyId, year },
        }),
        prisma.maintenancePayment.findMany({
          where: { societyId, year },
        }),
        prisma.monthlyExpenseSummary.findMany({
          where: { societyId, year },
        }),
      ]);

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
        where: { id: billingCycleId, societyId },
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
          .filter((r) => !(r as any).isExcluded)
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
    for (const m of yearMaintenanceAll) {
      expectedByMonth.set(m.month, (expectedByMonth.get(m.month) ?? 0) + Number(m.amount));
    }
    const maintenanceByMonth = new Map<number, typeof yearMaintenanceAll>();
    for (const m of yearMaintenanceAll) {
      maintenanceByMonth.set(m.month, [...(maintenanceByMonth.get(m.month) ?? []), m]);
    }
    const collectedByMonth = new Map<number, number>();
    for (const p of yearPaymentsAll) {
      collectedByMonth.set(p.month, (collectedByMonth.get(p.month) ?? 0) + Number(p.amount));
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
      const monthRows = maintenanceByMonth.get(monthNo) ?? [];
      const paidCount = monthRows.filter((r) => r.status === "PAID").length;
      const unpaidCount = Math.max(0, monthRows.length - paidCount);
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

    // Enrich yearlyBreakdown with BillingCycle data where old Maintenance
    // table has no records (society migrated to the new billing system).
    const yearBillingCycles = await prisma.billingCycle.findMany({
      where: { societyId, cycleKey: { startsWith: `${year}-` } },
      select: {
        id: true,
        cycleKey: true,
        amount: true,
        payments: {
          where: { paymentStatus: "SUCCESS" },
          select: { amountPaid: true, userId: true },
        },
      },
    });
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
        totalExpenses: Number(monthlyExpenseSummary?.totalExpenses ?? 0),
        netAmount: Number(monthlyExpenseSummary?.netAmount ?? 0),
        categoryBreakdown: monthlyExpenseSummary?.categoryBreakdown ?? {},
      },
      residentsSummary: {
        totalResidents: residents.length,
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
      globalPendingDues: globalPending.map((d) => ({
        id: d.id,
        villaNumber: d.villa?.villaNumber ?? null,
        ownerName: d.villa?.ownerName ?? null,
        month: d.month,
        year: d.year,
        amount: Number(d.amount),
        dueDate: d.dueDate,
        status: d.status,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/maintenance-dashboard/report-pdf
router.get("/maintenance-dashboard/report-pdf", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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

    const [allRecords, payments, pending] = await Promise.all([
      prisma.maintenance.findMany({
        where: { societyId, villaId: user.villaId },
      }),
      prisma.maintenancePayment.findMany({
        where: { societyId, villaId: user.villaId },
        orderBy: { paymentDate: "desc" },
      }),
      prisma.maintenance.findMany({
        where: {
          societyId,
          villaId: user.villaId,
          status: { in: ["PENDING", "OVERDUE"] },
        },
        orderBy: [{ year: "asc" }, { month: "asc" }],
      }),
    ]);

    const totalPaid = allRecords
      .filter((r) => r.status === "PAID")
      .reduce((sum, r) => sum + Number(r.amount), 0);
    const totalPending = pending.reduce((sum, r) => sum + Number(r.amount), 0);

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
      pendingRows: pending.map((p) => ({
        month: p.month,
        year: p.year,
        amount: Number(p.amount),
        dueDate: p.dueDate,
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

export default router;
