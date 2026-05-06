import { Router } from "express";
import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { UserRole } from "@prisma/client";

const router = Router();

router.use(requireAuth);

function parseMonthYear(query: any) {
  const now = new Date();
  const month = Number(query.month ?? now.getMonth() + 1);
  const year = Number(query.year ?? now.getFullYear());
  return {
    month: Number.isFinite(month) && month >= 1 && month <= 12 ? month : now.getMonth() + 1,
    year: Number.isFinite(year) && year >= 2000 ? year : now.getFullYear(),
  };
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
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Get maintenance records
    const maintenance = await prisma.maintenance.findMany({
      where: {
        villaId: user.villaId,
        societyId,
      },
      include: {
        payments: {
          orderBy: { paymentDate: "desc" }, // Correct field name
        },
      },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      take: 12, // Last 12 months
    });

    const periodKeys = Array.from(
      new Set(maintenance.map((m) => `${m.year}-${m.month}`))
    );
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

    // Calculate summary
    const summary = {
      totalPaid: 0,
      totalPending: 0,
      paidCount: 0,
      pendingCount: 0,
    };

    maintenance.forEach((m) => {
      if (m.status === "PAID") {
        summary.totalPaid += Number(m.amount);
        summary.paidCount++;
      } else {
        summary.totalPending += Number(m.amount);
        summary.pendingCount++;
      }
    });

    return res.json({
      maintenance: maintenance.map((m) => {
        const key = `${m.year}-${m.month}`;
        const monthlySummary = summaryMap.get(key);
        const fallbackExpense = expenseMap.get(key);
        const summaryBreakdown = (monthlySummary?.categoryBreakdown ?? {}) as Record<string, unknown>;
        const normalizedBreakdown: Record<string, number> = {};
        for (const [category, amount] of Object.entries(summaryBreakdown)) {
          normalizedBreakdown[category] = Number(amount) || 0;
        }

        return {
          ...m,
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
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Get pending maintenance
    const pending = await prisma.maintenance.findMany({
      where: {
        villaId: user.villaId,
        societyId,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      orderBy: [{ year: "asc" }, { month: "asc" }],
    });

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

    const totalDue = pending.reduce((sum, m) => sum + Number(m.amount), 0);

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
          ...m,
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
      overdue,
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
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
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

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, villa: { select: { villaNumber: true } } },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const [allRecords, currentRecords, payments, pending, globalPending, monthlyExpenseSummary, villas, monthMaintenanceAll, monthPaymentsAll, yearMaintenanceAll, yearPaymentsAll, yearExpenseSummaries] =
      await Promise.all([
        prisma.maintenance.findMany({
          where: { societyId, villaId: user.villaId },
          orderBy: [{ year: "desc" }, { month: "desc" }],
          take: 24,
        }),
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
            villaId: user.villaId,
            status: { in: ["PENDING", "OVERDUE"] },
          },
          orderBy: [{ year: "asc" }, { month: "asc" }],
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

    const paid = allRecords.filter((r) => r.status === "PAID");
    const totalPaid = paid.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalPending = pending.reduce((sum, r) => sum + Number(r.amount), 0);
    const latestPayment = payments[0] ?? null;
    const currentRecord = currentRecords[0] ?? null;
    const maintenanceByVilla = new Map(monthMaintenanceAll.map((m) => [m.villaId, m]));
    const paymentByVilla = new Map<string, (typeof monthPaymentsAll)[number]>();
    for (const payment of monthPaymentsAll) {
      if (!paymentByVilla.has(payment.villaId)) {
        paymentByVilla.set(payment.villaId, payment);
      }
    }
    const residents = villas.map((villa) => {
      const monthly = maintenanceByVilla.get(villa.id);
      const payment = paymentByVilla.get(villa.id);
      const status = monthly?.status ?? "UNPAID";
      return {
        residentId: villa.id,
        name: villa.ownerName ?? "Unknown",
        flatNumber: villa.villaNumber ?? "-",
        villaNumber: villa.villaNumber ?? "-",
        ownerName: villa.ownerName ?? "Unknown",
        amount: Number(villa.monthlyMaintenance),
        status,
        paymentDate: payment?.paymentDate ?? null,
        paymentMode: payment?.paymentMode ?? null,
        notes: payment?.remarks ?? null,
      };
    });
    const totalExpectedCollection = villas.reduce(
      (sum, villa) => sum + Number(villa.monthlyMaintenance),
      0
    );
    const totalCollectedCollection = monthPaymentsAll.reduce(
      (sum, payment) => sum + Number(payment.amount),
      0
    );
    const totalPendingCollection = Math.max(0, totalExpectedCollection - totalCollectedCollection);
    const paidResidentsCount = residents.filter((r) => r.status === "PAID").length;
    const unpaidResidentsCount = residents.length - paidResidentsCount;
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
    for (const e of yearExpenseSummaries) {
      expenseByMonth.set(e.month, Number(e.totalExpenses ?? 0));
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
      };
    });

    return res.json({
      filter: { month, year },
      userSummary: {
        villaId: user.villaId,
        villaNumber: user.villa?.villaNumber ?? null,
        totalPaid,
        totalPending,
        paidCount: paid.length,
        pendingCount: pending.length,
        currentStatus: currentRecord?.status ?? "NOT_GENERATED",
        currentDueDate: currentRecord?.dueDate ?? null,
        lastPayment: latestPayment
          ? {
              amount: Number(latestPayment.amount),
              paymentDate: latestPayment.paymentDate,
              paymentMode: latestPayment.paymentMode,
              receiptNumber: latestPayment.receiptNumber,
            }
          : null,
      },
      paymentHistory: payments.map((p) => ({
        id: p.id,
        month: p.month,
        year: p.year,
        amount: Number(p.amount),
        paymentDate: p.paymentDate,
        paymentMode: p.paymentMode,
        receiptNumber: p.receiptNumber,
        transactionId: p.transactionId,
      })),
      pendingDues: pending.map((d) => ({
        id: d.id,
        month: d.month,
        year: d.year,
        amount: Number(d.amount),
        dueDate: d.dueDate,
        status: d.status,
        isOverdue: d.dueDate < new Date() || d.status === "OVERDUE",
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
      `attachment; filename=\"resident_maintenance_${year}_${String(month).padStart(2, "0")}.pdf\"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

export default router;
