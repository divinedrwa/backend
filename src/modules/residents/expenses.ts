import { Router } from "express";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

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
    };

    if (typeof categoryId === "string" && categoryId) {
      where.categoryId = categoryId;
    }
    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);

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
// GET /residents/society-expenses/:id
// Single expense with attachments and category.
// ==========================================
router.get("/society-expenses/:id", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    const expense = await prisma.expense.findFirst({
      where: { id, societyId, status: "APPROVED" },
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
      return res.status(404).json({ error: "Expense not found" });
    }

    res.json(expense);
  } catch (error) {
    next(error);
  }
});

export default router;
