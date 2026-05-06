import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { PaymentMode, UserRole } from "@prisma/client";

const router = Router();

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
  remarks: z.string().optional(),
});

const generateBillsSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020),
  dueDate: z.string().datetime(),
});

// POST /api/maintenance/payments - Record payment
router.post(
  "/payments",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  validateBody(recordPaymentSchema),
  async (req, res, next) => {
  try {
    const { societyId, userId } = req.auth!;
    const { villaId, month, year, amount, paymentDate, paymentMode, transactionId, bankAccountId, remarks } = req.body;

    const villa = await prisma.villa.findFirst({
      where: { id: villaId, societyId },
      select: { id: true },
    });
    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    // Residents can only pay for their own villa.
    if (req.auth?.role === UserRole.RESIDENT) {
      const resident = await prisma.user.findFirst({
        where: { id: userId, societyId },
        select: { villaId: true },
      });
      if (!resident?.villaId || resident.villaId !== villaId) {
        return res.status(403).json({ message: "You can only pay for your own villa" });
      }
    }

    // Find/create maintenance row so payment stays linked for resident history/dashboard joins.
    let maintenance = await prisma.maintenance.findFirst({
      where: { societyId, villaId, month, year },
    });
    if (!maintenance) {
      maintenance = await prisma.maintenance.create({
        data: {
          societyId,
          villaId,
          month,
          year,
          amount,
          dueDate: new Date(year, month - 1, 5),
          status: "PAID",
        },
      });
    } else if (maintenance.status !== "PAID") {
      maintenance = await prisma.maintenance.update({
        where: { id: maintenance.id },
        data: { status: "PAID" },
      });
    }

    const existingPayment = await prisma.maintenancePayment.findFirst({
      where: { societyId, villaId, month, year },
      orderBy: { paymentDate: "desc" },
      select: { id: true, receiptNumber: true },
    });

    // Generate unique receipt number for first payment of the month.
    const receiptNumber = existingPayment?.receiptNumber
      ? existingPayment.receiptNumber
      : `RCP${year}${String(month).padStart(2, "0")}${Date.now().toString().slice(-6)}`;

    const payment = existingPayment
      ? await prisma.maintenancePayment.update({
          where: { id: existingPayment.id },
          data: {
            maintenanceId: maintenance.id,
            amount,
            paymentDate: new Date(paymentDate),
            paymentMode: paymentMode as PaymentMode,
            transactionId,
            bankAccountId,
            remarks,
          },
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
                accountNumber: true,
              },
            },
          },
        })
      : await prisma.maintenancePayment.create({
          data: {
            societyId,
            villaId,
            maintenanceId: maintenance.id,
            month,
            year,
            amount,
            paymentDate: new Date(paymentDate),
            paymentMode: paymentMode as PaymentMode,
            transactionId,
            receiptNumber,
            bankAccountId,
            remarks,
          },
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
                accountNumber: true,
              },
            },
          },
        });

    return res.status(201).json({ payment });
  } catch (error) {
    next(error);
  }
  }
);

// GET /api/maintenance/payments - List all payments
router.get("/payments", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { month, year, villaId } = req.query;

    const where: any = { societyId };
    
    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);
    if (villaId) where.villaId = villaId;

    const payments = await prisma.maintenancePayment.findMany({
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
    });

    return res.json({ payments });
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

    // Current month stats
    const currentMonthBills = await prisma.maintenance.findMany({
      where: {
        societyId,
        month: currentMonth,
        year: currentYear,
      },
    });

    const totalExpected = currentMonthBills.reduce((sum, bill) => sum + Number(bill.amount), 0);
    const paidBills = currentMonthBills.filter(b => b.status === "PAID");
    const pendingBills = currentMonthBills.filter(b => b.status === "PENDING");
    const overdueBills = currentMonthBills.filter(b => b.status === "OVERDUE");

    const totalCollected = await prisma.maintenancePayment.aggregate({
      where: {
        societyId,
        month: currentMonth,
        year: currentYear,
      },
      _sum: { amount: true },
    });

    const collectionRate = totalExpected > 0 ? (Number(totalCollected._sum.amount || 0) / totalExpected) * 100 : 0;

    // Month-wise collection (last 6 months)
    const monthWiseData = [];
    for (let i = 0; i < 6; i++) {
      const date = new Date(currentYear, currentMonth - 1 - i, 1);
      const m = date.getMonth() + 1;
      const y = date.getFullYear();

      const collected = await prisma.maintenancePayment.aggregate({
        where: { societyId, month: m, year: y },
        _sum: { amount: true },
      });

      const bills = await prisma.maintenance.findMany({
        where: { societyId, month: m, year: y },
      });

      const expected = bills.reduce((sum, bill) => sum + Number(bill.amount), 0);
      const pending = expected - Number(collected._sum.amount || 0);

      monthWiseData.push({
        month: m,
        year: y,
        monthName: date.toLocaleString('default', { month: 'short' }),
        collected: Number(collected._sum.amount || 0),
        expected,
        pending,
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

    const villaWise = await Promise.all(
      allVillas.map(async (villa) => {
        const pendingBills = await prisma.maintenance.findMany({
          where: {
            villaId: villa.id,
            status: { in: ["PENDING", "OVERDUE"] },
          },
          orderBy: { dueDate: "asc" },
        });

        const lastPayment = await prisma.maintenancePayment.findFirst({
          where: { villaId: villa.id },
          orderBy: { paymentDate: "desc" },
        });

        const totalDue = pendingBills.reduce((sum, bill) => sum + Number(bill.amount), 0);

        return {
          villaNumber: villa.villaNumber,
          ownerName: villa.ownerName,
          pendingMonths: pendingBills.length,
          totalDue,
          lastPayment: lastPayment?.paymentDate,
          oldestPending: pendingBills[0]?.dueDate,
        };
      })
    );

    // Sort by pending amount
    villaWise.sort((a, b) => b.totalDue - a.totalDue);

    return res.json({
      currentMonth: {
        month: currentMonth,
        year: currentYear,
        totalExpected,
        totalCollected: Number(totalCollected._sum.amount || 0),
        totalPending: totalExpected - Number(totalCollected._sum.amount || 0),
        collectionRate: Math.round(collectionRate),
        paidVillas: paidBills.length,
        pendingVillas: pendingBills.length,
        overdueVillas: overdueBills.length,
      },
      monthWise: monthWiseData,
      villaWise: villaWise.filter(v => v.pendingMonths > 0),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance/pending - Pending payments list
router.get("/pending", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const pendingBills = await prisma.maintenance.findMany({
      where: {
        societyId,
        status: "PENDING",
      },
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
    });

    return res.json({ pending: pendingBills });
  } catch (error) {
    next(error);
  }
});

// GET /api/maintenance/overdue - Overdue payments list
router.get("/overdue", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const overdueBills = await prisma.maintenance.findMany({
      where: {
        societyId,
        status: "OVERDUE",
      },
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
    });

    return res.json({ overdue: overdueBills });
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

    // Create bills for all villas
    const bills = await Promise.all(
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

    const payments = await prisma.maintenancePayment.findMany({
      where: {
        villaId,
        societyId,
      },
      include: {
        bankAccount: {
          select: {
            bankName: true,
          },
        },
      },
      orderBy: { paymentDate: "desc" },
    });

    const pending = await prisma.maintenance.findMany({
      where: {
        villaId,
        societyId,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      orderBy: { dueDate: "asc" },
    });

    return res.json({ payments, pending });
  } catch (error) {
    next(error);
  }
});

export default router;
