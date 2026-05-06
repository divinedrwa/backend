import { UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

const additionalFundSchema = z.object({
  title: z.string().min(2).max(120),
  amount: z.number().positive(),
  receivedDate: z.string().datetime(),
  destination: z.enum(["MERGE_WITH_MAINTENANCE", "KEEP_SEPARATE"]),
  // Free-text source, e.g. donation, event sponsorship, corpus transfer, penalties, etc.
  source: z.string().max(250).optional(),
  notes: z.string().max(500).optional(),
});

function parseMonthYear(query: any) {
  const now = new Date();
  const month = Number(query.month ?? now.getMonth() + 1);
  const year = Number(query.year ?? now.getFullYear());
  return {
    month: Number.isFinite(month) && month >= 1 && month <= 12 ? month : now.getMonth() + 1,
    year: Number.isFinite(year) && year >= 2000 ? year : now.getFullYear(),
  };
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
  villaId: z.string().cuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  amount: z.number().positive(),
  paymentDate: z.string().datetime(),
  paymentMode: z.enum(["CASH", "UPI", "CHEQUE", "BANK_TRANSFER"]),
  transactionId: z.string().optional(),
  bankAccountId: z.string().cuid().optional(),
  remarks: z.string().optional(),
});

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

    const receiptNumber = existingPayment?.receiptNumber ?? `RCP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const payment = existingPayment
      ? await prisma.maintenancePayment.update({
          where: { id: existingPayment.id },
          data: {
            maintenanceId: maintenance.id,
            amount: body.amount,
            paymentDate: new Date(body.paymentDate),
            paymentMode: body.paymentMode,
            transactionId: body.transactionId,
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

    return res.status(201).json({
      message: "Payment marked successfully",
      payment,
      maintenance,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance-management/year-report/:year
// Get year-wise payment report
router.get("/year-report/:year", async (req, res, next) => {
  try {
    const year = parseInt(req.params.year);
    const { societyId } = req.auth!;

    if (isNaN(year)) {
      return res.status(400).json({ message: "Invalid year" });
    }

    // Get total villas and their monthly maintenance
    const villas = await prisma.villa.findMany({
      where: { societyId },
      select: { monthlyMaintenance: true },
    });

    const monthlyExpectedTotal = villas.reduce(
      (sum, v) => sum + Number(v.monthlyMaintenance),
      0
    );

    // Get maintenance payments for each month
    const monthlyData = [];

    for (let month = 1; month <= 12; month++) {
      const payments = await prisma.maintenancePayment.findMany({
        where: {
          societyId,
          year,
          month,
        },
      });

      const collected = payments.reduce(
        (sum, p) => sum + Number(p.amount),
        0
      );
      const pending = monthlyExpectedTotal - collected;
      const collectionRate = monthlyExpectedTotal > 0
        ? Math.round((collected / monthlyExpectedTotal) * 100)
        : 0;

      monthlyData.push({
        month,
        totalAmount: monthlyExpectedTotal,
        collected,
        pending,
        collectionRate,
        paymentCount: payments.length,
      });
    }

    // Calculate yearly totals
    const yearlyTotal = monthlyExpectedTotal * 12;
    const yearlyCollected = monthlyData.reduce((sum, m) => sum + m.collected, 0);
    const yearlyPending = yearlyTotal - yearlyCollected;
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
    const avgPaymentDelay = 0; // TODO: Calculate average delay

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
    const { societyId } = req.auth!;
    const { payments: paymentsData } = req.body as z.infer<typeof bulkMarkPaidSchema>;

    const results = [];

    for (const paymentData of paymentsData) {
      try {
        // Find or create maintenance
        let maintenance = await prisma.maintenance.findFirst({
          where: {
            societyId,
            villaId: paymentData.villaId,
            year: paymentData.year,
            month: paymentData.month,
          },
        });

        if (!maintenance) {
          const dueDate = new Date(paymentData.year, paymentData.month - 1, 5);
          maintenance = await prisma.maintenance.create({
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
          maintenance = await prisma.maintenance.update({
            where: { id: maintenance.id },
            data: { status: "PAID" },
          });
        }

        const existingPayment = await prisma.maintenancePayment.findFirst({
          where: {
            societyId,
            villaId: paymentData.villaId,
            year: paymentData.year,
            month: paymentData.month,
          },
          orderBy: { paymentDate: "desc" },
          select: { id: true, receiptNumber: true },
        });

        const receiptNumber = existingPayment?.receiptNumber ?? `RCP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const payment = existingPayment
          ? await prisma.maintenancePayment.update({
              where: { id: existingPayment.id },
              data: {
                maintenanceId: maintenance.id,
                amount: paymentData.amount,
                paymentDate: new Date(paymentData.paymentDate),
                paymentMode: paymentData.paymentMode,
                transactionId: paymentData.transactionId,
                bankAccountId: paymentData.bankAccountId,
              },
            })
          : await prisma.maintenancePayment.create({
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
              },
            });

        results.push({ success: true, villaId: paymentData.villaId, payment });
      } catch (err) {
        results.push({ 
          success: false, 
          villaId: paymentData.villaId, 
          error: (err as Error).message 
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;

    return res.status(201).json({
      message: `${successCount} of ${results.length} payments marked successfully`,
      results,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance-management/financial-dashboard
router.get("/financial-dashboard", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { month, year } = parseMonthYear(req.query);

    const [
      villas,
      monthMaintenance,
      monthPayments,
      globalPending,
      expenses,
      allTimeCollections,
      allTimeExpenses,
      allTimeAdditionalMerged,
      monthAdditionalMerged,
      recentAdditionalFunds,
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
      prisma.maintenance.findMany({
        where: { societyId, status: { in: ["PENDING", "OVERDUE"] } },
        include: { villa: { select: { villaNumber: true, ownerName: true } } },
        orderBy: { dueDate: "asc" },
        take: 250,
      }),
      prisma.expense.findMany({
        where: { societyId, month, year },
        include: { category: true },
      }),
      prisma.maintenancePayment.aggregate({
        where: { societyId },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { societyId },
        _sum: { amount: true },
      }),
      prisma.additionalFund.aggregate({
        where: { societyId, destination: "MERGE_WITH_MAINTENANCE" },
        _sum: { amount: true },
      }),
      prisma.additionalFund.aggregate({
        where: { societyId, month, year, destination: "MERGE_WITH_MAINTENANCE" },
        _sum: { amount: true },
      }),
      prisma.additionalFund.findMany({
        where: { societyId },
        orderBy: { receivedDate: "desc" },
        take: 25,
      }),
    ]);

    const maintenanceMap = new Map(monthMaintenance.map((m) => [m.villaId, m]));
    const paymentMap = new Map(monthPayments.map((p) => [p.villaId, p]));

    const residents = villas.map((villa) => {
      const m = maintenanceMap.get(villa.id);
      const p = paymentMap.get(villa.id);
      const status = m?.status ?? "UNPAID";
      return {
        villaId: villa.id,
        villaNumber: villa.villaNumber,
        ownerName: villa.ownerName,
        amount: Number(villa.monthlyMaintenance),
        status,
        dueDate: m?.dueDate ?? null,
        paidAt: p?.paymentDate ?? null,
        receiptNumber: p?.receiptNumber ?? null,
        paymentMode: p?.paymentMode ?? null,
      };
    });

    const totalExpected = villas.reduce((sum, v) => sum + Number(v.monthlyMaintenance), 0);
    const collected = monthPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const pendingAmount = Math.max(0, totalExpected - collected);
    const paidCount = residents.filter((r) => r.status === "PAID").length;
    const overdueCount = residents.filter((r) => r.status === "OVERDUE").length;
    const unpaidCount = residents.length - paidCount;

    const mergedAllTimeInflow = Number(allTimeAdditionalMerged._sum.amount || 0);
    const mergedMonthInflow = Number(monthAdditionalMerged._sum.amount || 0);
    const allTimeCollected = Number(allTimeCollections._sum.amount || 0) + mergedAllTimeInflow;
    const allTimeSpent = Number(allTimeExpenses._sum.amount || 0);
    const currentFundBalance = allTimeCollected - allTimeSpent;

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
        maintenanceCollected: collected,
        additionalMergedInflowAllTime: mergedAllTimeInflow,
        additionalMergedInflowMonth: mergedMonthInflow,
        monthNet: collected + mergedMonthInflow - expenses.reduce((sum, e) => sum + Number(e.amount), 0),
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
      globalPendingDues: globalPending.map((g) => ({
        id: g.id,
        villaId: g.villaId,
        villaNumber: g.villa?.villaNumber ?? null,
        ownerName: g.villa?.ownerName ?? null,
        month: g.month,
        year: g.year,
        amount: Number(g.amount),
        dueDate: g.dueDate,
        status: g.status,
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

    const pending = await prisma.maintenance.findMany({
      where: {
        societyId,
        month,
        year,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      include: { villa: { select: { villaNumber: true } } },
    });

    if (pending.length === 0) {
      return res.json({ message: "No pending dues for selected period", sent: 0 });
    }

    const villaIds = pending.map((p) => p.villaId);
    const recipients = await prisma.user.findMany({
      where: {
        societyId,
        role: UserRole.RESIDENT,
        villaId: { in: villaIds },
      },
      select: { id: true, villaId: true },
    });

    const amountByVilla = new Map(
      pending.map((p) => [p.villaId, Number(p.amount)])
    );
    const villaNumberByVilla = new Map(
      pending.map((p) => [p.villaId, p.villa.villaNumber])
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

// GET /api/maintenance-management/financial-dashboard/report-pdf
router.get("/financial-dashboard/report-pdf", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { month, year } = parseMonthYear(req.query);

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

    const expected = villas.reduce((sum, v) => sum + Number(v.monthlyMaintenance), 0);
    const collected = monthPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const pending = Math.max(0, expected - collected);
    const rate = expected > 0 ? Math.round((collected / expected) * 100) : 0;

    const pdfBuffer = await buildMaintenancePdfBuffer({
      title: "Maintenance Financial Dashboard Report",
      month,
      year,
      summaryRows: [
        { label: "Total Villas", value: `${villas.length}` },
        { label: "Total Expected", value: `Rs. ${expected.toFixed(0)}` },
        { label: "Collected", value: `Rs. ${collected.toFixed(0)}` },
        { label: "Pending", value: `Rs. ${pending.toFixed(0)}` },
        { label: "Collection Rate", value: `${rate}%` },
      ],
      pendingRows: globalPending.map((g) => ({
        villaNumber: g.villa?.villaNumber ?? "-",
        ownerName: g.villa?.ownerName ?? "-",
        amount: Number(g.amount),
        month: g.month,
        year: g.year,
      })),
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=\"maintenance_dashboard_${year}_${String(month).padStart(2, "0")}.pdf\"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

export default router;
