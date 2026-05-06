import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

// Validation schemas
const createBankAccountSchema = z.object({
  bankName: z.string().min(1),
  accountNumber: z.string().min(1),
  ifscCode: z.string().min(1),
  accountHolderName: z.string().min(1),
  accountType: z.string().min(1),
  isActive: z.boolean().optional(),
});

const updateBankAccountSchema = z.object({
  bankName: z.string().min(1).optional(),
  ifscCode: z.string().min(1).optional(),
  accountHolderName: z.string().min(1).optional(),
  accountType: z.string().optional(),
  isActive: z.boolean().optional(),
});

// GET /api/bank-accounts - List all bank accounts
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const accounts = await prisma.bankAccount.findMany({
      where: { societyId },
      include: {
        _count: {
          select: {
            maintenancePayments: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ accounts });
  } catch (error) {
    next(error);
  }
});

// GET /api/bank-accounts/:id - Get bank account details
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const account = await prisma.bankAccount.findFirst({
      where: { id, societyId },
      include: {
        maintenancePayments: {
          include: {
            villa: {
              select: {
                villaNumber: true,
                ownerName: true,
              },
            },
          },
          orderBy: { paymentDate: "desc" },
          take: 50,
        },
      },
    });

    if (!account) {
      return res.status(404).json({ message: "Bank account not found" });
    }

    // Calculate total received
    const totalReceived = account.maintenancePayments.reduce(
      (sum, payment) => sum + Number(payment.amount),
      0
    );

    return res.json({
      account: {
        ...account,
        totalReceived,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/bank-accounts - Create new bank account
router.post("/", requireAuth, validateBody(createBankAccountSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const account = await prisma.bankAccount.create({
      data: {
        societyId,
        ...req.body,
      },
    });

    return res.status(201).json({ account });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/bank-accounts/:id - Update bank account
router.patch("/:id", requireAuth, validateBody(updateBankAccountSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const account = await prisma.bankAccount.updateMany({
      where: { id, societyId },
      data: req.body,
    });

    if (account.count === 0) {
      return res.status(404).json({ message: "Bank account not found" });
    }

    const updatedAccount = await prisma.bankAccount.findUnique({
      where: { id },
    });

    return res.json({ account: updatedAccount });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/bank-accounts/:id - Delete bank account
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    // Check if account has payments
    const paymentsCount = await prisma.maintenancePayment.count({
      where: { bankAccountId: id },
    });

    if (paymentsCount > 0) {
      return res.status(400).json({
        message: `Cannot delete account with ${paymentsCount} payment records. Mark as inactive instead.`,
      });
    }

    await prisma.bankAccount.deleteMany({
      where: { id, societyId },
    });

    return res.json({ message: "Bank account deleted successfully" });
  } catch (error) {
    next(error);
  }
});

export default router;
