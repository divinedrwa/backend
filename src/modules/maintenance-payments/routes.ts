import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { Prisma, UserRole } from "@prisma/client";
import { logger } from "../../lib/logger";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { getCachedMoneySnapshot } from "../../lib/societyFinance";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { recordPaymentAndSyncLedgers } from "./record-payment";

const router = Router();

/** Mask account numbers in a payment's included bankAccount relation. */
function maskPaymentBankAccount<T extends { bankAccount?: { accountNumber?: string } | null }>(payment: T): T {
  if (payment.bankAccount?.accountNumber) {
    const acct = payment.bankAccount.accountNumber;
    return {
      ...payment,
      bankAccount: {
        ...payment.bankAccount,
        accountNumber: acct.length > 4 ? "****" + acct.slice(-4) : "****",
      },
    };
  }
  return payment;
}

// 🔥 Rate limiting for payment operations
const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per IP
  message: 'Too many payment requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many payment requests from this IP. Please try again in 1 minute.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

// Validation schemas
const recordPaymentSchema = z.object({
  villaId: z.string(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020),
  amount: z.number().positive(),
  paymentDate: z.string().datetime(),
  paymentMode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "ONLINE"]),
  transactionId: z.string().optional(),
  bankAccountId: z.string().optional(),
  remarks: z.string().trim().optional(),
  idempotencyKey: z.string().min(10).max(255).optional(), // Prevent duplicates
});

const generateBillsSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020),
  dueDate: z.string().datetime(),
});

// POST /api/maintenance/payments - Record payment
router.post(
  "/payments",
  paymentRateLimiter, // Apply rate limiting
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  validateBody(recordPaymentSchema),
  async (req, res, _next) => {
  try {
    const { societyId, userId } = req.auth!;
    const { villaId, month, year, amount, paymentDate, paymentMode, transactionId, bankAccountId, remarks, idempotencyKey } = req.body;

    // Validate amount is positive
    if (amount <= 0) {
      return res.status(400).json({ 
        error: "INVALID_AMOUNT",
        message: "Payment amount must be positive" 
      });
    }

    // 🔥 CRITICAL FIX: Check idempotency key to prevent duplicates
    if (idempotencyKey) {
      const existing = await prisma.maintenancePayment.findUnique({
        where: { idempotencyKey },
        include: {
          villa: { select: { villaNumber: true, ownerName: true } },
          bankAccount: { select: { bankName: true, accountNumber: true } },
        },
      });

      if (existing) {
        logger.info(`[Idempotency] Returning existing payment for key: ${idempotencyKey}`);
        return res.status(200).json({
          payment: maskPaymentBankAccount(existing),
          note: 'Payment already recorded (idempotent)',
        });
      }
    }

    // Validate villa exists
    const villa = await prisma.villa.findFirst({
      where: { id: villaId, societyId },
      select: { id: true },
    });
    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    // Residents can only pay for their own villa
    if (req.auth?.role === UserRole.RESIDENT) {
      // Residents cannot self-record any payment mode through this route.
      // - CASH / CHEQUE: admin must confirm physical receipt.
      // - ONLINE / UPI / BANK_TRANSFER: use the dedicated gateway/UPI-submission flows
      //   which enforce approval before touching the ledger.
      // Only ADMIN may call this endpoint to write a payment directly.
      return res.status(403).json({
        message: "Residents cannot record payments directly. Use the online payment or UPI submission flow.",
        code: "RESIDENT_DIRECT_PAYMENT_FORBIDDEN",
      });
    }

    // 🔥 CRITICAL FIX: Wrap ALL operations in transaction
    const result = await prisma.$transaction(async (tx) => {
      return recordPaymentAndSyncLedgers(tx, {
        societyId,
        villaId,
        month,
        year,
        amount,
        paymentDate,
        paymentMode,
        transactionId,
        bankAccountId,
        remarks,
        idempotencyKey,
        recordedByUserId: userId,
      });
    }, {
      maxWait: 5000,  // Max 5s wait for lock
      timeout: 10000, // Max 10s total transaction
      isolationLevel: 'Serializable', // Highest isolation
    });

    return res.status(201).json({ payment: maskPaymentBankAccount(result.payment) });
  } catch (error: unknown) {
    logger.error({ err: error }, '[Payment] Recording failed');
    
    // Sanitize errors for client
    if (error instanceof Error) {
      if (error.message.includes('Unique constraint') || error.message.includes('unique')) {
        return res.status(409).json({
          error: 'DUPLICATE_PAYMENT',
          message: 'A payment for this period already exists',
        });
      }
      if (error.message.includes('negative balance')) {
        return res.status(400).json({
          error: 'INVALID_BALANCE',
          message: error.message,
        });
      }
    }
    
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to record payment. Please try again.',
    });
  }
  }
);

// GET /api/maintenance/payments - List all payments
router.get("/payments", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { month, year, villaId } = req.query;

    const where: Prisma.MaintenancePaymentWhereInput = { societyId };

    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);
    if (villaId) where.villaId = villaId as string;

    const pagination = getPagination(req);
    const [payments, total] = await Promise.all([
      prisma.maintenancePayment.findMany({
        where,
        include: {
          villa: {
            select: {
              villaNumber: true,
              ownerName: true,
            },
          },
          bankAccount: {
            select: {
              bankName: true,
            },
          },
        },
        orderBy: { paymentDate: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.maintenancePayment.count({ where }),
    ]);

    return res.json({
      payments,
      ...paginationMeta(total, payments.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance/payments/:receiptNumber - Get payment by receipt
router.get(
  "/payments/:receiptNumber",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { receiptNumber } = req.params;

    const payment = await prisma.maintenancePayment.findFirst({
      where: {
        receiptNumber,
        societyId,
      },
      include: {
        villa: true,
        bankAccount: true,
      },
    });

    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    return res.json({ payment });
  } catch (error) {
    next(error);
  }
  }
);

// GET /api/maintenance/dashboard - Dashboard statistics
router.get("/dashboard", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    // Pull the canonical money snapshot once for both fund and per-month
    // numbers. Reads both ledgers (MaintenancePayment + UserCyclePayment),
    // so the dashboard agrees with the residents page even when the two
    // ledgers diverged historically.
    const money = await getCachedMoneySnapshot(prisma, societyId);

    /**
     * Cycle-progress view per month: caps each villa's contribution at its
     * expected bill so the rate / pending figures stay sensible. Uses the
     * `Maintenance` rows (the legacy bill ledger) for the cap basis.
     */
    const collectedForMonth = async (month: number, year: number) => {
      const [bills, payments] = await Promise.all([
        prisma.maintenance.findMany({
          where: { societyId, month, year },
          select: { villaId: true, amount: true, status: true },
        }),
        prisma.maintenancePayment.findMany({
          where: { societyId, month, year },
          select: { villaId: true, amount: true },
        }),
      ]);
      const expectedByVilla = new Map<string, number>();
      for (const b of bills) {
        expectedByVilla.set(b.villaId, Number(b.amount));
      }
      const paidByVilla = new Map<string, number>();
      for (const p of payments) {
        paidByVilla.set(p.villaId, (paidByVilla.get(p.villaId) ?? 0) + Number(p.amount));
      }
      let cappedCollected = 0;
      for (const [villaId, paid] of paidByVilla) {
        const expected = expectedByVilla.get(villaId);
        cappedCollected += expected != null ? Math.min(paid, expected) : paid;
      }
      const expected = bills.reduce((sum, b) => sum + Number(b.amount), 0);
      // Canonical cash for the calendar month comes from the snapshot
      // service, which reconciles MaintenancePayment + UserCyclePayment.
      const cashReceived = money.maintenanceCashForMonth(month, year);
      return { expected, cappedCollected, cashReceived, bills };
    };

    const currentSummary = await collectedForMonth(currentMonth, currentYear);
    const currentMonthBills = currentSummary.bills;
    const totalExpected = currentSummary.expected;
    const paidBills = currentMonthBills.filter((b) => b.status === "PAID");
    const pendingBills = currentMonthBills.filter((b) => b.status === "PENDING");
    const overdueBills = currentMonthBills.filter((b) => b.status === "OVERDUE");

    const totalCollected = currentSummary.cappedCollected;
    const totalCashReceived = currentSummary.cashReceived;

    const collectionRate = totalExpected > 0 ? (totalCollected / totalExpected) * 100 : 0;

    // Month-wise collection (last 6 months) — cycle-progress view: each
    // villa's payment is capped at its expected bill so an overpayment
    // doesn't show >100% on the trend chart.
    const monthWiseData = [];
    for (let i = 0; i < 6; i++) {
      const date = new Date(currentYear, currentMonth - 1 - i, 1);
      const m = date.getMonth() + 1;
      const y = date.getFullYear();
      const s = await collectedForMonth(m, y);
      monthWiseData.push({
        month: m,
        year: y,
        monthName: date.toLocaleString("default", { month: "short" }),
        collected: s.cappedCollected,
        cashReceived: s.cashReceived,
        expected: s.expected,
        pending: Math.max(0, s.expected - s.cappedCollected),
        // Net inflow this month (cash received + additional funds − expenses)
        // so a 6-month trend chart based on this endpoint doesn't have to
        // re-aggregate.
        net:
          s.cashReceived +
          money.additionalFundsForMonth(m, y) -
          money.expensesForMonth(m, y),
      });
    }

    // Villa-wise pending
    const allVillas = await prisma.villa.findMany({
      where: { societyId },
      select: {
        id: true,
        villaNumber: true,
        ownerName: true,
        monthlyMaintenance: true,
      },
    });

    // Batch-fetch all pending bills and last payments to avoid N+1 per villa
    const [allPendingBills, allLastPayments] = await Promise.all([
      prisma.maintenance.findMany({
        where: {
          societyId,
          status: { in: ["PENDING", "OVERDUE"] },
        },
        orderBy: { dueDate: "asc" },
      }),
      prisma.maintenancePayment.findMany({
        where: { societyId },
        orderBy: { paymentDate: "desc" },
        distinct: ["villaId"],
        select: { villaId: true, paymentDate: true },
      }),
    ]);

    const pendingByVilla = new Map<string, typeof allPendingBills>();
    for (const bill of allPendingBills) {
      const arr = pendingByVilla.get(bill.villaId) ?? [];
      arr.push(bill);
      pendingByVilla.set(bill.villaId, arr);
    }
    const lastPaymentByVilla = new Map(
      allLastPayments.map((p) => [p.villaId, p.paymentDate])
    );

    const villaWise = allVillas.map((villa) => {
      const bills = pendingByVilla.get(villa.id) ?? [];
      const totalDue = bills.reduce((sum, bill) => sum + Number(bill.amount), 0);
      return {
        villaNumber: villa.villaNumber,
        ownerName: villa.ownerName,
        pendingMonths: bills.length,
        totalDue,
        lastPayment: lastPaymentByVilla.get(villa.id) ?? null,
        oldestPending: bills[0]?.dueDate ?? null,
      };
    });

    // Sort by pending amount
    villaWise.sort((a, b) => b.totalDue - a.totalDue);

    return res.json({
      currentMonth: {
        month: currentMonth,
        year: currentYear,
        totalExpected,
        // Cycle-progress (per-villa capped) — what the rate / pending UI
        // needs to stay sensible (max 100%).
        totalCollected,
        totalPending: Math.max(0, totalExpected - totalCollected),
        collectionRate: Math.round(collectionRate),
        // Actual cash received this month (uncapped) — used by the fund
        // panel so advance credits / overpayments are visible.
        totalCashReceived,
        paidVillas: paidBills.length,
        pendingVillas: pendingBills.length,
        overdueVillas: overdueBills.length,
      },
      // Canonical society fund snapshot — same numbers as
      // /maintenance-management/financial-dashboard so the dashboard cards
      // never disagree.
      fund: {
        currentFundBalance: money.currentFundBalance,
        allTimeCollected:
          money.maintenanceCashAllTime + money.additionalFundsAllTime,
        allTimeSpent: money.expensesAllTime,
        maintenanceCashAllTime: money.maintenanceCashAllTime,
        additionalFundsAllTime: money.additionalFundsAllTime,
        totalAdvanceCredit: money.totalAdvanceCredit,
      },
      monthWise: monthWiseData,
      villaWise: villaWise.filter((v) => v.pendingMonths > 0),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance/pending - Pending payments list
router.get("/pending", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const pagination = getPagination(req);
    const where = { societyId, status: "PENDING" as const };
    const [pendingBills, total] = await Promise.all([
      prisma.maintenance.findMany({
        where,
        include: {
          villa: {
            select: {
              villaNumber: true,
              ownerName: true,
              ownerPhone: true,
              ownerEmail: true,
            },
          },
        },
        orderBy: { dueDate: "asc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.maintenance.count({ where }),
    ]);

    return res.json({
      pending: pendingBills,
      ...paginationMeta(total, pendingBills.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance/overdue - Overdue payments list
router.get("/overdue", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const pagination = getPagination(req);
    const where = { societyId, status: "OVERDUE" as const };
    const [overdueBills, total] = await Promise.all([
      prisma.maintenance.findMany({
        where,
        include: {
          villa: {
            select: {
              villaNumber: true,
              ownerName: true,
              ownerPhone: true,
              ownerEmail: true,
            },
          },
        },
        orderBy: { dueDate: "asc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.maintenance.count({ where }),
    ]);

    return res.json({
      overdue: overdueBills,
      ...paginationMeta(total, overdueBills.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/maintenance/generate-bills - Generate bills for a month
router.post(
  "/generate-bills",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(generateBillsSchema),
  async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { month, year, dueDate } = req.body;

    // Get all villas
    const villas = await prisma.villa.findMany({
      where: { societyId },
    });

    // Check if bills already exist
    const existingBills = await prisma.maintenance.count({
      where: { societyId, month, year },
    });

    if (existingBills > 0) {
      return res.status(400).json({
        message: `Bills for ${month}/${year} already exist`,
      });
    }

    // Create bills for all villas atomically — partial failure leaves no orphans
    const bills = await prisma.$transaction(
      villas.map((villa) =>
        prisma.maintenance.create({
          data: {
            societyId,
            villaId: villa.id,
            month,
            year,
            amount: villa.monthlyMaintenance,
            dueDate: new Date(dueDate),
            status: "PENDING",
          },
        })
      )
    );

    return res.status(201).json({
      message: `Generated ${bills.length} bills for ${month}/${year}`,
      bills,
    });
  } catch (error) {
    next(error);
  }
  }
);

// GET /api/maintenance/villa/:villaId - Villa payment history
router.get("/villa/:villaId", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { villaId } = req.params;

    const pagination = getPagination(req);
    const paymentWhere = { villaId, societyId };
    const [payments, total] = await Promise.all([
      prisma.maintenancePayment.findMany({
        where: paymentWhere,
        include: {
          bankAccount: {
            select: {
              bankName: true,
            },
          },
        },
        orderBy: { paymentDate: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.maintenancePayment.count({ where: paymentWhere }),
    ]);

    const pending = await prisma.maintenance.findMany({
      where: {
        villaId,
        societyId,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      orderBy: { dueDate: "asc" },
    });

    return res.json({ payments, pending, ...paginationMeta(total, payments.length, pagination) });
  } catch (error) {
    next(error);
  }
});

export default router;
