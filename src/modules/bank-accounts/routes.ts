import { Router } from "express";
import { z } from "zod";
import { UserRole } from "@prisma/client";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { auditFromRequest } from "../../services/audit.service";

const router = Router();

function maskAccountNumber(acct: string): string {
  return acct.length > 4 ? "****" + acct.slice(-4) : "****";
}

// Validation schemas
const createBankAccountSchema = z.object({
  bankName: z.string().trim().min(1),
  accountNumber: z.string().trim().min(1),
  ifscCode: z.string().trim().min(1),
  accountHolderName: z.string().trim().min(1),
  accountType: z.string().trim().min(1),
  isActive: z.boolean().optional(),
});

const updateBankAccountSchema = z.object({
  bankName: z.string().trim().min(1).optional(),
  ifscCode: z.string().trim().min(1).optional(),
  accountHolderName: z.string().trim().min(1).optional(),
  accountType: z.string().trim().optional(),
  isActive: z.boolean().optional(),
});

// GET /api/bank-accounts - List all bank accounts
router.get("/", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const pagination = getPagination(req);
    const where = { societyId };
    const [accounts, total] = await Promise.all([
      prisma.bankAccount.findMany({
        where,
        include: {
          _count: {
            select: {
              maintenancePayments: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.bankAccount.count({ where }),
    ]);

    const masked = accounts.map((a) => ({ ...a, accountNumber: maskAccountNumber(a.accountNumber) }));
    return res.json({ accounts: masked, ...paginationMeta(total, accounts.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// GET /api/bank-accounts/:id - Get bank account details
router.get("/:id", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
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
        accountNumber: maskAccountNumber(account.accountNumber),
        totalReceived,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/bank-accounts - Create new bank account
router.post("/", requireAuth, requireRole(UserRole.ADMIN), validateBody(createBankAccountSchema), async (req, res, next) => {
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
router.patch("/:id", requireAuth, requireRole(UserRole.ADMIN), validateBody(updateBankAccountSchema), async (req, res, next) => {
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

    const updatedAccount = await prisma.bankAccount.findFirst({
      where: { id, societyId },
    });

    return res.json({ account: updatedAccount });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/bank-accounts/:id - Delete bank account
router.delete("/:id", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    // Check if account has payments
    const paymentsCount = await prisma.maintenancePayment.count({
      where: { bankAccountId: id, societyId },
    });

    if (paymentsCount > 0) {
      return res.status(400).json({
        message: `Cannot delete account with ${paymentsCount} payment records. Mark as inactive instead.`,
      });
    }

    await prisma.bankAccount.deleteMany({
      where: { id, societyId },
    });

    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "BANK_ACCOUNT_DELETED",
      entityType: "BankAccount",
      entityId: id,
    });

    return res.json({ message: "Bank account deleted successfully" });
  } catch (error) {
    next(error);
  }
});

export default router;
