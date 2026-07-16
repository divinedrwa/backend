import { Router } from "express";
import { resolveExpenseAttachmentUrl } from "../../services/cloudinaryExpenseAttachment";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import {
  buildExpenseBillingCycleGroups,
} from "./expense-cycle-groups";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN, UserRole.RESIDENT));

// ==========================================
// GET /residents/society-expenses/categories
// Active expense categories for filter chips.
// Registered BEFORE /:id to avoid path collision.
// ==========================================
router.get("/society-expenses/categories", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;

    const categories = await prisma.expenseCategory.findMany({
      where: { societyId, isActive: true },
      select: {
        id: true,
        name: true,
        icon: true,
        color: true,
        type: true,
      },
      orderBy: { name: "asc" },
    });

    res.json({ categories });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET /residents/society-expenses
// Paginated list of APPROVED expenses with filters.
// ==========================================
router.get("/society-expenses", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { categoryId, month, year, search, limit, offset } = req.query;

    const take = Math.min(Math.max(parseInt(limit as string) || 20, 1), 100);
    const skip = Math.max(parseInt(offset as string) || 0, 0);

    const where: Prisma.ExpenseWhereInput = {
      societyId,
      status: "APPROVED",
      deletedAt: null,
    };

    if (typeof categoryId === "string" && categoryId) {
      where.categoryId = categoryId;
    }

    const monthNum =
      typeof month === "string" && month ? parseInt(month, 10) : NaN;
    const yearNum = typeof year === "string" && year ? parseInt(year, 10) : NaN;
    if (!Number.isNaN(monthNum) && !Number.isNaN(yearNum)) {
      const periodStart = new Date(Date.UTC(yearNum, monthNum - 1, 1, 0, 0, 0, 0));
      const periodEnd = new Date(Date.UTC(yearNum, monthNum, 0, 23, 59, 59, 999));
      where.AND = [
        {
          OR: [
            { month: monthNum, year: yearNum },
            {
              AND: [
                { month: null },
                { paymentDate: { gte: periodStart, lte: periodEnd } },
              ],
            },
          ],
        },
      ];
    } else {
      if (!Number.isNaN(monthNum)) where.month = monthNum;
      if (!Number.isNaN(yearNum)) where.year = yearNum;
    }

    if (typeof search === "string" && search.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: "insensitive" } },
        { description: { contains: search.trim(), mode: "insensitive" } },
        { paidTo: { contains: search.trim(), mode: "insensitive" } },
      ];
    }

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        select: {
          id: true,
          title: true,
          amount: true,
          netAmount: true,
          paymentDate: true,
          paymentMode: true,
          paidTo: true,
          month: true,
          year: true,
          status: true,
          createdAt: true,
          category: {
            select: {
              id: true,
              name: true,
              icon: true,
              color: true,
              type: true,
            },
          },
          _count: {
            select: { attachments: true },
          },
        },
        orderBy: { paymentDate: "desc" },
        take,
        skip,
      }),
      prisma.expense.count({ where }),
    ]);

    const mapped = expenses.map((e) => ({
      ...e,
      attachmentCount: e._count.attachments,
      _count: undefined,
    }));

    res.json({
      expenses: mapped,
      total,
      hasMore: skip + take < total,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET /residents/society-expenses/grouped-by-billing-cycle
// Approved expenses grouped by billing cycle (includes draft/upcoming).
// Registered BEFORE /:id to avoid path collision.
// ==========================================
router.get("/society-expenses/grouped-by-billing-cycle", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { categoryId, month, year, search } = req.query;

    const where: Prisma.ExpenseWhereInput = {
      societyId,
      status: "APPROVED",
      deletedAt: null,
    };

    if (typeof categoryId === "string" && categoryId) {
      where.categoryId = categoryId;
    }

    const monthNum =
      typeof month === "string" && month ? parseInt(month, 10) : NaN;
    const yearNum = typeof year === "string" && year ? parseInt(year, 10) : NaN;
    const filterCycleKey =
      !Number.isNaN(monthNum) && !Number.isNaN(yearNum)
        ? `${yearNum}-${String(monthNum).padStart(2, "0")}`
        : null;

    if (typeof search === "string" && search.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: "insensitive" } },
        { description: { contains: search.trim(), mode: "insensitive" } },
        { paidTo: { contains: search.trim(), mode: "insensitive" } },
      ];
    }

    const [expenses, cycles] = await Promise.all([
      prisma.expense.findMany({
        where,
        select: {
          id: true,
          title: true,
          amount: true,
          netAmount: true,
          paymentDate: true,
          paymentMode: true,
          paidTo: true,
          month: true,
          year: true,
          status: true,
          createdAt: true,
          category: {
            select: {
              id: true,
              name: true,
              icon: true,
              color: true,
              type: true,
            },
          },
          _count: {
            select: { attachments: true },
          },
        },
        orderBy: { paymentDate: "desc" },
        take: 500,
      }),
      prisma.billingCycle.findMany({
        where: { societyId },
        select: {
          id: true,
          cycleKey: true,
          title: true,
          publishedAt: true,
          paymentStartDate: true,
          paymentEndDate: true,
        },
      }),
    ]);

    const expenseRows = expenses.map((e) => ({
      ...e,
      attachmentCount: e._count.attachments,
      _count: undefined,
    }));

    const groups = buildExpenseBillingCycleGroups({
      expenses: expenseRows,
      cycles,
      filterCycleKey,
    });

    const totalExpenses = groups.reduce((sum, g) => sum + g.expenseCount, 0);

    res.json({
      groups: groups.map((g) => ({
        ...g,
        expenses: g.expenses.map((e) => ({
          ...e,
          amount: Number(e.amount),
          netAmount: Number(e.netAmount),
        })),
      })),
      totalExpenses,
      totalGroups: groups.length,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET /residents/society-expenses/:id
// Single expense with attachments and category.
// ==========================================
router.get("/society-expenses/:id", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    const expense = await prisma.expense.findFirst({
      where: { id, societyId, status: "APPROVED", deletedAt: null },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            color: true,
            type: true,
          },
        },
        attachments: {
          select: {
            id: true,
            fileName: true,
            fileUrl: true,
            fileType: true,
            fileSize: true,
            uploadedAt: true,
          },
          orderBy: { uploadedAt: "asc" },
        },
      },
    });

    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    res.json({
      ...expense,
      attachments: expense.attachments.map((a) => ({
        ...a,
        fileUrl: resolveExpenseAttachmentUrl(a.fileUrl),
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
